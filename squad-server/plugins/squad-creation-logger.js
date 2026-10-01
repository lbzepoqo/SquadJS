import DiscordBasePlugin from './discord-base-plugin.js';

export default class SquadCreationLogger extends DiscordBasePlugin {
  static get description() {
    return 'Logs squad creation events to Discord with player information and Steam profile links.';
  }

  static get defaultEnabled() {
    return false;
  }

  static get optionsSpecification() {
    return {
      ...DiscordBasePlugin.optionsSpecification,
      channelID: {
        required: true,
        description: 'The ID of the channel to log squad creation events to.',
        default: '',
        example: '667741905228136459'
      },
      suppressNotifications: {
        required: false,
        description: 'Whether to suppress Discord notifications for messages sent by this plugin.',
        default: false
      },
      showSquadNumber: {
        required: false,
        description: 'Whether to show the squad number in the Discord message.',
        default: true
      },
      showFaction: {
        required: false,
        description: 'Whether to show the faction in the Discord message.',
        default: true
      },
      embedFormat: {
        required: false,
        description: 'Whether to use Discord embeds (true) or simple text format (false).',
        default: true
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);
    this.onLogLine = this.onLogLine.bind(this);

    // Pattern to match squad creation log lines
    this.squadCreationPattern =
      /^\[([0-9.:-]+)]\[(\s*\d+)]LogSquad: (.+) \(Online IDs: EOS: ([0-9a-f]+) steam: (\d+)\) has created Squad (\d+) \(Squad Name: (.+)\) on (.+)$/;
  }

  async mount() {
    this.server.logParser.logReader.reader.on('line', this.onLogLine);
    this.verbose(1, 'Squad Creation Logger mounted');
  }

  async unmount() {
    this.server.logParser.logReader.reader.off('line', this.onLogLine);
    this.verbose(1, 'Squad Creation Logger unmounted');
  }

  async onLogLine(line) {
    const match = this.squadCreationPattern.exec(line);
    if (!match) return;

    const [, timestamp, chainID, playerName, eosID, steamID, squadNumber, squadName, faction] =
      match;

    this.verbose(
      2,
      `Squad creation detected: ${playerName} created squad ${squadNumber} (${squadName}) on ${faction}`
    );

    await this.sendSquadCreationNotification({
      timestamp,
      chainID,
      playerName: playerName.trim(),
      eosID,
      steamID,
      squadNumber: parseInt(squadNumber),
      squadName: squadName.trim(),
      faction: faction.trim()
    });
  }

  async sendSquadCreationNotification(data) {
    const steamProfileUrl = `https://steamcommunity.com/profiles/${data.steamID}`;
    const timestampUnix = this.parseSquadTimestamp(data.timestamp);

    if (this.options.embedFormat) {
      await this.sendEmbedNotification(data, steamProfileUrl, timestampUnix);
    } else {
      await this.sendTextNotification(data, steamProfileUrl, timestampUnix);
    }
  }

  async sendEmbedNotification(data, steamProfileUrl, timestampUnix) {
    const fields = [
      { name: 'Player', value: `[${data.playerName}](${steamProfileUrl})`, inline: true }
    ];

    if (this.options.showSquadNumber) {
      fields.push({
        name: 'Squad',
        value: `${data.squadNumber} - ${data.squadName}`,
        inline: true
      });
    } else {
      fields.push({ name: 'Squad Name', value: data.squadName, inline: true });
    }

    if (this.options.showFaction) {
      fields.push({ name: 'Faction', value: data.faction, inline: true });
    }

    fields.push(
      { name: 'Steam ID', value: data.steamID, inline: true },
      { name: 'EOS ID', value: data.eosID, inline: true }
    );

    const embed = {
      title: '🏗️ Squad Created',
      color: 0x4caf50,
      fields,
      timestamp: new Date(timestampUnix * 1000).toISOString(),
      footer: { text: 'Squad Creation Logger' }
    };

    try {
      await this.sendDiscordMessage({ embeds: [embed] });
      this.verbose(2, `Sent Discord embed notification for squad creation by ${data.playerName}`);
    } catch (error) {
      this.verbose(1, `Error sending Discord embed notification: ${error.message}`);
    }
  }

  async sendTextNotification(data, steamProfileUrl, timestampUnix) {
    const bmUrl = `https://www.battlemetrics.com/rcon/players?filter%5Bsearch%5D=${data.eosID}&method=quick&redirect=1`;
    const cblUrl = `https://communitybanlist.com/search/${data.steamID}`;

    let message = `[<t:${timestampUnix}:D> <t:${timestampUnix}:T>] [\`${data.playerName}\`](<${steamProfileUrl}>)`;

    if (this.options.showSquadNumber) {
      message += ` created Squad ${data.squadNumber} - **${data.squadName}**`;
    } else {
      message += ` created squad **${data.squadName}**`;
    }

    if (this.options.showFaction) {
      message += ` on ${data.faction}`;
    }

    message += ` [[BM](<${bmUrl}>)][[CBL](<${cblUrl}>)]`;

    try {
      const messageObject = {
        content: message
      };

      // Add suppress notifications flag if enabled
      if (this.options.suppressNotifications) {
        messageObject.flags = 4096;
      }

      await this.sendDiscordMessage(messageObject);
      this.verbose(2, `Sent Discord text notification for squad creation by ${data.playerName}`);
    } catch (error) {
      this.verbose(1, `Error sending Discord text notification: ${error.message}`);
    }
  }

  parseSquadTimestamp(squadTimestamp) {
    // Squad timestamp format: 2025.07.25-10.20.29:291
    // Convert to Unix timestamp
    try {
      const [date, time] = squadTimestamp.split('-');
      const [year, month, day] = date.split('.');
      const [hour, minute, secondMs] = time.split('.');
      const [second, millisecond] = secondMs.split(':');

      const jsDate = new Date(
        parseInt(year),
        parseInt(month) - 1, // JS months are 0-indexed
        parseInt(day),
        parseInt(hour),
        parseInt(minute),
        parseInt(second),
        parseInt(millisecond)
      );

      return Math.floor(jsDate.getTime() / 1000);
    } catch (error) {
      this.verbose(1, `Error parsing Squad timestamp ${squadTimestamp}: ${error.message}`);
      return Math.floor(Date.now() / 1000); // Fallback to current time
    }
  }

  async sendDiscordMessage(message) {
    // Add suppress notifications flag if enabled and not already set
    if (this.options.suppressNotifications && typeof message === 'object') {
      message.flags = (message.flags || 0) | 4096;
    }

    return super.sendDiscordMessage(message);
  }
}
