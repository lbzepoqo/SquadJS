import DiscordBasePlugin from './discord-base-plugin.js';
import axios from 'axios';

// The kick arrives over RCON and the disconnect through the log, so either can come first.
const KICK_DISCONNECT_WINDOW_MS = 60 * 1000;

export default class DiscordDisconnectWhitelister extends DiscordBasePlugin {
  static get description() {
    return (
      'Auto-whitelists players who trigger <code>PLAYER_DISCONNECTED</code> through AdminSync in Admins.cfg. ' +
      'Only processes players with a linked Discord account (checked via MySquadStats, then the Whitelister API). ' +
      'Players already in a reserve-capable group or kicked by an admin or plugin are skipped. ' +
      'Optionally logs results to a Discord channel.'
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
        description: 'Channel ID to log whitelist events. Leave empty to disable Discord logging.',
        default: '',
        example: '667741905228136459'
      },
      pingUserEnabled: {
        required: false,
        description:
          "Whether to @mention the whitelisted player's Discord account in the log message.",
        default: false
      },
      whitelisterApiUrl: {
        required: true,
        description: 'The URL of the Squad Whitelister API.',
        default: 'http://your-api-url.com'
      },
      whitelisterApiKey: {
        required: true,
        description: 'The API key for the Squad Whitelister.',
        default: ''
      },
      whitelistDurationHours: {
        required: false,
        description: 'Duration in hours for the whitelist entry.',
        default: 0.1
      },
      remoteWhitelistUrl: {
        required: false,
        description:
          'URL or array of URLs to fetch remote whitelist data from, used to skip players already in a reserve group.',
        example:
          'https://example.com/whitelist.txt or ["https://example.com/whitelist1.txt", "https://example.com/whitelist2.txt"]'
      },
      reloadDebounceTime: {
        required: false,
        description:
          'Debounce time in milliseconds before reloading server config after a whitelist change.',
        default: 5000
      },
      blockConfigReloadDuringIntermission: {
        required: false,
        description: 'Block config reloads between round end and new game start.',
        default: true
      },
      whitelistRefreshIntervalMinutes: {
        required: false,
        description:
          'How often to refresh the remote whitelist cache in minutes. 0 disables periodic refresh.',
        default: 10
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);
    this.onPlayerDisconnected = this.onPlayerDisconnected.bind(this);
    this.onPlayerKicked = this.onPlayerKicked.bind(this);
    this.scheduleConfigReload = this.scheduleConfigReload.bind(this);
    this.onRoundEnded = this.onRoundEnded.bind(this);
    this.onNewGame = this.onNewGame.bind(this);
    this.whitelistedPlayers = new Map();
    this.reloadTimeout = null;
    this.reloadPending = false;
    this.reloadRunning = false;
    this.reloadFailures = 0;
    this.reloadWaiters = [];
    this.activeReloadWaiters = [];
    this.stopped = false;
    this.processingPlayers = new Set();
    this.recentKicks = new Map();
    this.allowConfigReload = true;
    this.whitelistCache = { parsedData: null, timestamp: 0, isLoading: false };
    this.whitelistRefreshInterval = null;
  }

  async prepareToMount() {
    // Don't call super — channelID is optional in this plugin.
    this.channel = null;
    if (this.options.channelID) {
      try {
        this.channel = await this.options.discordClient.channels.fetch(this.options.channelID);
      } catch (error) {
        this.verbose(1, `Could not fetch channel ${this.options.channelID}: ${error.message}`);
      }
    }
  }

