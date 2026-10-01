import fs from 'fs';

import DiscordBasePlugin from './discord-base-plugin.js';

const MINUTES_PER_DAY = 24 * 60;
const RESTART_WARNING_MINUTES = new Set([60, 30, 15, 10, 5, 4, 3, 2, 1]);
const RESTART_WARNING_CHECK_INTERVAL_MS = 15 * 1000;

function parseTime(time, optionName) {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  const hour = Number(match?.[1]);
  const minute = Number(match?.[2]);

  if (!match || hour > 23 || minute > 59) {
    throw new Error(`${optionName} must use 24-hour HH:MM format.`);
  }

  return hour * 60 + minute;
}

function getLocalParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function getLocalDateKey(date, timeZone) {
  const parts = getLocalParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getRestartCycleDate(date, restartTime, restartWindowMinutes, timeZone) {
  const parts = getLocalParts(date, timeZone);
  const currentMinute = Number(parts.hour) * 60 + Number(parts.minute);
  const restartMinute = parseTime(restartTime, 'restartTime');

  if (currentMinute >= restartMinute) return getLocalDateKey(date, timeZone);
  if (!isWithinRestartWindow(date, restartTime, restartWindowMinutes, timeZone)) return null;

  return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) - 1))
    .toISOString()
    .slice(0, 10);
}

function isWithinDailyWindow(date, startTime, windowMinutes, timeZone, optionName) {
  const values = getLocalParts(date, timeZone);
  const currentMinute = Number(values.hour) * 60 + Number(values.minute);
  const elapsedMinutes =
    (currentMinute - parseTime(startTime, optionName) + MINUTES_PER_DAY) % MINUTES_PER_DAY;

  return elapsedMinutes < windowMinutes;
}

