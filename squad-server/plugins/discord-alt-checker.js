import { QueryTypes } from 'sequelize';
import Logger from 'core/logger';
import DiscordBasePlugin from './discord-base-plugin.js';

export default class DiscordAltChecker extends DiscordBasePlugin {
  static get description() {
    return (
      'The <code>DiscordAltChecker</code> plugin detects potential alt accounts by matching a joining ' +
      "player's IP against historical IPs stored by DBLog. " +
      'Sends a pinged alert to Discord and warns in-game admins when the shared IP belongs to a player ' +
      'currently online. Sends a quiet log when the match is an offline player only. ' +
      'Admins can also manually look up any player via <code>!alt &lt;name|steamID|eosID|IP&gt;</code> ' +
      'in admin chat or in the configured Discord command channel.'
    );
  }

  static get defaultEnabled() {
    return false;
  }

  static get optionsSpecification() {
    return {
      ...DiscordBasePlugin.optionsSpecification,
      alertChannelID: {
        required: true,
        description: 'Channel ID for active in-game IP collision alerts (with role pings).',
        default: '',
        example: '667741905228136459'
      },
      logChannelID: {
        required: true,
        description: 'Channel ID for historical offline IP match logs (no pings).',
        default: '',
        example: '667741905228136460'
      },
      commandChannelID: {
        required: true,
        description:
          'Channel ID where admins can run !alt lookups. Bot listens and replies in this channel.',
        default: '',
        example: '667741905228136461'
      },
      command: {
        required: false,
        description: 'The in-game and Discord command prefix (without !).',
        default: 'alt'
      },
      pingGroups: {
        required: false,
        description: 'Array of Discord role IDs to ping when an active collision is detected.',
        default: [],
        example: ['500455137626554379']
      },
      pingHere: {
        required: false,
        description: 'Whether to also include @here in alert pings.',
        default: false
      },
      database: {
        required: true,
        connector: 'sequelize',
        description:
          'Sequelize connector. Requires DBLog to be running so DBLog_Players is populated.',
        default: 'sqlite'
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);
    this.alertChannel = null;
    this.logChannel = null;
    this.commandChannel = null;
    this.alertedPairs = new Set();
    this.logCatch = (label) => (error) => this.verbose(1, `${label}: ${error.message}`);
    this.onPlayerConnected = this.onPlayerConnected.bind(this);
    this.onPlayerDisconnected = this.onPlayerDisconnected.bind(this);
    this.onChatCommand = this.onChatCommand.bind(this);
    this.onDiscordMessage = this.onDiscordMessage.bind(this);
  }

  async prepareToMount() {
    // Don't call super — DiscordBasePlugin.prepareToMount requires channelID which this plugin doesn't use.
    for (const [prop, id] of [
      ['alertChannel', this.options.alertChannelID],
      ['logChannel', this.options.logChannelID],
      ['commandChannel', this.options.commandChannelID]
    ]) {
      try {
        this[prop] = await this.options.discordClient.channels.fetch(id);
      } catch (error) {
        this.verbose(1, `Could not fetch channel ${id}: ${error.message}`);
      }
    }
  }

  async mount() {
    this.alertedPairs = new Set();
    this.server.on('PLAYER_CONNECTED', this.onPlayerConnected);
    this.server.on('PLAYER_DISCONNECTED', this.onPlayerDisconnected);
    this.server.on(`CHAT_COMMAND:${this.options.command}`, this.onChatCommand);
    this.options.discordClient.on('messageCreate', this.onDiscordMessage);
  }

  async unmount() {
    this.server.removeEventListener('PLAYER_CONNECTED', this.onPlayerConnected);
    this.server.removeEventListener('PLAYER_DISCONNECTED', this.onPlayerDisconnected);
    this.server.removeEventListener(`CHAT_COMMAND:${this.options.command}`, this.onChatCommand);
    this.options.discordClient.off('messageCreate', this.onDiscordMessage);
    this.alertedPairs.clear();
  }

  onPlayerDisconnected(info) {
    const eosID = info.player?.eosID;
    if (!eosID) return;
    const staleKeys = [...this.alertedPairs].filter((key) => pairKeyContains(key, eosID));
    for (const key of staleKeys) this.alertedPairs.delete(key);
  }

  async onPlayerConnected(info) {
    const { ip, player } = info;
    if (!ip || !player) return;
    const { eosID, steamID, name } = player;
    if (!eosID) return;

    let matches;
    try {
      matches = await this.options.database.query(
        'SELECT eosID, steamID, lastName FROM DBLog_Players WHERE lastIP = ? AND eosID != ?',
        { replacements: [ip, eosID], type: QueryTypes.SELECT }
      );
    } catch (error) {
      this.verbose(1, `DB query failed: ${error.message}`);
      return;
    }

    if (!matches.length) return;

    const connectingPlayer = { eosID, steamID, name };
    const onlinePlayerMap = this.getOnlinePlayerMap();

    const enrichedMatches = await Promise.all(
      matches.map(async (match) => {
        const [coStats, killStats] = await Promise.all([
          this.getCoOccurrence(steamID, match.steamID),
          this.getKillStats(steamID, match.steamID)
        ]);
        return { ...match, coStats, killStats };
      })
    );

    const onlineMatches = enrichedMatches.filter((match) => onlinePlayerMap.has(match.eosID));
    const offlineMatches = enrichedMatches.filter((match) => !onlinePlayerMap.has(match.eosID));

    if (onlineMatches.length > 0) {
      const pairKey = makePairKey([eosID, ...onlineMatches.map((match) => match.eosID)]);
      if (!this.alertedPairs.has(pairKey)) {
        this.alertedPairs.add(pairKey);
        await Promise.all([
          this.sendAlert(connectingPlayer, onlineMatches, ip, onlinePlayerMap).catch(
            this.logCatch('Discord alert failed')
          ),
          this.warnAdmins(connectingPlayer, onlineMatches, onlinePlayerMap).catch(
            this.logCatch('Admin warning failed')
          )
        ]);
      }
    }

    if (offlineMatches.length > 0) {
      await this.sendLog(connectingPlayer, offlineMatches, ip).catch(
        this.logCatch('Discord log failed')
      );
    }
  }

  async onChatCommand(info) {
    if (info.chat !== 'ChatAdmin') return;

    const adminEosIDs = this.server.getAdminsWithPermission('canseeadminchat', 'eosID');
    if (!adminEosIDs.includes(info.player.eosID)) return;

    const query = info.message.trim();
    if (!query) {
      await this.server.rcon.warn(
        info.player.eosID,
        `[Alt] Usage: !${this.options.command} <name|steamID|eosID|IP> [name|steamID|eosID]`
      );
      return;
    }

    const tokens = parseTokens(query);
    let result;
    try {
      result =
        tokens.length >= 2
          ? await this.compareQuery(tokens[0], tokens[1])
          : await this.lookupQuery(tokens[0]);
    } catch (error) {
      this.verbose(1, `Lookup query failed: ${error.message}`);
      await this.server.rcon.warn(info.player.eosID, '[Alt] DB error — lookup failed.');
      return;
    }

    await this.replyInGame(info.player.eosID, result).catch(this.logCatch('In-game reply failed'));
  }

  async onDiscordMessage(message) {
    if (message.author.bot) return;
    if (!this.commandChannel) return;
    if (message.channelId !== this.options.commandChannelID) return;

    const commandStr = `!${this.options.command}`;
    if (message.content !== commandStr && !message.content.startsWith(`${commandStr} `)) return;

    const query = message.content.slice(commandStr.length).trim();
    if (!query) {
      await message.reply(
        `Usage: \`!${this.options.command} <name|steamID|eosID|IP> [name|steamID|eosID]\``
      );
      return;
    }

    const tokens = parseTokens(query);
    let result;
    try {
      result =
        tokens.length >= 2
          ? await this.compareQuery(tokens[0], tokens[1])
          : await this.lookupQuery(tokens[0]);
    } catch (error) {
      this.verbose(1, `Discord lookup failed: ${error.message}`);
      await message.reply('DB error — lookup failed.');
      return;
    }

    await this.replyDiscord(message, result).catch(this.logCatch('Discord reply failed'));
  }

  async resolvePlayer(query) {
    const isSteamID = /^7656\d{13}$/.test(query);
    const isEosID = /^[0-9a-f]{32}$/i.test(query);

    let candidates;
    if (isSteamID) {
      candidates = await this.options.database.query(
        'SELECT eosID, steamID, lastName, lastIP FROM DBLog_Players WHERE steamID = ?',
        { replacements: [query], type: QueryTypes.SELECT }
      );
    } else if (isEosID) {
      candidates = await this.options.database.query(
        'SELECT eosID, steamID, lastName, lastIP FROM DBLog_Players WHERE eosID = ?',
        { replacements: [query], type: QueryTypes.SELECT }
      );
    } else {
      const escaped = query.replace(/[%_]/g, '\\$&');
      candidates = await this.options.database.query(
        "SELECT eosID, steamID, lastName, lastIP FROM DBLog_Players WHERE lastName LIKE ? ESCAPE '\\' LIMIT 6",
        { replacements: [`%${escaped}%`], type: QueryTypes.SELECT }
      );
    }

    if (!candidates.length) return { type: 'not_found' };
    if (candidates.length > 1) return { type: 'ambiguous', candidates };
    return { type: 'found', player: candidates[0] };
  }

  async lookupQuery(query) {
    const isIP = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(query);
    if (isIP) {
      const players = await this.options.database.query(
        'SELECT eosID, steamID, lastName FROM DBLog_Players WHERE lastIP = ?',
        { replacements: [query], type: QueryTypes.SELECT }
      );
      return { type: 'ip', ip: query, players };
    }

    const resolved = await this.resolvePlayer(query);
    if (resolved.type !== 'found') return resolved;

    const target = resolved.player;
    if (!target.lastIP) return { type: 'player', target, ipMates: [] };

    const ipMates = await this.options.database.query(
      'SELECT eosID, steamID, lastName FROM DBLog_Players WHERE lastIP = ? AND eosID != ?',
      { replacements: [target.lastIP, target.eosID], type: QueryTypes.SELECT }
    );
    return { type: 'player', target, ipMates };
  }

  async compareQuery(queryA, queryB) {
    const [resolvedA, resolvedB] = await Promise.all([
      this.resolvePlayer(queryA),
      this.resolvePlayer(queryB)
    ]);
    if (resolvedA.type !== 'found')
      return { type: 'compare_error', side: 'first', result: resolvedA };
    if (resolvedB.type !== 'found')
      return { type: 'compare_error', side: 'second', result: resolvedB };
    const [coStats, killStats] = await Promise.all([
      this.getCoOccurrence(resolvedA.player.steamID, resolvedB.player.steamID),
      this.getKillStats(resolvedA.player.steamID, resolvedB.player.steamID)
    ]);
    return {
      type: 'compare',
      playerA: resolvedA.player,
      playerB: resolvedB.player,
      coStats,
      killStats
    };
  }

  async replyInGame(adminEosID, result) {
    const warn = (msg) => this.server.rcon.warn(adminEosID, msg);
    const onlinePlayerMap = this.getOnlinePlayerMap();

    if (result.type === 'compare_error') {
      const label = result.side === 'first' ? 'First' : 'Second';
      if (result.result.type === 'not_found') {
        await warn(`[Alt] ${label} player not found.`);
      } else {
        const names = result.result.candidates
          .map((candidate) => candidate.lastName ?? '?')
          .join(', ');
        await warn(`[Alt] ${label} player — multiple matches: ${names.slice(0, 70)}`);
      }
      return;
    }

    if (result.type === 'compare') {
      const { playerA, playerB, coStats, killStats } = result;
      const nameA = playerA.lastName ?? '?';
      const nameB = playerB.lastName ?? '?';
      if (!coStats && !killStats) {
        await warn(`[Alt] ${nameA} ↔ ${nameB}: no shared history`);
        return;
      }
      const parts = [];
      if (coStats) {
        const oppPct = Math.round((coStats.oppositeTeamRounds / coStats.totalRounds) * 100);
        parts.push(`${coStats.totalRounds} rounds, ${coStats.oppositeTeamRounds} opp (${oppPct}%)`);
      }
      if (killStats) {
        parts.push(
          `kills ${killStats.aKilledB ?? 0}→${killStats.bKilledA ?? 0}, wounds ${
            killStats.aWoundedB ?? 0
          }→${killStats.bWoundedA ?? 0}`
        );
      }
      await warn(`[Alt] ${nameA} ↔ ${nameB}: ${parts.join(' | ')}`);
      return;
    }

    if (result.type === 'not_found') {
      await warn('[Alt] No player found for that query.');
      return;
    }

    if (result.type === 'ambiguous') {
      const names = result.candidates.map((candidate) => candidate.lastName ?? '?').join(', ');
      await warn(`[Alt] Multiple matches: ${names.slice(0, 90)}`);
      return;
    }

    if (result.type === 'ip') {
      if (!result.players.length) {
        await warn(`[Alt] No records for IP ${result.ip}`);
        return;
      }
      await warn(`[Alt] IP lookup — ${result.players.length} player(s):`);
      for (const player of result.players) {
        await warn(
          `[Alt] ${player.lastName ?? '?'} [${gameStatusLabel(onlinePlayerMap.get(player.eosID))}]`
        );
      }
      return;
    }

    if (result.type === 'player') {
      if (!result.ipMates.length) {
        await warn(
          `[Alt] ${result.target.lastName ?? '?'} [${gameStatusLabel(
            onlinePlayerMap.get(result.target.eosID)
          )}] — no shared IPs found`
        );
        return;
      }
      await warn(
        `[Alt] ${result.target.lastName ?? '?'} [${gameStatusLabel(
          onlinePlayerMap.get(result.target.eosID)
        )}] shares IP with ${result.ipMates.length}:`
      );
      for (const player of result.ipMates) {
        await warn(
          `[Alt] ${player.lastName ?? '?'} [${gameStatusLabel(onlinePlayerMap.get(player.eosID))}]`
        );
      }
    }
  }

  async replyDiscord(message, result) {
    if (result.type === 'compare' || result.type === 'compare_error') {
      await this.replyCompareDiscord(message, result);
      return;
    }

    const onlinePlayerMap = this.getOnlinePlayerMap();

    if (result.type === 'not_found') {
      await message.reply({
        embeds: [{ title: 'Alt Lookup', description: 'No player found.', color: 0x888888 }]
      });
      return;
    }

    if (result.type === 'ambiguous') {
      const fields = result.candidates.map((candidate) => ({
        name: candidate.lastName ?? 'Unknown',
        value: buildPlayerLine(candidate),
        inline: false
      }));
      await message.reply({
        embeds: [{ title: 'Multiple matches — be more specific', color: 0xffa500, fields }]
      });
      return;
    }

    if (result.type === 'ip') {
      const fields = result.players.length
        ? await Promise.all(
            result.players.map(async (player) => ({
              name: `${player.lastName ?? 'Unknown'} — ${discordStatusLabel(
                onlinePlayerMap.get(player.eosID)
              )}`,
              value: await this.withLastActive(player, onlinePlayerMap, buildPlayerLine(player)),
              inline: false
            }))
          )
        : [{ name: 'No records', value: 'No players found with that IP.', inline: false }];
      await message.reply({
        embeds: [{ title: `IP Lookup: ||${result.ip}||`, color: 0x5865f2, fields }]
      });
      return;
    }

    if (result.type === 'player') {
      const [targetLastActive, mateResults] = await Promise.all([
        this.withLastActive(result.target, onlinePlayerMap, buildPlayerLine(result.target)),
        Promise.all(
          result.ipMates.map(async (player) => {
            const [value, coStats, killStats] = await Promise.all([
              this.withLastActive(player, onlinePlayerMap, buildPlayerLine(player)),
              this.getCoOccurrence(result.target.steamID, player.steamID),
              this.getKillStats(result.target.steamID, player.steamID)
            ]);
            return { mate: player, value, coStats, killStats };
          })
        )
      ]);

      const targetValue = `${targetLastActive}\nIP: ||${result.target.lastIP ?? 'Unknown'}||`;
      const fields = [
        {
          name: `${result.target.lastName ?? 'Unknown'} — ${discordStatusLabel(
            onlinePlayerMap.get(result.target.eosID)
          )}`,
          value: targetValue,
          inline: false
        },
        ...mateResults.map(({ mate, value }) => ({
          name: `Shares IP: ${mate.lastName ?? 'Unknown'} — ${discordStatusLabel(
            onlinePlayerMap.get(mate.eosID)
          )}`,
          value,
          inline: false
        }))
      ];

      const embeds = [
        makeEmbed(
          `Alt Lookup: ${result.target.lastName ?? 'Unknown'}`,
          result.ipMates.length > 0 ? 0xff4444 : 0x00aa00,
          fields
        )
      ];

      if (result.ipMates.length > 0) {
        const coFields = mateResults.map(({ mate, coStats, killStats }) => ({
          name: `${result.target.lastName ?? 'Unknown'} ↔ ${mate.lastName ?? 'Unknown'}`,
          value: `${formatCoStats(coStats)}\n${formatKillStats(
            killStats,
            result.target.lastName,
            mate.lastName
          )}`,
          inline: false
        }));
        embeds.push(makeEmbed('Behavioral Analysis', 0x5865f2, coFields));
      }

      await message.reply({ embeds });
    }
  }

  async replyCompareDiscord(message, result) {
    if (result.type === 'compare_error') {
      const label = result.side === 'first' ? 'First' : 'Second';
      if (result.result.type === 'not_found') {
        await message.reply({
          embeds: [
            { title: 'Player Compare', description: `${label} player not found.`, color: 0x888888 }
          ]
        });
      } else {
        const fields = result.result.candidates.map((candidate) => ({
          name: candidate.lastName ?? 'Unknown',
          value: buildPlayerLine(candidate),
          inline: false
        }));
        await message.reply({
          embeds: [{ title: `${label} player — be more specific`, color: 0xffa500, fields }]
        });
      }
      return;
    }

    const { playerA, playerB, coStats, killStats } = result;
    const onlinePlayerMap = this.getOnlinePlayerMap();
    const [valueA, valueB] = await Promise.all([
      this.withLastActive(playerA, onlinePlayerMap, buildPlayerLine(playerA)),
      this.withLastActive(playerB, onlinePlayerMap, buildPlayerLine(playerB))
    ]);
    const playerFields = [
      {
        name: `${playerA.lastName ?? 'Unknown'} — ${discordStatusLabel(
          onlinePlayerMap.get(playerA.eosID)
        )}`,
        value: valueA,
        inline: true
      },
      {
        name: `${playerB.lastName ?? 'Unknown'} — ${discordStatusLabel(
          onlinePlayerMap.get(playerB.eosID)
        )}`,
        value: valueB,
        inline: true
      }
    ];
    const behaviorField = {
      name: `${playerA.lastName ?? 'Unknown'} ↔ ${playerB.lastName ?? 'Unknown'}`,
      value: `${formatCoStats(coStats)}\n${formatKillStats(
        killStats,
        playerA.lastName,
        playerB.lastName
      )}`,
      inline: false
    };
    await message.reply({
      embeds: [
        makeEmbed(
          `Compare: ${playerA.lastName ?? 'Unknown'} ↔ ${playerB.lastName ?? 'Unknown'}`,
          0x5865f2,
          playerFields
        ),
        makeEmbed('Behavioral Analysis', 0x5865f2, [behaviorField])
      ]
    });
  }

  async sendAlert(connectingPlayer, onlineMatches, ip, onlinePlayerMap) {
    if (!this.alertChannel) return;

    const content =
      [
        ...(this.options.pingHere ? ['@here'] : []),
        ...this.options.pingGroups.map((id) => `<@&${id}>`)
      ].join(' ') || undefined;

    const fields = [
      {
        name: `Joining: ${connectingPlayer.name ?? 'Unknown'}`,
        value: buildPlayerLine(connectingPlayer),
        inline: false
      },
      ...onlineMatches.map((match) => {
        const player = onlinePlayerMap.get(match.eosID);
        const teamLabel = player?.teamID != null ? ` (Team ${player.teamID})` : '';
        return {
          name: `🟢 Online${teamLabel}: ${match.lastName ?? 'Unknown'}`,
          value: buildPlayerLine(match),
          inline: false
        };
      }),
      { name: 'Shared IP', value: `||${ip}||`, inline: true }
    ];

    const behaviorFields = onlineMatches
      .filter((match) => match.coStats || match.killStats)
      .map((match) => ({
        name: `${connectingPlayer.name ?? 'Unknown'} ↔ ${match.lastName ?? 'Unknown'}`,
        value: `${formatCoStats(match.coStats)}\n${formatKillStats(
          match.killStats,
          connectingPlayer.name,
          match.lastName
        )}`,
        inline: false
      }));

    const embeds = [
      makeEmbed('Possible Alt — Same IP Online', 0xff4444, fields),
      ...(behaviorFields.length ? [makeEmbed('Behavioral Analysis', 0x5865f2, behaviorFields)] : [])
    ];

    await this.alertChannel.send({ content, embeds });
    this.verbose(1, `Alert: ${connectingPlayer.eosID} shares IP with online player(s).`);
  }

  async sendLog(connectingPlayer, offlineMatches, ip) {
    if (!this.logChannel) return;

    const matchFields = await Promise.all(
      offlineMatches.map(async (match) => {
        const lastActive = await this.getLastActive(match.steamID);
        let value = buildPlayerLine(match);
        if (lastActive) value += `\n${lastActiveLine(lastActive)}`;
        return {
          name: `⚫ Offline: ${match.lastName ?? 'Unknown'}`,
          value,
          inline: false
        };
      })
    );

    const fields = [
      {
        name: `Joining: ${connectingPlayer.name ?? 'Unknown'}`,
        value: buildPlayerLine(connectingPlayer),
        inline: false
      },
      ...matchFields,
      { name: 'Shared IP', value: `||${ip}||`, inline: true }
    ];

    const behaviorFields = offlineMatches
      .filter((match) => match.coStats || match.killStats)
      .map((match) => ({
        name: `${connectingPlayer.name ?? 'Unknown'} ↔ ${match.lastName ?? 'Unknown'}`,
        value: `${formatCoStats(match.coStats)}\n${formatKillStats(
          match.killStats,
          connectingPlayer.name,
          match.lastName
        )}`,
        inline: false
      }));

    const embeds = [
      makeEmbed('IP Match — Offline Player(s)', 0xffff00, fields),
      ...(behaviorFields.length ? [makeEmbed('Behavioral Analysis', 0x5865f2, behaviorFields)] : [])
    ];

    await this.logChannel.send({ embeds });
    this.verbose(2, `Log: ${connectingPlayer.eosID} IP matches offline player(s).`);
  }

  async warnAdmins(connectingPlayer, onlineMatches, onlinePlayerMap) {
    const adminEosIDs = this.server.getAdminsWithPermission('canseeadminchat', 'eosID');
    if (!adminEosIDs.length) return;

    const matchNames = onlineMatches
      .map((match) => {
        const player = onlinePlayerMap.get(match.eosID);
        const teamSuffix = player?.teamID != null ? ` (Team ${player.teamID})` : '';
        return `${match.lastName ?? 'Unknown'}${teamSuffix}`;
      })
      .join(', ');

    for (const player of this.server.players) {
      if (!adminEosIDs.includes(player.eosID)) continue;
      await this.server.rcon.warn(
        player.eosID,
        `[Alt] ${
          connectingPlayer.name ?? connectingPlayer.eosID
        } (joining) & ${matchNames} share an IP — check Discord`
      );
    }
  }

  async withLastActive(player, onlinePlayerMap, value) {
    if (onlinePlayerMap.has(player.eosID)) return value;
    const lastActive = await this.getLastActive(player.steamID);
    return lastActive ? `${value}\n${lastActiveLine(lastActive)}` : value;
  }

  getOnlinePlayerMap() {
    return new Map(this.server.players.map((player) => [player.eosID, player]));
  }

  async getCoOccurrence(steamIDa, steamIDb) {
    if (!steamIDa || !steamIDb) return null;
    try {
      // Participation is derived from the combat tables (Deaths/Wounds/Revives), which carry
      // both a `match` id and a per-event teamID for every player who appears in a round.
      // PlayerSquadLists_PlayerTeamChanges is not used because it only logs mid-match team
      // switches. A player who stays on one side produces no rows there.
      const [row] = await this.options.database.query(
        `WITH participation AS (
          SELECT attacker AS steamID, match, attackerTeamID AS team, time FROM DBLog_Deaths  WHERE attacker IN (?, ?)
          UNION ALL
          SELECT victim   AS steamID, match, victimTeamID   AS team, time FROM DBLog_Deaths  WHERE victim   IN (?, ?)
          UNION ALL
          SELECT attacker AS steamID, match, attackerTeamID AS team, time FROM DBLog_Wounds  WHERE attacker IN (?, ?)
          UNION ALL
          SELECT victim   AS steamID, match, victimTeamID   AS team, time FROM DBLog_Wounds  WHERE victim   IN (?, ?)
          UNION ALL
          SELECT reviver  AS steamID, match, reviverTeamID  AS team, time FROM DBLog_Revives WHERE reviver  IN (?, ?)
          UNION ALL
          SELECT victim   AS steamID, match, victimTeamID   AS team, time FROM DBLog_Revives WHERE victim   IN (?, ?)
        ),
        latest_teams AS (
          SELECT steamID, match, team
          FROM (
            SELECT steamID, match, team,
                   ROW_NUMBER() OVER (PARTITION BY steamID, match ORDER BY time DESC) AS rn
            FROM participation WHERE match IS NOT NULL
          ) WHERE rn = 1
        )
        SELECT
          COUNT(*) AS totalRounds,
          SUM(CASE WHEN a.team != b.team THEN 1 ELSE 0 END) AS oppositeTeamRounds,
          SUM(CASE WHEN a.team = b.team THEN 1 ELSE 0 END) AS sameTeamRounds
        FROM latest_teams a JOIN latest_teams b ON a.match = b.match
        WHERE a.steamID = ? AND b.steamID = ?`,
        {
          replacements: [
            steamIDa,
            steamIDb,
            steamIDa,
            steamIDb,
            steamIDa,
            steamIDb,
            steamIDa,
            steamIDb,
            steamIDa,
            steamIDb,
            steamIDa,
            steamIDb,
            steamIDa,
            steamIDb
          ],
          type: QueryTypes.SELECT
        }
      );
      if (!row || row.totalRounds === 0) return null;
      return row;
    } catch {
      return null;
    }
  }

  async getKillStats(steamIDa, steamIDb) {
    if (!steamIDa || !steamIDb) return null;
    try {
      const [row] = await this.options.database.query(
        `SELECT
          SUM(CASE WHEN source = 'kill' AND attacker = ? THEN 1 ELSE 0 END) AS aKilledB,
          SUM(CASE WHEN source = 'kill' AND attacker = ? THEN 1 ELSE 0 END) AS bKilledA,
          SUM(CASE WHEN source = 'wound' AND attacker = ? THEN 1 ELSE 0 END) AS aWoundedB,
          SUM(CASE WHEN source = 'wound' AND attacker = ? THEN 1 ELSE 0 END) AS bWoundedA
        FROM (
          SELECT attacker, 'kill' AS source FROM DBLog_Deaths
            WHERE (attacker = ? AND victim = ?) OR (attacker = ? AND victim = ?)
          UNION ALL
          SELECT attacker, 'wound' AS source FROM DBLog_Wounds
            WHERE (attacker = ? AND victim = ?) OR (attacker = ? AND victim = ?)
        ) t`,
        {
          replacements: [
            steamIDa,
            steamIDb,
            steamIDa,
            steamIDb,
            steamIDa,
            steamIDb,
            steamIDb,
            steamIDa,
            steamIDa,
            steamIDb,
            steamIDb,
            steamIDa
          ],
          type: QueryTypes.SELECT
        }
      );
      if (!row || !(row.aKilledB || row.bKilledA || row.aWoundedB || row.bWoundedA)) {
        return null;
      }
      return row;
    } catch {
      return null;
    }
  }

  async getLastActive(steamID) {
    if (!steamID) return null;
    try {
      const [row] = await this.options.database.query(
        `SELECT MAX(time) AS lastActive FROM (
          SELECT time FROM DBLog_Deaths WHERE attacker = ? OR victim = ?
          UNION ALL
          SELECT time FROM DBLog_Wounds WHERE attacker = ? OR victim = ?
          UNION ALL
          SELECT time FROM DBLog_Revives WHERE reviver = ? OR victim = ?
        ) t`,
        {
          replacements: [steamID, steamID, steamID, steamID, steamID, steamID],
          type: QueryTypes.SELECT
        }
      );
      return row?.lastActive ?? null;
    } catch {
      return null;
    }
  }
}

function formatCoStats(coStats) {
  if (!coStats) return 'No shared rounds found.';
  const oppPct = Math.round((coStats.oppositeTeamRounds / coStats.totalRounds) * 100);
  return `Rounds together: **${coStats.totalRounds}**\nOpposite teams: **${coStats.oppositeTeamRounds}** (${oppPct}%)\nSame team: **${coStats.sameTeamRounds}**`;
}

function formatKillStats(killStats, nameA, nameB) {
  if (!killStats) return 'No combat history.';
  const displayNameA = nameA ?? 'Unknown';
  const displayNameB = nameB ?? 'Unknown';
  const aKilledB = killStats.aKilledB ?? 0;
  const bKilledA = killStats.bKilledA ?? 0;
  const aWoundedB = killStats.aWoundedB ?? 0;
  const bWoundedA = killStats.bWoundedA ?? 0;
  return `Kills: **${displayNameA}** ${aKilledB} → ${bKilledA} **${displayNameB}**\nWounds: **${displayNameA}** ${aWoundedB} → ${bWoundedA} **${displayNameB}**`;
}

function parseTokens(input) {
  const tokens = [];
  const regex = /"([^"]+)"|(\S+)/g;
  let match;
  while ((match = regex.exec(input)) !== null) tokens.push(match[1] ?? match[2]);
  return tokens;
}

