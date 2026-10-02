import DiscordBasePlugin from './discord-base-plugin.js';

export default class ParserHealthCheck extends DiscordBasePlugin {
  static get description() {
    return (
      'The <code>ParserHealthCheck</code> plugin compares the data that SquadJS parses with other sources ' +
      'and warns when they disagree for several checks in a row. A Squad update that changes a log line ' +
      'or an RCON response usually makes SquadJS lose data without an error, and this plugin makes that visible.' +
      '<ul>' +
      '<li>ListPlayers: parsed players against the ShowServerInfo player count.</li>' +
      '<li>ShowServerInfo: player count is not a number.</li>' +
      '<li>Log parser: no parsed log event for a set time while the server has players.</li>' +
      '<li>Log parser: new players in ListPlayers without a parsed connect line.</li>' +
      '<li>Layers: the current layer is not in the layer list.</li>' +
      '</ul>'
    );
  }

  static get defaultEnabled() {
    return false;
  }

  static get optionsSpecification() {
    return {
      ...DiscordBasePlugin.optionsSpecification,
      channelID: {
        required: false,
        description:
          'ID of the channel for warnings. When empty, warnings are only written to the log.',
        default: '',
        example: '667741905228136459'
      },
      checkInterval: {
        required: false,
        description: 'Time between checks, in milliseconds.',
        default: 60 * 1000
      },
      consecutiveChecks: {
        required: false,
        description: 'Number of failed checks in a row before a warning is sent.',
        default: 3
      },
      minimumPlayers: {
        required: false,
        description:
          'The ListPlayers and log activity checks run only when ShowServerInfo reports at least this many players.',
        default: 10
      },
      logActivityTimeout: {
        required: false,
        description:
          'Time without any parsed log event before the log activity check fails, in milliseconds. ' +
          'Squad can stop writing tick rate lines for 40 minutes or more, so all log events are counted.',
        default: 15 * 60 * 1000
      },
      connectGracePeriod: {
        required: false,
        description:
          'Time a new player may be in ListPlayers without a parsed connect line, in milliseconds.',
        default: 2 * 60 * 1000
      },
      minimumPlayersWithoutConnect: {
        required: false,
        description: 'Number of new players without a parsed connect line before the check fails.',
        default: 3
      },
      checkCurrentLayer: {
        required: false,
        description:
          'Warn when the current layer is not in the SquadJS layer list. Turn this off when the layer list ' +
          'is known to be out of date for the current Squad version.',
        default: true
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.runChecks = this.runChecks.bind(this);
    this.onLogEvent = this.onLogEvent.bind(this);

    this.failureCounts = {};
    this.activeWarnings = new Set();
    this.firstSeenTimes = new Map();
    this.checkTimer = null;
  }

  async prepareToMount() {
    if (this.options.channelID) await super.prepareToMount();
  }

  // Server events that come from log lines.
  static get logEvents() {
    return [
      'ADMIN_BROADCAST',
      'DEPLOYABLE_DAMAGED',
      'NEW_GAME',
      'PLAYER_CONNECTED',
      'PLAYER_DISCONNECTED',
      'PLAYER_DAMAGED',
      'PLAYER_WOUNDED',
      'PLAYER_DIED',
      'PLAYER_REVIVED',
      'PLAYER_POSSESS',
      'PLAYER_UNPOSSESS',
      'ROUND_ENDED',
      'TICK_RATE'
    ];
  }

  async mount() {
    this.mountTime = Date.now();
    this.lastLogEventTime = Date.now();
    // Players already online at startup connected before the log parser started, so they are not checked.
    for (const player of this.server.players) this.firstSeenTimes.set(player.eosID, 0);
    for (const eventName of ParserHealthCheck.logEvents) this.server.on(eventName, this.onLogEvent);
    this.checkTimer = setInterval(this.runChecks, this.options.checkInterval);
  }

  async unmount() {
    clearInterval(this.checkTimer);
    for (const eventName of ParserHealthCheck.logEvents) {
      this.server.removeListener(eventName, this.onLogEvent);
    }
  }

  onLogEvent() {
    this.lastLogEventTime = Date.now();
  }

  async runChecks() {
    try {
      await this.evaluate('serverInfo', this.checkServerInfo());
      await this.evaluate('listPlayers', this.checkListPlayers());
      await this.evaluate('logActivity', this.checkLogActivity());
      await this.evaluate('connectLines', this.checkConnectLines());
      if (this.options.checkCurrentLayer) {
        await this.evaluate('currentLayer', this.checkCurrentLayer());
      }
    } catch (error) {
      this.verbose(1, `Health check failed to run: ${error.message}`);
    }
  }

  // Each check returns null when it passes, or a message that describes the problem.
  checkServerInfo() {
    const playerCount = this.server.playerCount;
    if (typeof playerCount !== 'number' || Number.isNaN(playerCount)) {
      return `ShowServerInfo player count is not a number (${playerCount}). The ShowServerInfo fields may have changed.`;
    }
    return null;
  }

  checkListPlayers() {
    const reported = this.server.playerCount;
    const parsed = this.server.players.length;
    if (!Number.isFinite(reported) || reported < this.options.minimumPlayers) return null;
    if (parsed < reported * 0.5) {
      return `ListPlayers parsed ${parsed} players, but ShowServerInfo reports ${reported}. The ListPlayers format may have changed.`;
    }
    return null;
  }

  checkLogActivity() {
    const reported = this.server.playerCount;
    if (!Number.isFinite(reported) || reported < this.options.minimumPlayers) {
      // An empty server can be quiet for a long time, so the timer restarts while the check is off.
      this.lastLogEventTime = Date.now();
      return null;
    }
    const silentTime = Date.now() - this.lastLogEventTime;
    if (silentTime > this.options.logActivityTimeout) {
      return `No parsed log event for ${Math.round(
        silentTime / 60000
      )} minutes with ${reported} players online. Log reading stopped, or the log format changed.`;
    }
    return null;
  }

  checkConnectLines() {
    const now = Date.now();
    const onlineEosIDs = new Set();
    const missing = [];
    for (const player of this.server.players) {
      onlineEosIDs.add(player.eosID);
      if (!this.firstSeenTimes.has(player.eosID)) {
        // If the first player list at startup was empty, players seen soon after mount are treated as already online.
        const startupWindow = now - this.mountTime < this.options.connectGracePeriod;
        this.firstSeenTimes.set(player.eosID, startupWindow ? 0 : now);
      }
      const firstSeen = this.firstSeenTimes.get(player.eosID);
      if (firstSeen === 0 || now - firstSeen < this.options.connectGracePeriod) continue;
      // player-damaged.js also creates entries (controller only), so a connect entry is identified by its IP.
      const storedPlayer = this.server.logParser.eventStore.players[player.eosID];
      if (!storedPlayer || !storedPlayer.ip) missing.push(player.name);
    }
    for (const eosID of this.firstSeenTimes.keys()) {
      if (!onlineEosIDs.has(eosID)) this.firstSeenTimes.delete(eosID);
    }
    if (missing.length >= this.options.minimumPlayersWithoutConnect) {
      return `${missing.length} players joined without a parsed connect line (${missing
        .slice(0, 5)
        .join(', ')}). The player connected log line may have changed.`;
    }
    return null;
  }

  checkCurrentLayer() {
    if (this.server.currentLayer) return null;
    return 'The current layer is not in the SquadJS layer list. The layer list may be out of date for this Squad version.';
  }

  async evaluate(checkName, problem) {
    if (!problem) {
      this.failureCounts[checkName] = 0;
      if (this.activeWarnings.has(checkName)) {
        this.activeWarnings.delete(checkName);
        await this.report(`Recovered: ${checkName} check passes again.`, '00ff00');
      }
      return;
    }
    this.failureCounts[checkName] = (this.failureCounts[checkName] || 0) + 1;
    this.verbose(2, `${checkName} check failed (${this.failureCounts[checkName]}x): ${problem}`);
    if (this.failureCounts[checkName] < this.options.consecutiveChecks) return;
    if (this.activeWarnings.has(checkName)) return;
    this.activeWarnings.add(checkName);
    await this.report(`${checkName}: ${problem}`, 'ff0000');
  }

  async report(message, color) {
    this.verbose(1, message);
    if (!this.channel) return;
    try {
      await this.sendDiscordMessage({
        embed: {
          title: 'SquadJS parser health check',
          description: message,
          color: color
        }
      });
    } catch (error) {
      this.verbose(1, `Could not send the warning to Discord: ${error.message}`);
    }
  }
}