  async mount() {
    this.stopped = false;
    this.server.on('PLAYER_DISCONNECTED', this.onPlayerDisconnected);
    this.server.on('PLAYER_KICKED', this.onPlayerKicked);
    this.server.on('ROUND_ENDED', this.onRoundEnded);
    this.server.on('NEW_GAME', this.onNewGame);
    this.server.on('ADMINS_UPDATED', this.scheduleConfigReload);
    // AdminSync can reconcile persisted grants before this plugin mounts.
    this.scheduleConfigReload();

    await this.refreshWhitelistCache();
    if (this.stopped) return;

    const intervalMinutes = this.options.whitelistRefreshIntervalMinutes;
    if (intervalMinutes > 0) {
      this.whitelistRefreshInterval = setInterval(
        () => this.refreshWhitelistCache(),
        intervalMinutes * 60 * 1000
      );
      this.verbose(1, `Whitelist cache will refresh every ${intervalMinutes} minutes`);
    }

    this.verbose(1, 'Discord Disconnect Whitelister mounted');
  }

  async unmount() {
    this.stopped = true;
    this.reloadPending = false;
    clearTimeout(this.reloadResponseTimeout);
    for (const resolve of [...this.reloadWaiters.splice(0), ...this.activeReloadWaiters.splice(0)])
      resolve(false);
    this.server.off('PLAYER_DISCONNECTED', this.onPlayerDisconnected);
    this.server.off('PLAYER_KICKED', this.onPlayerKicked);
    this.server.off('ROUND_ENDED', this.onRoundEnded);
    this.server.off('NEW_GAME', this.onNewGame);
    this.server.off('ADMINS_UPDATED', this.scheduleConfigReload);
    clearTimeout(this.reloadTimeout);
    this.reloadTimeout = null;
    if (this.whitelistRefreshInterval) {
      clearInterval(this.whitelistRefreshInterval);
      this.whitelistRefreshInterval = null;
    }
    this.verbose(1, 'Discord Disconnect Whitelister unmounted');
  }

  onRoundEnded() {
    if (this.options.blockConfigReloadDuringIntermission) {
      this.allowConfigReload = false;
      this.verbose(2, 'Round ended — config reloads blocked during intermission.');
    }
  }

  onNewGame() {
    this.allowConfigReload = true;
    this.verbose(2, 'New game started — config reloads enabled.');
    this.scheduleConfigReload();
  }

  onPlayerKicked(info) {
    if (!info?.eosID) return;
    const now = Date.now();
    for (const [eosID, kickedAt] of this.recentKicks) {
      if (now - kickedAt > KICK_DISCONNECT_WINDOW_MS) this.recentKicks.delete(eosID);
    }
    this.recentKicks.set(info.eosID, now);
  }

  wasRecentlyKicked(eosID) {
    const kickedAt = this.recentKicks.get(eosID);
    return kickedAt !== undefined && Date.now() - kickedAt <= KICK_DISCONNECT_WINDOW_MS;
  }

  async onPlayerDisconnected(info) {
    const player = info.player;
    if (!player?.eosID) return;
    if (this.stopped || this.processingPlayers.has(player.eosID)) return;
    if (this.wasRecentlyKicked(player.eosID)) {
      this.verbose(1, `Player ${player.eosID} was kicked — skipping whitelist.`);
      return;
    }
    this.processingPlayers.add(player.eosID);
    try {
      await this.addPlayerToWhitelist(player.eosID, player.steamID ?? null, player.name ?? null);
    } catch (error) {
      this.verbose(1, `Disconnect processing failed for ${player.eosID}: ${error.message}`);
    } finally {
      this.processingPlayers.delete(player.eosID);
    }
  }

