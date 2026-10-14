import DiscordBasePlugin from './discord-base-plugin.js';
import CommanderTracker from './commander-resign-alert/tracker.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export default class CommanderResignAlert extends DiscordBasePlugin {
  static get description() {
    return (
      'The <code>CommanderResignAlert</code> plugin alerts admins when a player takes commander and resigns ' +
      'shortly after, which starts the commander cooldown for the team. It posts the alert to a Discord channel ' +
      'and warns the in-game admins. A commander who disconnects or whose squad disbands is not reported.'
    );
  }

  static get defaultEnabled() {
    return false;
  }

  static get optionsSpecification() {
    return {
      ...DiscordBasePlugin.optionsSpecification,
      channelID: {
        required: true,
        description: 'The ID of the channel to post the alerts to.',
        default: '',
        example: '667741905228136459'
      },
      maxCommandSeconds: {
        required: false,
        description: 'A resign within this many seconds after taking command is reported.',
        default: 300
      },
      warnInGameAdmins: {
        required: false,
        description: 'Also warn in-game admins (players with the canseeadminchat permission).',
        default: true
      },
      pollInterval: {
        required: false,
        description:
          'Milliseconds between two checks of the squad and player lists. Each check sends ListSquads and ' +
          'ListPlayers.',
        default: 5000
      },
      commandSquadName: {
        required: false,
        description: 'The name the game gives the squad of the commander.',
        default: 'Command Squad'
      },
      color: {
        required: false,
        description: 'The color of the embed.',
        default: 16747520
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.poll = this.poll.bind(this);
    this.pollTimeout = null;
    this.mounted = false;
    this.tracker = new CommanderTracker(this.options.commandSquadName);
    // eosID -> times of earlier reported resigns, to show repeat offenders. Kept in memory only.
    this.resignHistory = new Map();
  }

  async mount() {
    this.mounted = true;
    this.pollTimeout = setTimeout(this.poll, this.options.pollInterval);
  }

  async unmount() {
    this.mounted = false;
    clearTimeout(this.pollTimeout);
  }

  async poll() {
    try {
      const [[squads], players] = await Promise.all([
        this.server.rcon.getSquads(),
        this.server.rcon.getListPlayers()
      ]);
      const resigns = this.tracker.update(squads, players, Date.now());
      for (const resign of resigns) {
        if (resign.heldMs > this.options.maxCommandSeconds * 1000) continue;
        await this.report(resign, players);
      }
    } catch (error) {
      this.verbose(1, `Failed to check the commander: ${error.message}`);
    }

    if (this.mounted) this.pollTimeout = setTimeout(this.poll, this.options.pollInterval);
  }

  async report(resign, players) {
    const { commander, squad } = resign;
    const earlierResigns = (this.resignHistory.get(commander.eosID) || []).filter(
      (time) => resign.endTime - time < DAY_MS
    );
    this.resignHistory.set(commander.eosID, [...earlierResigns, resign.endTime]);

    const heldText = formatDuration(resign.heldMs);
    this.verbose(
      1,
      `${commander.name} (team ${squad.teamID}) resigned commander after ${heldText}.`
    );

    if (this.options.warnInGameAdmins) {
      const warning =
        `[Commander] ${commander.name} (Team ${squad.teamID}) resigned commander after ${heldText}.` +
        (earlierResigns.length > 0 ? ` Quick resigns in 24 h: ${earlierResigns.length + 1}.` : '');
      // Admin lists can hold Steam IDs or EOS IDs, so match on both.
      const adminIDs = this.server.getAdminsWithPermission('canseeadminchat', 'anyID');
      for (const player of players) {
        if (!adminIDs.includes(player.eosID) && !adminIDs.includes(player.steamID)) continue;
        await this.server.rcon.warn(player.eosID, warning);
      }
    }

    const historyText =
      earlierResigns.length === 0
        ? 'First in the last 24 h'
        : `**${earlierResigns.length + 1}** in the last 24 h (earlier: ${earlierResigns
            .map((time) => `<t:${toUnix(time)}:t>`)
            .join(', ')})`;
    const profileLinks = commander.steamID
      ? `[Steam](https://steamcommunity.com/profiles/${commander.steamID}) · ` +
        `[BattleMetrics](https://www.battlemetrics.com/players?filter[search]=${commander.steamID})`
      : 'No Steam ID';

    await this.sendDiscordMessage({
      embed: {
        title: `Commander resigned after ${heldText}`,
        description: `**${commander.name}** took command and resigned within ${formatDuration(
          this.options.maxCommandSeconds * 1000
        )}.`,
        color: this.options.color,
        fields: [
          {
            name: 'Player',
            value: `${commander.name}\n${profileLinks}`,
            inline: true
          },
          {
            name: 'Team',
            value: `Team ${squad.teamID}\n${squad.teamName}`,
            inline: true
          },
          {
            name: 'Command held',
            value: `<t:${toUnix(resign.startTime)}:T> → <t:${toUnix(
              resign.endTime
            )}:T>\n${heldText}`,
            inline: true
          },
          {
            name: 'Quick resigns',
            value: historyText,
            inline: true
          },
          {
            name: 'Layer',
            value: this.server.currentLayer?.name || 'Unknown',
            inline: true
          },
          {
            name: 'IDs',
            value: `Steam: \`${commander.steamID || 'none'}\`\nEOS: \`${commander.eosID}\``
          }
        ],
        timestamp: new Date(resign.endTime).toISOString()
      }
    });
  }
}

function toUnix(time) {
  return Math.round(time / 1000);
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.round(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds} s`;
  return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
}
