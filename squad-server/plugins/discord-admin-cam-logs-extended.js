import DiscordAdminCamLogs from './discord-admin-cam-logs.js';

export default class DiscordAdminCamLogsExtended extends DiscordAdminCamLogs {
  static get description() {
    return (
      'The <code>DiscordAdminCamLogsExtended</code> plugin logs in-game admin camera usage to a Discord ' +
      'channel, counts entries per match, pings roles for short or frequent sessions, and warns in-game admins.'
    );
  }

  static get optionsSpecification() {
    return {
      ...super.optionsSpecification,
      useEmbeds: {
        required: false,
        description: 'Whether to use Discord embeds for messages or plain text.',
        default: true
      },
      notifyRoles: {
        required: false,
        description: 'Array of Discord role IDs to ping if admin cam time is below threshold.',
        default: [],
        example: ['667741905228136459', '667741905228136460']
      },
      notifyHere: {
        required: false,
        description: 'Whether to ping @here if admin cam time is below threshold.',
        default: false
      },
      notifyThreshold: {
        required: false,
        description:
          'Time threshold in seconds. If an admin cam session is shorter, notifications are sent. Not applied on seeding layers.',
        default: 120
      },
      notifyEntryCountThreshold: {
        required: false,
        description:
          'Entry count threshold. If an admin enters admin cam this many times in one match, notifications are sent.',
        default: 5
      },
      warnInGameAdmins: {
        required: false,
        description: 'Warn in game admins when an admin enters or leaves admin cam.',
        default: true
      },
      removePlayerFromSquad: {
        required: false,
        description: 'Remove the player from their squad when they enter admin cam.',
        default: false
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.adminCamCounts = {};

    this.onNewGame = this.onNewGame.bind(this);
  }

  async mount() {
    await super.mount();
    this.server.on('NEW_GAME', this.onNewGame);
  }

  async unmount() {
    // DiscordAdminCamLogs.unmount calls removeEventListener, which EventEmitter does not provide.
    this.server.removeListener('POSSESSED_ADMIN_CAMERA', this.onEntry);
    this.server.removeListener('UNPOSSESSED_ADMIN_CAMERA', this.onExit);
    this.server.removeListener('NEW_GAME', this.onNewGame);
  }

  async onNewGame() {
    this.verbose(1, 'New game detected. Resetting admin cam counters.');
    this.adminCamCounts = {};
  }

  async onEntry(info) {
    const { player } = info;
    this.adminsInCam[player.steamID] = { enteredAt: new Date(), player };
    this.adminCamCounts[player.steamID] = (this.adminCamCounts[player.steamID] || 0) + 1;

    const entryCount = this.adminCamCounts[player.steamID];
    this.verbose(1, `Admin ${player.name} has entered admin cam ${entryCount} time(s) this match.`);

    let notificationString = '';
    if (entryCount >= this.options.notifyEntryCountThreshold) {
      notificationString = this.buildPings();
      if (notificationString) {
        notificationString += `Admin has entered admin cam ${entryCount} times this match! `;
      }
    }

    if (this.options.useEmbeds) {
      await this.sendDiscordMessage({
        content: notificationString.trim(),
        embed: {
          title: `Admin Entered Admin Camera`,
          color: this.options.color,
          fields: [
            ...this.buildPlayerFields(player),
            { name: 'Entry Count', value: this.formatEntryCount(entryCount), inline: true }
          ],
          timestamp: info.time.toISOString()
        }
      });
    } else {
      await this.sendDiscordMessage({
        content:
          `🔍 Admin Entered Camera: ${this.formatPlainPlayer(player)} at ${this.formatTime(
            info.time
          )}` + ` - Entry #${entryCount} this match${this.formatSpoiler(notificationString)}`
      });
    }

    await this.warnInGameAdmins(info, 'entered');
    await this.server.rcon.warn(
      player.steamID,
      `WARNING: Please state your intention in admin chat for using admin cam.`
    );

    this.verbose(1, `Admin has entered admin cam: ${player.name}`);

    // squadID is null for an admin who is not in a squad.
    if (this.options.removePlayerFromSquad && Number(player.squadID) > 0)
      await this.server.rcon.execute(`AdminRemovePlayerFromSquad ${player.steamID}`);
  }

  async onExit(info) {
    const { player } = info;
    const tracked = this.adminsInCam[player.steamID];

    // The tracked entry time is preferred. info.duration is 0 when SquadJS started while the
    // admin was already in admin camera.
    let durationMs;
    let calculationMethod;
    if (tracked?.enteredAt) {
      durationMs = Date.now() - tracked.enteredAt.getTime();
      calculationMethod = 'tracked';
      delete this.adminsInCam[player.steamID];
    } else {
      durationMs = info.duration;
      calculationMethod = 'fallback';
    }
    const durationSeconds = Math.round(durationMs / 1000);
    const potentialEdgeCase = calculationMethod === 'fallback' && durationSeconds === 0;
    const formattedDuration = this.formatDuration(durationSeconds);
    const entryCount = this.adminCamCounts[player.steamID] || 1;

    this.verbose(
      1,
      `Admin cam duration for ${player.name} calculated using ${calculationMethod} method: ` +
        `${formattedDuration}${potentialEdgeCase ? ' (potential edge case)' : ''}`
    );

    const isShortSession = durationSeconds > 0 && durationSeconds < this.options.notifyThreshold;
    const isSeeding = Boolean(this.server.currentLayer?.layerid?.toLowerCase().includes('seed'));
    const notificationString = isShortSession && !isSeeding ? this.buildPings() : '';

    if (this.options.useEmbeds) {
      await this.sendDiscordMessage({
        content: notificationString.trim(),
        embed: {
          title: `Admin Left Admin Camera`,
          color: this.options.color,
          fields: [
            ...this.buildPlayerFields(player),
            { name: 'Time in Admin Camera', value: formattedDuration, inline: true },
            { name: 'Entry Count', value: this.formatEntryCount(entryCount), inline: true }
          ],
          timestamp: info.time.toISOString()
        }
      });
    } else {
      await this.sendDiscordMessage({
        content:
          `📷 Admin Left Camera: ${this.formatPlainPlayer(player)} at ${this.formatTime(
            info.time
          )}` +
          ` - Duration: ${formattedDuration} - Entry #${entryCount} this match` +
          this.formatSpoiler(notificationString)
      });
    }

    await this.warnInGameAdmins(info, 'left');
    this.verbose(1, `Admin has left admin cam: ${player.name}`);
  }

  async warnInGameAdmins(info, state) {
    if (!this.options.warnInGameAdmins) return;

    await this.server.updatePlayerList();
    const admins = await this.server.getAdminsWithPermission('canseeadminchat');
    for (const player of this.server.players) {
      if (!admins.includes(player.steamID) || info.player.steamID === player.steamID) continue;
      await this.server.rcon.warn(player.steamID, `[${info.player.name}] ${state} admin camera.`);
    }
  }

  buildPings() {
    let pings = '';
    if (this.options.notifyRoles?.length > 0) {
      pings += this.options.notifyRoles.map((roleId) => `<@&${roleId}>`).join(' ') + ' ';
    }
    if (this.options.notifyHere) pings += '@here ';
    return pings;
  }

  buildPlayerFields(player) {
    return [
      { name: "Admin's Name", value: player.name, inline: true },
      {
        name: "Admin's SteamID",
        value: `[${player.steamID}](https://steamcommunity.com/profiles/${player.steamID})`,
        inline: true
      },
      { name: "Admin's EosID", value: player.eosID, inline: true }
    ];
  }

  formatPlainPlayer(player) {
    const profileUrl = `https://steamcommunity.com/profiles/${player.steamID}`;
    return `[\`${player.name}\`](<${profileUrl}>) (${player.steamID} [↗](<${profileUrl}>)) EOS: \`${player.eosID}\``;
  }

  formatTime(time) {
    return `<t:${Math.round(time.valueOf() / 1000)}:T>`;
  }

  formatSpoiler(notificationString) {
    return notificationString ? ` ||${notificationString}||` : '';
  }

  formatEntryCount(entryCount) {
    return `${entryCount} time${entryCount !== 1 ? 's' : ''} this match`;
  }

  formatDuration(durationSeconds) {
    const minutes = Math.floor(durationSeconds / 60);
    const seconds = durationSeconds % 60;
    return `${minutes} min${minutes !== 1 ? 's' : ''} ${seconds} sec${seconds !== 1 ? 's' : ''}`;
  }
}