  async addPlayerToWhitelist(eosID, steamID, name) {
    const now = Date.now();
    const whitelistDurationMs = this.options.whitelistDurationHours * 60 * 60 * 1000;
    const lastWhitelisted = this.whitelistedPlayers.get(eosID);

    if (lastWhitelisted && now - lastWhitelisted < whitelistDurationMs) {
      this.verbose(2, `Player ${eosID} recently whitelisted — skipping.`);
      return;
    }

    if (this.isPlayerInReserveGroup(eosID)) {
      this.whitelistedPlayers.set(eosID, now);
      return;
    }

    let playerName = name ?? `Unknown (${eosID})`;
    let discordUserId = null;
    let resolvedSteamID = steamID;

    try {
      const response = await axios.get(`https://api.mysquadstats.com/playerLink?eosID=${eosID}`, {
        timeout: 10000
      });
      const data = response.data;
      if (data.successStatus === 'Success' && data.data) {
        if (data.data.lastName) playerName = data.data.lastName.trim();
        if (data.data.discordID) discordUserId = data.data.discordID;
        if (!resolvedSteamID && data.data.steamID) resolvedSteamID = data.data.steamID;
      }
    } catch (error) {
      this.verbose(1, `MySquadStats lookup failed for ${eosID}: ${error.message}`);
    }

    if (!discordUserId) {
      try {
        const response = await axios.get(
          `${this.options.whitelisterApiUrl}/api/players/read/from/eosId/${eosID}?apiKey=${this.options.whitelisterApiKey}`,
          { timeout: 10000 }
        );
        const data = response.data;
        if (data.discord_user_id) {
          discordUserId = data.discord_user_id;
          if (data.username && playerName === `Unknown (${eosID})`)
            playerName = data.username.trim();
        }
      } catch (error) {
        this.verbose(1, `Whitelister API lookup failed for ${eosID}: ${error.message}`);
      }
    }

    if (this.stopped) return;
    // The kick can arrive while the account lookups are running.
    if (this.wasRecentlyKicked(eosID)) {
      this.verbose(1, `Player ${eosID} was kicked — skipping whitelist.`);
      return;
    }
    if (!discordUserId) {
      this.verbose(2, `Player ${playerName} (${eosID}) has no linked Discord — skipping.`);
      return;
    }

    try {
      await new Promise((resolve, reject) => {
        if (
          !this.server.emit('TEMPORARY_RESERVE_REQUEST', {
            eosID,
            steamID: resolvedSteamID,
            durationHours: this.options.whitelistDurationHours,
            resolve,
            reject
          })
        ) {
          reject(new Error('AdminSync must be enabled to grant temporary reserve access'));
        }
      });
      this.verbose(1, `Whitelisted ${playerName} (${eosID}) in Admins.cfg`);
      this.whitelistedPlayers.set(eosID, now);
      const acknowledged = await this.scheduleConfigReload();
      // The grant is already written. Only the reload command waits for the next map start.
      const status = acknowledged ? 'active' : this.allowConfigReload ? 'unconfirmed' : 'deferred';
      if (!this.stopped) {
        await this.sendSuccessEmbed(playerName, eosID, resolvedSteamID, discordUserId, status);
      }
    } catch (error) {
      this.verbose(1, `Temporary reserve write failed for ${eosID}: ${error.message}`);
      await this.sendFailureEmbed(eosID, 'Error Message', error.message);
    }
  }

  async sendSuccessEmbed(playerName, eosID, steamID, discordUserId, status = 'unconfirmed') {
    if (!this.channel) return;

    const durationMinutes = Number((this.options.whitelistDurationHours * 60).toFixed(2));
    const minuteUnit = durationMinutes === 1 ? 'minute' : 'minutes';
    const links = steamID
      ? `[Steam](https://steamcommunity.com/profiles/${steamID}) | [BattleMetrics](https://www.battlemetrics.com/players?filter[search]=${steamID})`
      : 'No Steam ID';

    const notices = {
      active: {
        title: '🔁 Reconnect without the queue',
        color: 0x2ecc71,
        description:
          `Your **${durationMinutes} ${minuteUnit}** temporary reserve entry is saved. ` +
          'Squad acknowledged the config reload request.\n\n' +
          '**Wait 15-30 seconds, then rejoin.**\n' +
          'Still cannot connect? Restart your game client and try again.'
      },
      deferred: {
        title: '⏳ Reserve saved, active at the next map',
        color: 0x3498db,
        description:
          `Your **${durationMinutes} ${minuteUnit}** temporary reserve entry is saved in the admin ` +
          'list. The match has ended, so the server applies it when the next map starts.\n\n' +
          '**Rejoin after the new map has loaded.**\n' +
          'The expiry timer runs from the moment you disconnected.'
      },
      unconfirmed: {
        title: 'Temporary reserve saved',
        color: 0xf1c40f,
        description:
          'Your temporary reserve entry is saved, but Squad has not acknowledged the config reload. ' +
          'Queue priority is not confirmed. The expiry timer continues while the reload is pending.'
      }
    };
    const notice = notices[status] ?? notices.unconfirmed;

    const embed = {
      title: notice.title,
      color: notice.color,
      description: notice.description,
      fields: [
        { name: 'Player', value: playerName, inline: true },
        { name: 'Links', value: links, inline: false }
      ],
      timestamp: new Date().toISOString(),
      footer: { text: 'Temporary reconnect access • Expires automatically' }
    };

    const content =
      this.options.pingUserEnabled && discordUserId
        ? `<@${discordUserId}> Disconnected? Let's get you back in.`
        : null;

    try {
      await this.channel.send({ content, embeds: [embed] });
    } catch (error) {
      this.verbose(1, `Failed to send success embed: ${error.message}`);
    }
  }