function minutesUntilDailyTime(date, time, timeZone, optionName) {
  const values = getLocalParts(date, timeZone);
  const currentMinute = Number(values.hour) * 60 + Number(values.minute);
  return (parseTime(time, optionName) - currentMinute + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

export function isWithinRestartWindow(date, restartTime, restartWindowMinutes, timeZone) {
  return isWithinDailyWindow(date, restartTime, restartWindowMinutes, timeZone, 'restartTime');
}

export default class DiscordSeedingAnnouncement extends DiscordBasePlugin {
  static get description() {
    return (
      'The <code>DiscordSeedingAnnouncement</code> plugin sends in-game restart countdowns plus ' +
      'first-seeder, population-aware scheduled, and live-threshold Discord announcements.'
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
        description: 'The ID of the Discord channel for seeding announcements.',
        default: '',
        example: '667741905228136459'
      },
      pingGroups: {
        required: false,
        description:
          'Discord role IDs to ping when the first seeder connects. Leave empty to announce without a ping.',
        default: [],
        example: ['667741905228136459']
      },
      message: {
        required: false,
        description: 'Message sent with the role mentions.',
        default: 'Seeding has started. Join the server and help us seed!'
      },
      restartTime: {
        required: false,
        description:
          'Daily seeding cycle boundary in 24-hour HH:MM format. The game-server restart remains external to SquadJS.',
        default: '08:00'
      },
      restartWindowMinutes: {
        required: false,
        description: 'Minutes after restartTime when first-seeder behavior can arm or catch up.',
        default: 120
      },
      seedingAnnouncementRoles: {
        required: true,
        description: 'Discord role IDs to ping in the scheduled seeding announcement.',
        default: [],
        example: ['667741905228136459']
      },
      seedingAnnouncementTime: {
        required: false,
        description: 'Scheduled seeding announcement time in 24-hour HH:MM format.',
        default: '13:00'
      },
      seedingAnnouncementWindowMinutes: {
        required: false,
        description: 'Minutes after seedingAnnouncementTime during which the message can send.',
        default: 60
      },
      seedingAnnouncementMessage: {
        required: false,
        description:
          'Scheduled message used below liveThreshold. Supports {{server.players}} and {{server.name}}.',
        default:
          '# Seeding time!\n### Seeders: {{server.players}}\nJoin {{server.name}} and help us seed.'
      },
      alreadyLiveAnnouncementMessage: {
        required: false,
        description:
          'Scheduled message used at or above liveThreshold. Supports {{server.players}} and {{server.name}}.',
        default: '# Seeding time, and {{server.players}} players are already on {{server.name}}!'
      },
      liveAnnouncementRoles: {
        required: true,
        description: 'Discord role IDs to ping when the server first reaches liveThreshold.',
        default: [],
        example: ['667741905228136459']
      },
      liveThreshold: {
        required: false,
        description:
          'Player count that triggers the live announcement and selects the scheduled message.',
        default: 45
      },
      liveAnnouncementMessage: {
        required: false,
        description: 'Live-threshold message. Supports {{server.players}} and {{server.name}}.',
        default: '# We are live with {{server.players}} players!'
      },
      announcementEmbedDescription: {
        required: false,
        description: 'Embed description for scheduled and live announcements.',
        default: 'Server: `{{server.name}}`'
      },
      stateFilePath: {
        required: false,
        description: 'JSON file that prevents repeat announcements across plugin restarts.',
        default: './discord-seeding-announcement-state.json'
      },
      timeZone: {
        required: false,
        description: 'IANA time zone used for restartTime and seedingAnnouncementTime.',
        default: 'UTC'
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.validateOptions();
    this.armed = false;
    this.state = {};
    this.sending = new Set();
    this.processingServerInfo = false;
    this.now = () => new Date();
    this.onNewGame = this.onNewGame.bind(this);
    this.onPlayerConnected = this.onPlayerConnected.bind(this);
    this.onServerInfoUpdated = this.onServerInfoUpdated.bind(this);
    this.checkRestartWarning = this.checkRestartWarning.bind(this);
  }

  async prepareToMount() {
    await super.prepareToMount();
    await this.loadState();
  }

  async mount() {
    this.server.on('NEW_GAME', this.onNewGame);
    this.server.on('PLAYER_CONNECTED', this.onPlayerConnected);
    this.server.on('UPDATED_SERVER_INFORMATION', this.onServerInfoUpdated);
    await this.onServerInfoUpdated({ playerCount: this.server.a2sPlayerCount });
    await this.checkRestartWarning();
    this.restartWarningInterval = setInterval(
      this.checkRestartWarning,
      RESTART_WARNING_CHECK_INTERVAL_MS
    );
  }

  async unmount() {
    clearInterval(this.restartWarningInterval);
    this.server.off('NEW_GAME', this.onNewGame);
    this.server.off('PLAYER_CONNECTED', this.onPlayerConnected);
    this.server.off('UPDATED_SERVER_INFORMATION', this.onServerInfoUpdated);
  }

  validateOptions() {
    parseTime(this.options.restartTime, 'restartTime');
    parseTime(this.options.seedingAnnouncementTime, 'seedingAnnouncementTime');
    this.validateWindowMinutes('restartWindowMinutes');
    this.validateWindowMinutes('seedingAnnouncementWindowMinutes');
    this.validateRoleIDs('pingGroups', { allowEmpty: true });
    this.validateRoleIDs('seedingAnnouncementRoles');
    this.validateRoleIDs('liveAnnouncementRoles');

    if (!Number.isInteger(this.options.liveThreshold) || this.options.liveThreshold < 1) {
      throw new Error('liveThreshold must be a positive integer.');
    }

    if (typeof this.options.stateFilePath !== 'string' || this.options.stateFilePath.length === 0) {
      throw new Error('stateFilePath must be a non-empty string.');
    }

    new Intl.DateTimeFormat('en-GB', { timeZone: this.options.timeZone }).format();
  }

  validateWindowMinutes(optionName) {
    const value = this.options[optionName];
    if (!Number.isInteger(value) || value < 1 || value > MINUTES_PER_DAY) {
      throw new Error(`${optionName} must be an integer from 1 through 1440.`);
    }
  }

  validateRoleIDs(optionName, { allowEmpty = false } = {}) {
    const roleIDs = this.options[optionName];
    if (
      !Array.isArray(roleIDs) ||
      (!allowEmpty && roleIDs.length === 0) ||
      roleIDs.some((roleID) => typeof roleID !== 'string' || !/^\d+$/.test(roleID))
    ) {
      throw new Error(
        allowEmpty
          ? `${optionName} must be an array of Discord role IDs.`
          : `${optionName} must contain at least one Discord role ID.`
      );
    }
  }

  async loadState() {
    try {
      const raw = await fs.promises.readFile(this.options.stateFilePath, 'utf8');
      const state = JSON.parse(raw);
      this.state = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.verbose(
          1,
          `Could not read state file ${this.options.stateFilePath}: ${error.message}`
        );
      }
      this.state = {};
    }
  }

  async saveState() {
    const temporaryPath = `${this.options.stateFilePath}.tmp`;
    try {
      await fs.promises.writeFile(temporaryPath, JSON.stringify(this.state, null, 2), 'utf8');
      await fs.promises.rename(temporaryPath, this.options.stateFilePath);
      return true;
    } catch (error) {
      this.verbose(1, `Could not write state file ${this.options.stateFilePath}: ${error.message}`);
      await fs.promises.unlink(temporaryPath).catch(() => {});
      return false;
    }
  }

  onNewGame() {
    if (
      !isWithinRestartWindow(
        this.now(),
        this.options.restartTime,
        this.options.restartWindowMinutes,
        this.options.timeZone
      )
    ) {
      this.armed = false;
    }
  }

  sendFirstSeeder(cycleDate, label) {
    return this.sendOnce(
      'seederPingDate',
      cycleDate,
      () =>
        this.sendDiscordMessage({
          content: `${this.roleMentions(this.options.pingGroups)} ${this.options.message}`.trim(),
          allowedMentions: { roles: this.options.pingGroups }
        }),
      label
    );
  }

  async ensureDailyCycle(now, playerCount) {
    const cycleDate = getRestartCycleDate(
      now,
      this.options.restartTime,
      this.options.restartWindowMinutes,
      this.options.timeZone
    );
    if (!cycleDate) return false;

    const previousCycleDate = this.state.cycleDate;
    this.state.cycleDate = cycleDate;
    if (previousCycleDate !== cycleDate && !(await this.saveState())) {
      this.state.cycleDate = previousCycleDate;
      return false;
    }

    if (
      !isWithinRestartWindow(
        now,
        this.options.restartTime,
        this.options.restartWindowMinutes,
        this.options.timeZone
      )
    ) {
      this.armed = false;
      return true;
    }

    if (this.state.seederPingDate === cycleDate) {
      this.armed = false;
      return true;
    }

    if (playerCount === 0) {
      this.armed = true;
      this.verbose(1, 'Seeding announcement armed by schedule.');
      return true;
    }

    this.armed = false;
    await this.sendFirstSeeder(cycleDate, 'first-seeder catch-up announcement');
    return true;
  }

  async onPlayerConnected(info) {
    if (!this.armed || !this.channel) return;

    this.armed = false;
    const cycleDate = getRestartCycleDate(
      this.now(),
      this.options.restartTime,
      this.options.restartWindowMinutes,
      this.options.timeZone
    );
    if (this.state.cycleDate !== cycleDate) return;

    const sent = await this.sendFirstSeeder(
      cycleDate,
      `first-seeder announcement after ${info.player?.name ?? 'a player'} connected`
    );
    if (!sent && this.state.seederPingDate !== cycleDate) {
      this.armed = true;
    }
  }

  async onServerInfoUpdated(info) {
    if (!this.channel || this.processingServerInfo) return;

    const now = this.now();
    const cycleDate = getRestartCycleDate(
      now,
      this.options.restartTime,
      this.options.restartWindowMinutes,
      this.options.timeZone
    );
    const playerCount = Number(info?.playerCount ?? this.server.a2sPlayerCount);
    if (!Number.isFinite(playerCount)) return;

    this.processingServerInfo = true;
    try {
      await this.ensureDailyCycle(now, playerCount);
      if (this.state.cycleDate !== cycleDate) return;

      if (
        isWithinDailyWindow(
          now,
          this.options.seedingAnnouncementTime,
          this.options.seedingAnnouncementWindowMinutes,
          this.options.timeZone,
          'seedingAnnouncementTime'
        )
      ) {
        const isLive = playerCount >= this.options.liveThreshold;
        const roleIDs = isLive ? [] : this.options.seedingAnnouncementRoles;
        await this.sendOnce(
          'seedingAnnouncementDate',
          cycleDate,
          () =>
            this.sendDiscordMessage(
              this.buildAnnouncement(
                roleIDs,
                isLive
                  ? this.options.alreadyLiveAnnouncementMessage
                  : this.options.seedingAnnouncementMessage,
                playerCount
              )
            ),
          'scheduled seeding announcement'
        );
      }

      if (playerCount >= this.options.liveThreshold) {
        await this.sendOnce(
          'liveAnnouncementDate',
          cycleDate,
          () =>
            this.sendDiscordMessage(
              this.buildAnnouncement(
                this.options.liveAnnouncementRoles,
                this.options.liveAnnouncementMessage,
                playerCount
              )
            ),
          'live announcement'
        );
      }
    } finally {
      this.processingServerInfo = false;
    }
  }

  async checkRestartWarning() {
    const now = this.now();
    const remainingMinutes = minutesUntilDailyTime(
      now,
      this.options.restartTime,
      this.options.timeZone,
      'restartTime'
    );
    if (!RESTART_WARNING_MINUTES.has(remainingMinutes)) return;

    const cycleDate = getLocalDateKey(now, this.options.timeZone);
    const unit = remainingMinutes === 1 ? 'minute' : 'minutes';
    await this.sendOnce(
      `restartWarning${remainingMinutes}Date`,
      cycleDate,
      () => this.server.rcon.broadcast(`Server restart in ${remainingMinutes} ${unit}.`),
      `${remainingMinutes}-${unit} restart warning`
    );
  }

  roleMentions(roleIDs) {
    return roleIDs.map((roleID) => `<@&${roleID}>`).join(' ');
  }

  formatTemplate(template, playerCount) {
    return template
      .replaceAll('{{server.players}}', String(playerCount))
      .replaceAll('{{server.name}}', this.server.serverName || 'Unknown Server');
  }

  buildAnnouncement(roleIDs, message, playerCount) {
    const roleMentions = this.roleMentions(roleIDs);
    return {
      content: `${this.formatTemplate(message, playerCount)}${
        roleMentions ? `\n\n-# ${roleMentions}` : ''
      }`,
      embeds: [
        {
          description: this.formatTemplate(this.options.announcementEmbedDescription, playerCount)
        }
      ],
      allowedMentions: { roles: roleIDs }
    };
  }

  async sendOnce(stateField, cycleDate, send, label) {
    if (this.state[stateField] === cycleDate || this.sending.has(stateField)) return false;

    const previousValue = this.state[stateField];
    this.sending.add(stateField);
    this.state[stateField] = cycleDate;

    if (!(await this.saveState())) {
      this.restoreStateField(stateField, previousValue);
      this.sending.delete(stateField);
      return false;
    }

    try {
      await send();
      this.verbose(1, `Sent ${label}.`);
      return true;
    } catch (error) {
      this.restoreStateField(stateField, previousValue);
      await this.saveState();
      this.verbose(1, `Could not send ${label}. Error: ${error.message}`);
      return false;
    } finally {
      this.sending.delete(stateField);
    }
  }

  restoreStateField(stateField, previousValue) {
    if (typeof previousValue === 'undefined') delete this.state[stateField];
    else this.state[stateField] = previousValue;
  }
}
