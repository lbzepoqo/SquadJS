import { escapeMarkdown } from 'discord.js';

import DiscordBasePlugin from './discord-base-plugin.js';
import { presenceCredits, utcDay } from './seeding-points/points.js';
import {
  defineSeedingDay,
  fetchDayLeaderboard,
  readDay,
  writeDay
} from './seeding-points/store.js';

// SquadJS does not unmount plugins on exit, so points not yet saved are lost at a restart.
const SAVE_INTERVAL_MS = 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
// Discord rejects an embed description over 4096 characters.
const EMBED_DESCRIPTION_LIMIT = 4000;

export default class SeedingPoints extends DiscordBasePlugin {
  static get description() {
    return (
      'The <code>SeedingPoints</code> plugin gives players points for every minute they are on the server ' +
      'while it is seeding, with a higher multiplier at lower player counts, where seeding is hardest. A ' +
      'minute counts only when the player was active recently (spawned, changed squad, chatted, hit or ' +
      'revived someone, or created a squad), so idle players do not collect points. Points are stored per ' +
      'player (by EOS ID) and UTC day, and the day leaderboard can be posted to Discord. The points give no ' +
      'reward by themselves.'
    );
  }

  static get defaultEnabled() {
    return false;
  }

  static get optionsSpecification() {
    return {
      ...DiscordBasePlugin.optionsSpecification,
      database: {
        required: true,
        connector: 'sequelize',
        description: 'The Sequelize connector that stores the points.',
        default: 'sqlite'
      },
      seedingStartPlayerCount: {
        required: false,
        description: 'Lowest player count at which the server counts as seeding.',
        default: 1
      },
      livePlayerCount: {
        required: false,
        description:
          'Player count at which the server counts as live. Seeding is from the start count up to one below this.',
        default: 35
      },
      multipliers: {
        required: false,
        description:
          'Points per minute by player count. Each band applies from its <code>minimumPlayers</code> up to the ' +
          'next band.',
        default: [
          { minimumPlayers: 1, multiplier: 3 },
          { minimumPlayers: 5, multiplier: 2 },
          { minimumPlayers: 10, multiplier: 1.5 },
          { minimumPlayers: 20, multiplier: 1 }
        ]
      },
      activityWindowMinutes: {
        required: false,
        description:
          'A minute counts only when the player was active within this many minutes. Joining counts as ' +
          'activity, and so does joining a squad, but not being removed from one. 0 counts every minute.',
        default: 15
      },
      channelID: {
        required: false,
        description:
          'ID of the channel for the daily leaderboard. Leave empty to post no leaderboard. The Discord ' +
          'connector is required either way.',
        default: '',
        example: '667741905228136459'
      },
      leaderboardHourUTC: {
        required: false,
        description:
          'UTC hour (0 to 23) at which the leaderboard of the previous UTC day is posted. A restart over that ' +
          'hour skips the post for that day.',
        default: 1
      },
      leaderboardSize: {
        required: false,
        description: 'Number of players in the daily leaderboard.',
        default: 10
      },
      color: {
        required: false,
        description: 'The color of the leaderboard embed.',
        default: 3066993
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.SeedingDay = defineSeedingDay(this.options.database);
    this.settings = {
      seedingStartPlayerCount: this.options.seedingStartPlayerCount,
      livePlayerCount: this.options.livePlayerCount,
      multipliers: this.options.multipliers,
      activityWindowMs: this.options.activityWindowMinutes * 60 * 1000
    };
    this.previousUpdate = null;
    this.lastActivityAt = new Map();
    this.lastSeenAt = new Map();
    this.pending = new Map();
    this.dayTotals = new Map();
    this.saveChain = Promise.resolve();
    this.saveInterval = null;
    this.leaderboardTimer = null;
    this.leaderboardInterval = null;

    this.onUpdatedPlayerInfo = this.onUpdatedPlayerInfo.bind(this);
    this.onPlayerActivity = this.onPlayerActivity.bind(this);
    this.onSquadChange = this.onSquadChange.bind(this);
    this.onChatMessage = this.onChatMessage.bind(this);
    this.onAttackerActivity = this.onAttackerActivity.bind(this);
    this.onPlayerRevived = this.onPlayerRevived.bind(this);
    this.save = this.save.bind(this);
  }

  async prepareToMount() {
    await this.SeedingDay.sync();
    if (this.options.channelID) await super.prepareToMount();
  }

  async mount() {
    this.server.on('UPDATED_PLAYER_INFORMATION', this.onUpdatedPlayerInfo);
    this.server.on('PLAYER_POSSESS', this.onPlayerActivity);
    this.server.on('PLAYER_SQUAD_CHANGE', this.onSquadChange);
    this.server.on('SQUAD_CREATED', this.onPlayerActivity);
    this.server.on('CHAT_MESSAGE', this.onChatMessage);
    this.server.on('PLAYER_DAMAGED', this.onAttackerActivity);
    this.server.on('PLAYER_WOUNDED', this.onAttackerActivity);
    this.server.on('PLAYER_REVIVED', this.onPlayerRevived);
    this.saveInterval = setInterval(this.save, SAVE_INTERVAL_MS);
    if (this.options.channelID) this.scheduleLeaderboard();
  }

  async unmount() {
    this.server.removeListener('UPDATED_PLAYER_INFORMATION', this.onUpdatedPlayerInfo);
    this.server.removeListener('PLAYER_POSSESS', this.onPlayerActivity);
    this.server.removeListener('PLAYER_SQUAD_CHANGE', this.onSquadChange);
    this.server.removeListener('SQUAD_CREATED', this.onPlayerActivity);
    this.server.removeListener('CHAT_MESSAGE', this.onChatMessage);
    this.server.removeListener('PLAYER_DAMAGED', this.onAttackerActivity);
    this.server.removeListener('PLAYER_WOUNDED', this.onAttackerActivity);
    this.server.removeListener('PLAYER_REVIVED', this.onPlayerRevived);
    clearInterval(this.saveInterval);
    clearTimeout(this.leaderboardTimer);
    clearInterval(this.leaderboardInterval);
    await this.save();
  }

  markActive(eosID) {
    if (eosID) this.lastActivityAt.set(eosID, Date.now());
  }

  onPlayerActivity(data) {
    this.markActive(data.player?.eosID ?? data.playerEOSID);
  }

  // The event comes from comparing two player lists, so it also fires when a squad is disbanded or a player is
  // removed from it. Only joining a squad is the player's own action.
  onSquadChange(data) {
    if (data.newSquadID !== null && data.newSquadID !== undefined)
      this.markActive(data.player?.eosID);
  }

  onChatMessage(data) {
    this.markActive(data.player?.eosID ?? data.eosID);
  }

  onAttackerActivity(data) {
    this.markActive(data.attacker?.eosID ?? data.attackerEOSID);
  }

  onPlayerRevived(data) {
    this.markActive(data.reviver?.eosID ?? data.reviverEOSID);
  }

  onUpdatedPlayerInfo() {
    const now = Date.now();
    const players = this.server.players;

    // Joining counts as activity. A player missing from one list (RCON can return an empty list while players
    // are connected) is still known when the list is complete again, so the gap is not counted as a new join.
    for (const player of players) {
      if (!player.eosID) continue;
      this.lastSeenAt.set(player.eosID, now);
      if (!this.lastActivityAt.has(player.eosID)) this.lastActivityAt.set(player.eosID, now);
    }

    const credits = presenceCredits({
      previousUpdate: this.previousUpdate,
      players,
      now,
      lastActivityAt: this.lastActivityAt,
      settings: this.settings
    });
    const day = utcDay(now);
    for (const { player, minutes, points } of credits) {
      this.addPending({
        eosID: player.eosID,
        day,
        steamID: player.steamID ?? null,
        name: player.name ?? null,
        minutes,
        points
      });
    }

    const eosIDs = new Set(players.map((player) => player.eosID).filter(Boolean));
    this.previousUpdate = { time: now, playerCount: players.length, eosIDs };

    // A player gone for longer than the window counts as joining again when they return.
    for (const [eosID, lastActive] of this.lastActivityAt) {
      const lastSeen = this.lastSeenAt.get(eosID) ?? lastActive;
      if (now - Math.max(lastSeen, lastActive) > this.settings.activityWindowMs) {
        this.lastActivityAt.delete(eosID);
        this.lastSeenAt.delete(eosID);
      }
    }
  }

  // Writes the points collected up to this call. Saves run one after another, so a caller that awaits a save
  // started while another was running still gets its points written. A failed write is retried by the next
  // save.
  save() {
    this.saveChain = this.saveChain.then(() => this.writePending());
    return this.saveChain;
  }

  // Adds the pending points to each player's day totals and writes the totals that changed. A total is read
  // from the table the first time it is needed after a start, and stays in memory until its day is over and
  // it is written.
  async writePending() {
    const deltas = [...this.pending.values()];
    this.pending = new Map();
    let failure = null;

    for (const delta of deltas) {
      const key = `${delta.eosID}|${delta.day}`;
      let total = this.dayTotals.get(key);
      if (!total) {
        try {
          total = (await readDay(this.SeedingDay, delta.eosID, delta.day)) ?? {
            eosID: delta.eosID,
            day: delta.day,
            steamID: null,
            name: null,
            minutes: 0,
            points: 0
          };
        } catch (error) {
          failure = error;
          this.addPending(delta);
          continue;
        }
        this.dayTotals.set(key, total);
      }
      total.minutes += delta.minutes;
      total.points += delta.points;
      total.steamID = delta.steamID ?? total.steamID;
      total.name = delta.name ?? total.name;
      total.unsaved = true;
    }

    const today = utcDay(Date.now());
    for (const [key, total] of this.dayTotals) {
      if (total.unsaved) {
        try {
          await writeDay(this.SeedingDay, total);
          total.unsaved = false;
        } catch (error) {
          failure = error;
        }
      }
      if (!total.unsaved && total.day < today) this.dayTotals.delete(key);
    }

    if (failure) this.verbose(1, `Could not save seeding points: ${failure.message}`);
  }

  addPending(credit) {
    const key = `${credit.eosID}|${credit.day}`;
    const entry = this.pending.get(key);
    if (!entry) {
      this.pending.set(key, { ...credit });
      return;
    }
    entry.minutes += credit.minutes;
    entry.points += credit.points;
    entry.steamID = credit.steamID ?? entry.steamID;
    entry.name = credit.name ?? entry.name;
  }

  scheduleLeaderboard() {
    const now = new Date();
    const next = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        this.options.leaderboardHourUTC
      )
    );
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    this.leaderboardTimer = setTimeout(() => {
      this.postLeaderboard();
      this.leaderboardInterval = setInterval(() => this.postLeaderboard(), MS_PER_DAY);
    }, next.getTime() - now.getTime());
  }

  async postLeaderboard() {
    try {
      const day = utcDay(Date.now() - MS_PER_DAY);
      const rows = await fetchDayLeaderboard(this.SeedingDay, day, this.options.leaderboardSize);
      const lines = rows.map(
        (row, index) =>
          `${index + 1}. ${escapeMarkdown(row.name ?? row.eosID)}: ${Math.round(
            row.points
          )} pts, ${Math.round(row.minutes)} min`
      );
      while (lines.join('\n').length > EMBED_DESCRIPTION_LIMIT) lines.pop();
      await this.sendDiscordMessage({
        embed: {
          title: `Seeding points, ${day} (UTC)`,
          color: this.options.color,
          description: lines.length > 0 ? lines.join('\n') : 'No seeding points that day.'
        }
      });
    } catch (error) {
      this.verbose(1, `Could not post the seeding leaderboard: ${error.message}`);
    }
  }
}