function makeEmbed(title, color, fields) {
  const maxFields = 25;
  let displayFields = fields;
  if (fields.length > maxFields) {
    const overflow = fields.length - maxFields + 1;
    Logger.verbose(
      'DiscordAltChecker',
      1,
      `Embed "${title}" truncated: ${overflow} field(s) dropped`
    );
    displayFields = [
      ...fields.slice(0, maxFields - 1),
      { name: `… and ${overflow} more`, value: 'Too many results to display.', inline: false }
    ];
  }
  return {
    title,
    color,
    fields: displayFields,
    footer: { text: 'DiscordAltChecker' },
    timestamp: new Date().toISOString()
  };
}

function makePairKey(eosIDs) {
  return [...eosIDs].sort().join(':');
}

function pairKeyContains(key, eosID) {
  return key.split(':').includes(eosID);
}

function gameStatusLabel(player) {
  if (!player) return 'offline';
  return player.teamID != null ? `ONLINE T${player.teamID}` : 'ONLINE';
}

function discordStatusLabel(player) {
  if (!player) return '⚫ Offline';
  return player.teamID != null ? `🟢 Online (Team ${player.teamID})` : '🟢 Online';
}

function lastActiveLine(isoTime) {
  const ts = Math.floor(new Date(isoTime).getTime() / 1000);
  if (Number.isNaN(ts)) return 'Last active: Unknown';
  return `Last active: <t:${ts}:D> <t:${ts}:T>`;
}

function buildPlayerLine(player) {
  const lines = [];
  if (player.steamID) {
    lines.push(
      `[Steam](https://steamcommunity.com/profiles/${player.steamID}) | [BattleMetrics](https://www.battlemetrics.com/players?filter[search]=${player.steamID})`
    );
  }
  lines.push(`EOS: \`${player.eosID}\``);
  return lines.join('\n');
}