  async sendFailureEmbed(eosID, errorLabel, details) {
    if (this.stopped || !this.channel) return;

    const embed = {
      title: 'Whitelist Attempt Failed',
      color: 0xff0000,
      fields: [
        { name: 'EOS ID', value: eosID, inline: true },
        { name: 'Trigger', value: 'Player Disconnected', inline: true },
        {
          name: errorLabel,
          value: String(details).substring(0, 1024),
          inline: false
        }
      ],
      timestamp: new Date().toISOString(),
      footer: { text: 'DiscordDisconnectWhitelister' }
    };

    try {
      await this.channel.send({ embeds: [embed] });
    } catch (error) {
      this.verbose(1, `Failed to send failure embed: ${error.message}`);
    }
  }

  async refreshWhitelistCache() {
    if (!this.options.remoteWhitelistUrl) return;
    if (this.whitelistCache.isLoading) return;

    this.whitelistCache.isLoading = true;
    try {
      const urls = Array.isArray(this.options.remoteWhitelistUrl)
        ? this.options.remoteWhitelistUrl
        : [this.options.remoteWhitelistUrl];

      const axiosConfig = {
        timeout: 30000,
        headers: {
          'User-Agent': 'SquadJS-DisconnectWhitelister/1.0',
          Accept: 'text/plain, */*'
        }
      };

      const results = await Promise.allSettled(
        urls.map(async (url) => {
          if (!url) return '';
          const separator = url.includes('?') ? '&' : '?';
          const response = await axios.get(`${url}${separator}t=${Date.now()}`, axiosConfig);
          return response.data ?? '';
        })
      );

      let combined = '';
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          if (combined && !combined.endsWith('\n')) combined += '\n';
          combined += result.value;
        }
      }

      const content = combined.trim() || null;
      this.whitelistCache.parsedData = this.parseWhitelistData(content);
      this.whitelistCache.timestamp = Date.now();
      this.verbose(1, `Whitelist cache refreshed (${content?.length ?? 0} characters)`);
    } catch (error) {
      this.verbose(1, `Whitelist cache refresh failed: ${error.message}`);
    } finally {
      this.whitelistCache.isLoading = false;
    }
  }

  parseWhitelistData(rawContent) {
    if (!rawContent) return { groups: new Map(), admins: new Map() };
    const groups = new Map();
    const admins = new Map();
    for (const line of rawContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//')) continue;
      if (trimmed.startsWith('Group=')) {
        const match = trimmed.match(/^Group=([^:]+):(.*)$/);
        if (match) groups.set(match[1], match[2]);
      } else if (trimmed.startsWith('Admin=')) {
        const match = trimmed.match(/^Admin=([^:]+):([^\s]+)(.*)/);
        if (match) {
          const [, id, groupName, comment] = match;
          if (!admins.has(groupName)) admins.set(groupName, []);
          admins.get(groupName).push({
            id,
            groupName,
            comment: comment.trim(),
            original: trimmed
          });
        }
      }
    }
    return { groups, admins };
  }

  isPlayerInReserveGroup(eosID) {
    try {
      const parsedData = this.whitelistCache.parsedData;
      if (!parsedData) return false;
      const { groups, admins } = parsedData;
      for (const [groupName, groupAdmins] of admins) {
        const permissions = groups.get(groupName);
        if (permissions?.includes('reserve') && groupAdmins.some((admin) => admin.id === eosID)) {
          this.verbose(
            1,
            `Player ${eosID} already in reserve group "${groupName}" — skipping whitelist.`
          );
          return true;
        }
      }
      return false;
    } catch (error) {
      this.verbose(1, `Reserve group check failed for ${eosID}: ${error.message}`);
      return false;
    }
  }

  scheduleConfigReload() {
    if (this.stopped) return Promise.resolve(false);
    if (!this.reloadPending && !this.reloadRunning && !this.reloadTimeout) this.reloadFailures = 0;
    this.reloadPending = true;
    if (!this.allowConfigReload) return Promise.resolve(false);
    const result = new Promise((resolve) => this.reloadWaiters.push(resolve));
    if (!this.reloadTimeout && !this.reloadRunning) {
      this.reloadTimeout = setTimeout(
        () => this.reloadServerConfig(),
        this.options.reloadDebounceTime
      );
    }
    return result;
  }

  async reloadServerConfig() {
    if (this.stopped) return false;
    if (this.reloadRunning) return this.scheduleConfigReload();
    clearTimeout(this.reloadTimeout);
    this.reloadTimeout = null;
    if (!this.allowConfigReload) {
      this.reloadPending = true;
      for (const resolve of this.reloadWaiters.splice(0)) resolve(false);
      return false;
    }
    this.reloadRunning = true;
    this.reloadPending = false;
    // Held on the instance so unmount can settle callers waiting on an outstanding command.
    const waiters = this.reloadWaiters.splice(0);
    this.activeReloadWaiters = waiters;
    let acknowledged = false;
    let retry = false;
    // An unresponsive RCON socket never settles the command promise, so the wait is bounded here
    // and a timeout is treated as a failure. The reload is idempotent, so a later attempt that
    // overlaps an abandoned command is harmless.
    const command = this.server.rcon.execute('AdminReloadServerConfig');
    Promise.resolve(command).catch(() => {});
    try {
      const response = await Promise.race([
        command,
        new Promise((resolve, reject) => {
          this.reloadResponseTimeout = setTimeout(
            () => reject(new Error('acknowledgement timed out after 15 seconds')),
            15000
          );
        })
      ]);
      acknowledged = !this.stopped && String(response).trim() === 'Reloading server config...';
      if (!this.stopped) {
        this.verbose(
          1,
          acknowledged
            ? 'Squad acknowledged the config reload request.'
            : 'Config reload was not acknowledged; access is unconfirmed.'
        );
      }
      this.reloadFailures = 0;
    } catch (error) {
      this.reloadFailures++;
      retry = this.reloadFailures < 2;
      if (!this.stopped) this.verbose(1, `Config reload failed: ${error.message}`);
    } finally {
      clearTimeout(this.reloadResponseTimeout);
      this.reloadRunning = false;
      this.activeReloadWaiters = [];
      for (const resolve of waiters) resolve(acknowledged);
      if (!this.stopped && (this.reloadPending || retry)) {
        this.reloadPending = true;
        if (this.allowConfigReload) {
          this.reloadTimeout = setTimeout(
            () => this.reloadServerConfig(),
            retry ? 5000 : this.options.reloadDebounceTime
          );
        } else {
          for (const resolve of this.reloadWaiters.splice(0)) resolve(false);
        }
      }
    }
    return acknowledged;
  }
}
