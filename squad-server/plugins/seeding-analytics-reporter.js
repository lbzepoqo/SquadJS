import { promises as fs } from 'fs';
import axios from 'axios';
import DiscordBasePlugin from './discord-base-plugin.js';
import { COPYRIGHT_MESSAGE } from '../utils/constants.js';

const SAVE_DEBOUNCE_MS = 2000;
const API_TIMEOUT_MS = 10000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_SNAPSHOTS = 14;
// Enough for recommendationWindowDays: with a start count of 1, a single player at night opens a phase.
const MAX_PHASES = 200;
const TRACKER_RESUME_MS = 10 * 60 * 1000;
const TRACKER_SAVE_INTERVAL_MS = 5 * 60 * 1000;
const CATCH_UP_DELAY_MS = 60 * 1000;

function emptyState() {
  return { snapshots: [], phases: [], alertedStuck: [], lastReportTs: null };
}

export default class SeedingAnalyticsReporter extends DiscordBasePlugin {
  static get description() {
    return 'Posts daily seeding analytics to Discord: leaderboard, stuck-player alerts, phase stats, and config recommendations.';
  }

  static get defaultEnabled() {
    return false;
  }

  static get optionsSpecification() {
    return {
      ...DiscordBasePlugin.optionsSpecification,
      channelID: {
        required: true,
        description: 'Discord channel ID for daily reports.',
        default: ''
      },
      whitelisterApiUrl: {
        required: true,
        description: 'Base URL of the Squad Whitelister API.',
        default: 'http://your-api-url.com'
      },
      whitelisterApiKey: {
        required: true,
        description: 'API key for the Squad Whitelister.',
        default: ''
      },
      reportHourUTC: {
        required: false,
        description: 'UTC hour (0 to 23) at which to post the daily report.',
        default: 12
      },
      leaderboardSize: {
        required: false,
        description:
          'Number of players in the leaderboard, ranked by seeding points gained since the previous report.',
        default: 10
      },
      recommendationWindowDays: {
        required: false,
        description: 'Rolling window of past days used for config recommendations.',
        default: 7
      },
      dataFile: {
        required: false,
        description: 'Path to the JSON state file for persisting snapshots and phase history.',
        default: './seeding-analytics-state.json'
      },
      seedAlertedStuckFile: {
        required: false,
        description:
          'Path to a JSON array of Steam IDs that are already handled, so they are not reported as stuck on the first run.',
        default: null
      },
      phaseAbortGraceMinutes: {
        required: false,
        description:
          'Minutes the player count must stay below seeding_start_player_count before a seeding phase counts as aborted, or a live server counts as empty.',
        default: 5
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);
    this.state = emptyState();
    this.saveDebounceTimer = null;
    this.reportTimer = null;
    this.reportInterval = null;
    this.catchUpTimer = null;

    this.tracker = null;
    this.lastTrackerSaveAt = 0;
    this.phaseLiveConfig = null;

    this.boundOnUpdatedPlayerInfo = this.onUpdatedPlayerInfo.bind(this);
  }

  async prepareToMount() {
    await super.prepareToMount();
    await this.loadState();
    if (this.options.seedAlertedStuckFile) {
      await this.seedAlertedStuck();
    }
  }

  async mount() {
    this.resumeTracker();
    this.server.on('UPDATED_PLAYER_INFORMATION', this.boundOnUpdatedPlayerInfo);
    this.scheduleReport();
    // The leaderboard compares with the previous snapshot, so the first report needs one to start from.
    if (this.state.snapshots.length === 0) this.takeBaselineSnapshot();
  }

  async unmount() {
    this.server.removeListener('UPDATED_PLAYER_INFORMATION', this.boundOnUpdatedPlayerInfo);
    if (this.reportTimer) clearTimeout(this.reportTimer);
    if (this.reportInterval) clearInterval(this.reportInterval);
    if (this.catchUpTimer) clearTimeout(this.catchUpTimer);
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
      await this.saveState();
    }
  }

  async loadState() {
    try {
      const raw = await fs.readFile(this.options.dataFile, 'utf8');
      // Keys missing in a file from an older version get their empty value.
      this.state = { ...emptyState(), ...JSON.parse(raw) };
      this.verbose(1, `Loaded state from ${this.options.dataFile}`);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.verbose(1, `Error loading state: ${error.message}. Starting fresh.`);
      }
      this.state = emptyState();
    }
  }

  scheduleSave() {
    if (this.saveDebounceTimer) clearTimeout(this.saveDebounceTimer);
    this.saveDebounceTimer = setTimeout(() => this.saveState(), SAVE_DEBOUNCE_MS);
  }

  // Written to a temporary file and renamed, so a restart during the write cannot leave a broken state file.
  async saveState() {
    const temporaryFile = `${this.options.dataFile}.tmp`;
    try {
      await fs.writeFile(temporaryFile, JSON.stringify(this.state, null, 2), 'utf8');
      await fs.rename(temporaryFile, this.options.dataFile);
    } catch (error) {
      this.verbose(1, `Error saving state: ${error.message}`);
    }
  }

  async seedAlertedStuck() {
    try {
      const raw = await fs.readFile(this.options.seedAlertedStuckFile, 'utf8');
      const steamIDs = JSON.parse(raw);
      if (!Array.isArray(steamIDs)) return;
      const existing = new Set(this.state.alertedStuck);
      for (const steamID of steamIDs) existing.add(steamID);
      this.state.alertedStuck = [...existing];
      this.scheduleSave();
      this.verbose(
        1,
        `Seeded ${steamIDs.length} steamIDs into alertedStuck from ${this.options.seedAlertedStuckFile}.`
      );
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.verbose(1, `Error reading seedAlertedStuckFile: ${error.message}`);
      }
    }
  }

  async apiGet(path) {
    const url = `${this.options.whitelisterApiUrl}${path}?apiKey=${this.options.whitelisterApiKey}`;
    try {
      const response = await axios.get(url, { timeout: API_TIMEOUT_MS });
      return response.data;
    } catch (error) {
      this.verbose(2, `API GET ${path} failed (${error.message}), retrying once.`);
      const response = await axios.get(url, { timeout: API_TIMEOUT_MS });
      return response.data;
    }
  }

  fetchPlayers() {
    return this.apiGet('/api/seeding/read/getPlayers');
  }

  fetchConfig() {
    return this.apiGet('/api/dbconfig/read/seeding_tracker');
  }

  // The tracker follows the Whitelister's seeding tracker, which counts seeding while
  // seeding_start_player_count <= players <= seeding_player_threshold. A phase starts when the server enters
  // that range from idle, and ends as "live" above the threshold or as "aborted" when the count stays below the
  // start count for phaseAbortGraceMinutes. A live server returns to idle only when it empties the same way,
  // so a dip below the threshold or an evening decline does not start a new phase.
  async onUpdatedPlayerInfo() {
    const count = this.server.players.length;
    const now = Date.now();

    if (!this.phaseLiveConfig) {
      try {
        this.phaseLiveConfig = await this.fetchConfig();
      } catch {
        return;
      }
    }

    const startThreshold = Number(this.phaseLiveConfig.seeding_start_player_count) || 2;
    const liveThreshold = Number(this.phaseLiveConfig.seeding_player_threshold);
    if (!liveThreshold) return;

    const trackerBefore = trackerFingerprint(this.tracker);
    await this.advanceTracker(count, now, startThreshold, liveThreshold);
    this.tracker.updatedAt = now;
    // The state file is saved when the tracker changes, and at least every TRACKER_SAVE_INTERVAL_MS so a
    // restart finds a recent updatedAt.
    if (
      trackerFingerprint(this.tracker) !== trackerBefore ||
      now - this.lastTrackerSaveAt >= TRACKER_SAVE_INTERVAL_MS
    ) {
      this.lastTrackerSaveAt = now;
      this.scheduleSave();
    }
  }

  async advanceTracker(count, now, startThreshold, liveThreshold) {
    const tracker = this.tracker;

    if (tracker.status === 'unknown') {
      if (count > liveThreshold) tracker.status = 'live';
      else if (count < startThreshold) tracker.status = 'idle';
      return;
    }

    if (tracker.status === 'idle') {
      if (count > liveThreshold) {
        tracker.status = 'live';
        this.verbose(1, `Server is live with ${count} players; no seeding phase recorded.`);
      } else if (count >= startThreshold) {
        Object.assign(tracker, {
          status: 'seeding',
          phaseStart: now,
          phasePeak: count,
          seeders: this.server.players.map((player) => player.steamID),
          belowStartSince: null
        });
        // Refresh the config at the start of each phase.
        try {
          this.phaseLiveConfig = await this.fetchConfig();
        } catch {
          // Keep the cached config.
        }
        this.verbose(1, `Seeding phase started with ${count} players.`);
      }
      return;
    }

    if (count >= startThreshold) {
      tracker.belowStartSince = null;
    } else if (tracker.belowStartSince === null) {
      tracker.belowStartSince = now;
    }
    const graceMs = this.options.phaseAbortGraceMinutes * 60 * 1000;
    const emptiedAt =
      tracker.belowStartSince !== null && now - tracker.belowStartSince >= graceMs
        ? tracker.belowStartSince
        : null;

    if (tracker.status === 'live') {
      if (emptiedAt !== null) {
        this.resetTracker();
        this.verbose(1, 'Server emptied after being live.');
      }
      return;
    }

    // status 'seeding'
    tracker.phasePeak = Math.max(tracker.phasePeak, count);
    const seeders = new Set(tracker.seeders);
    for (const player of this.server.players) seeders.add(player.steamID);
    tracker.seeders = [...seeders];

    if (count > liveThreshold) {
      this.commitPhase('live', now);
      this.tracker.status = 'live';
    } else if (emptiedAt !== null) {
      this.commitPhase('aborted', emptiedAt);
    }
  }

  resetTracker() {
    this.tracker = {
      status: 'idle',
      phaseStart: null,
      phasePeak: 0,
      seeders: [],
      belowStartSince: null,
      updatedAt: null
    };
    this.state.tracker = this.tracker;
  }

  // A tracker saved shortly before a restart continues. Otherwise the status is unknown until the count is
  // below the start count or above the threshold, so a phase whose start was missed is not recorded.
  resumeTracker() {
    const saved = this.state.tracker;
    if (saved && saved.updatedAt && Date.now() - saved.updatedAt <= TRACKER_RESUME_MS) {
      this.tracker = saved;
      this.verbose(1, `Resumed phase tracker in status ${saved.status}.`);
    } else {
      this.resetTracker();
      this.tracker.status = 'unknown';
    }
  }

  commitPhase(outcome, endTime) {
    const tracker = this.tracker;
    const durationMs = endTime - tracker.phaseStart;

    this.state.phases.push({
      date: new Date(endTime).toISOString().slice(0, 10),
      startTs: new Date(tracker.phaseStart).toISOString(),
      endTs: new Date(endTime).toISOString(),
      outcome,
      durationMs,
      peakCount: tracker.phasePeak,
      uniqueSeederCount: tracker.seeders.length,
      timeToLiveMs: outcome === 'live' ? durationMs : null
    });

    if (this.state.phases.length > MAX_PHASES) {
      this.state.phases = this.state.phases.slice(-MAX_PHASES);
    }

    this.verbose(
      1,
      `Seeding phase ended: ${outcome}, ${Math.round(durationMs / 60000)}min, peak ${
        tracker.phasePeak
      }, ${tracker.seeders.length} seeders.`
    );
    this.resetTracker();
  }

  async takeSnapshot() {
    let players, config;
    try {
      [players, config] = await Promise.all([this.fetchPlayers(), this.fetchConfig()]);
    } catch (error) {
      this.verbose(1, `Snapshot fetch failed: ${error.message}`);
      return { players: null, config: null, newStuck: [], previousSnapshot: null };
    }
    this.verbose(2, `Raw config: ${JSON.stringify(config)}`);

    const previousSnapshot = this.state.snapshots.at(-1) ?? null;
    const newStuck = detectStuck(
      players,
      previousSnapshot,
      this.state.alertedStuck,
      config,
      this.state.phases
    );

    this.recordSnapshot(players);
    this.verbose(1, `Snapshot taken: ${players.length} players, ${newStuck.length} new stuck.`);
    return { players, config, newStuck, previousSnapshot };
  }

  async takeBaselineSnapshot() {
    try {
      const players = await this.fetchPlayers();
      if (this.state.snapshots.length > 0) return;
      this.recordSnapshot(players);
      this.verbose(1, `Baseline snapshot taken: ${players.length} players.`);
    } catch (error) {
      this.verbose(1, `Baseline snapshot failed: ${error.message}`);
    }
  }

  recordSnapshot(players) {
    this.state.snapshots.push({
      ts: new Date().toISOString(),
      players: players.map((player) => ({
        steamid64: player.steamid64,
        username: player.username,
        seeding_points: player.seeding_points,
        latest_seeding_activity: player.latest_seeding_activity ?? null
      }))
    });
    if (this.state.snapshots.length > MAX_SNAPSHOTS) {
      this.state.snapshots = this.state.snapshots.slice(-MAX_SNAPSHOTS);
    }
    this.scheduleSave();
  }

  async buildAndPostReport() {
    // sendDiscordMessage returns without an error when the channel is missing.
    if (!this.channel) {
      this.verbose(1, 'Report skipped: the Discord channel is not available.');
      return;
    }

    const { players, config, newStuck, previousSnapshot } = await this.takeSnapshot();

    const today = new Date().toISOString().slice(0, 10);
    const requiredPoints = resolveRewardThreshold(config);

    const leaderboardLines = players
      ? buildLeaderboardLines(
          players,
          previousSnapshot,
          requiredPoints,
          this.options.leaderboardSize
        )
      : ['Could not fetch player data.'];

    const configLines = config
      ? [
          `reward_needed_time: **${formatDuration(
            config.reward_needed_time
          )}** (${resolveRewardThreshold(config)}pts threshold)`,
          `time_deduction: **${formatDeduction(config.time_deduction)}**`,
          `minimum_reward_duration: **${
            formatDuration(config.minimum_reward_duration) ?? 'not set'
          }**`,
          `seeding_player_threshold: **${config.seeding_player_threshold}**`,
          `seeding_start_player_count: **${config.seeding_start_player_count}**`,
          `tracking_mode: **${config.tracking_mode ?? 'N/A'}**`
        ]
      : ['Could not fetch config.'];

    // Phases that ended since the previous report, so a phase on the morning of the report day is included.
    const reportedUntil =
      this.state.lastReportTs ?? new Date(Date.now() - MS_PER_DAY).toISOString();
    const recentPhases = this.state.phases.filter((phase) => phase.endTs > reportedUntil);
    const phaseLines =
      recentPhases.length > 0
        ? recentPhases.map((phase) => {
            const startUnix = Math.floor(new Date(phase.startTs).getTime() / 1000);
            const endUnix = Math.floor(new Date(phase.endTs).getTime() / 1000);
            const durationMinutes = Math.round(phase.durationMs / 60000);
            const outcomeText =
              phase.timeToLiveMs != null
                ? `${Math.round(phase.timeToLiveMs / 60000)}min to live`
                : 'aborted';
            return `<t:${startUnix}:t> → <t:${endUnix}:t> · ${durationMinutes}min · peak ${phase.peakCount} · ${phase.uniqueSeederCount} seeders · ${outcomeText}`;
          })
        : ['No seeding phase since the last report.'];

    const stuckLines =
      newStuck.length > 0
        ? [
            `${newStuck.length} new stuck player${newStuck.length !== 1 ? 's' : ''}:`,
            ...newStuck
              .slice(0, 10)
              .map(
                (player) =>
                  `• ${player.username ?? player.steamid64} — ${player.seeding_points.toFixed(
                    1
                  )}pts`
              ),
            ...(newStuck.length > 10
              ? [`…and ${newStuck.length - 10} more — check ${this.options.dataFile}`]
              : [])
          ]
        : null;

    const windowDays = this.options.recommendationWindowDays;
    const cutoff = new Date(Date.now() - windowDays * MS_PER_DAY).toISOString();
    const windowPhases = this.state.phases.filter((phase) => phase.startTs >= cutoff);
    const recommendations = config
      ? buildRecommendations(config, windowPhases, this.state.snapshots, cutoff)
      : [];
    const recommendationLines =
      recommendations.length > 0 ? recommendations : ['✅ Config matches observed pattern.'];

    const leaderboardEmbeds = chunkEmbeds(
      `Top ${this.options.leaderboardSize} Seeders Since the Last Report (${today} UTC)`,
      leaderboardLines.length ? leaderboardLines : ['No data.'],
      0xf1c40f
    );

    const summaryEmbeds = [
      {
        title: 'Active Whitelister Config',
        color: 0x95a5a6,
        description: configLines.join('\n')
      },
      // A long gap between reports can list many phases, so they are split like the leaderboard.
      ...chunkEmbeds('Seeding Phases Since the Last Report', phaseLines, 0x3498db),
      ...(stuckLines
        ? [
            {
              title: 'New Stuck-Player Alerts',
              color: 0xe74c3c,
              description: stuckLines.join('\n')
            }
          ]
        : []),
      {
        title: `Config Recommendations (${windowDays}-day window)`,
        color: recommendations.length > 0 ? 0xe67e22 : 0x2ecc71,
        description: recommendationLines.join('\n'),
        footer: { text: COPYRIGHT_MESSAGE },
        timestamp: new Date().toISOString()
      }
    ];

    const messages = packEmbeds([...leaderboardEmbeds, ...summaryEmbeds]);
    for (const embeds of messages) await this.sendDiscordMessage({ embeds });
    if (messages.length > 1) this.verbose(1, `Report split into ${messages.length} messages.`);

    // Marked only after the report is posted, so a failed post reports these players again.
    for (const player of newStuck) {
      this.state.alertedStuck.push(player.steamid64);
    }
    this.state.lastReportTs = new Date().toISOString();
    this.scheduleSave();
    this.verbose(1, 'Daily seeding report posted.');
  }

  scheduleReport() {
    const msUntilNext = msUntilHourUTC(this.options.reportHourUTC);
    this.verbose(
      1,
      `Daily report scheduled in ${Math.round(msUntilNext / 60000)} minutes (UTC ${
        this.options.reportHourUTC
      }:00).`
    );
    this.reportTimer = setTimeout(() => {
      this.reportTimer = null;
      this.runReport();
      this.reportInterval = setInterval(() => this.runReport(), MS_PER_DAY);
    }, msUntilNext);

    // A restart over the report hour would skip that day's report.
    const previousReportTime = Date.now() + msUntilNext - MS_PER_DAY;
    if (this.state.lastReportTs && Date.parse(this.state.lastReportTs) < previousReportTime) {
      this.verbose(1, 'The last scheduled report was missed; posting it after the start delay.');
      this.catchUpTimer = setTimeout(() => {
        this.catchUpTimer = null;
        this.runReport();
      }, CATCH_UP_DELAY_MS);
    }
  }

  runReport() {
    this.buildAndPostReport().catch((error) => this.verbose(1, `Report error: ${error.message}`));
  }
}

function chunkEmbeds(title, lines, color, descriptionLimit = 3800) {
  const embeds = [];
  let buffer = '';
  let part = 0;
  for (const line of lines) {
    const candidate = buffer ? `${buffer}\n${line}` : line;
    const safeLine =
      line.length > descriptionLimit ? `${line.slice(0, descriptionLimit - 1)}…` : line;
    if (candidate.length > descriptionLimit && buffer) {
      embeds.push({
        title: part === 0 ? title : `${title} (cont. ${part + 1})`,
        color,
        description: buffer
      });
      part++;
      buffer = safeLine;
    } else {
      buffer = buffer ? `${buffer}\n${safeLine}` : safeLine;
    }
  }
  if (buffer) {
    embeds.push({
      title: part === 0 ? title : `${title} (cont. ${part + 1})`,
      color,
      description: buffer
    });
  }
  if (embeds.length === 0) {
    embeds.push({ title, color, description: '—' });
  }
  return embeds;
}

// Discord accepts at most 10 embeds and 6000 characters per message. chunkEmbeds keeps every description
// under 3800 characters, so each embed fits into a message of its own.
function packEmbeds(embeds) {
  const messages = [];
  let current = [];
  let currentCharacters = 0;
  for (const embed of embeds) {
    const characters =
      (embed.title?.length ?? 0) +
      (embed.description?.length ?? 0) +
      (embed.footer?.text?.length ?? 0);
    if (current.length === 10 || currentCharacters + characters > 5900) {
      messages.push(current);
      current = [];
      currentCharacters = 0;
    }
    current.push(embed);
    currentCharacters += characters;
  }
  if (current.length > 0) messages.push(current);
  return messages;
}

// Ranks by points gained since the previous snapshot. Banked points have no upper limit, so a ranking by
// total points shows the same players every day, also players who stopped seeding weeks ago. A player who
// is not in the previous snapshot had fewer than 1 point then. The gain is net of deductions.
function buildLeaderboardLines(players, previousSnapshot, requiredPoints, size) {
  if (!previousSnapshot)
    return ['No previous snapshot yet. The next report shows the points gained.'];

  const previousPoints = new Map(
    previousSnapshot.players.map((player) => [player.steamid64, player.seeding_points])
  );
  const ranked = players
    .map((player) => ({
      player,
      gained: player.seeding_points - (previousPoints.get(player.steamid64) ?? 0)
    }))
    .filter((entry) => entry.gained > 0)
    .sort((first, second) => second.gained - first.gained)
    .slice(0, size);
  if (ranked.length === 0) return ['No player gained seeding points since the last report.'];

  const since = Math.floor(Date.parse(previousSnapshot.ts) / 1000);
  return [
    `Points gained since <t:${since}:f>:`,
    ...ranked.map(({ player, gained }, index) => {
      const percent = Math.round((player.seeding_points / requiredPoints) * 100);
      return `**${index + 1}.** ${player.username ?? player.steamid64} — +${gained.toFixed(
        1
      )}pts · total ${player.seeding_points.toFixed(1)}pts (${percent}%)`;
    })
  ];
}

function trackerFingerprint(tracker) {
  return JSON.stringify({ ...tracker, updatedAt: null });
}

function msUntilHourUTC(hourUTC) {
  const now = new Date();
  const target = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUTC, 0, 0, 0)
  );
  if (target <= now) target.setUTCDate(target.getUTCDate() + 1);
  return target.getTime() - now.getTime();
}

// reward_needed_time { value: 2, option: 3600000 } is 2 x 60 minutes, so the threshold is 120 points
// (the Whitelister adds one point per seeding minute).
function resolveRewardThreshold(config) {
  const field = config?.reward_needed_time;
  if (!field) return 120;
  if (typeof field === 'number') return field;
  if (
    typeof field === 'object' &&
    typeof field.value === 'number' &&
    typeof field.option === 'number'
  ) {
    return field.value * (field.option / 60000);
  }
  const threshold = Number(field);
  return isNaN(threshold) ? 120 : threshold;
}

// Whitelister durations are { value, option } with option in milliseconds, for example { value: 2, option: 3600000 }.
function formatDuration(field) {
  const durationMs = durationToMs(field);
  if (durationMs === null) {
    return field === null || field === undefined ? null : safeConfigDisplay(field);
  }
  const minutes = durationMs / 60000;
  return minutes % 60 === 0 ? `${minutes / 60}h (${minutes}min)` : `${minutes}min`;
}

// The Whitelister deducts value points per minute (point_minute) or value percent of the reward threshold
// per minute (perc_minute).
function formatDeduction(field) {
  if (field?.option === 'point_minute') return `${field.value} points/min`;
  if (field?.option === 'perc_minute') return `${field.value}% of the threshold/min`;
  return safeConfigDisplay(field);
}

function safeConfigNum(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'number') return value;
  const candidate =
    typeof value === 'object'
      ? value.value ?? value.current ?? value.minutes ?? value.points ?? null
      : value;
  const number = Number(candidate);
  return isNaN(number) ? fallback : number;
}

function safeConfigDisplay(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return String(value);
  const number = safeConfigNum(value);
  return number !== null ? String(number) : JSON.stringify(value);
}

// A rewarded player is stuck when the Whitelister stops deducting their points. In incremental mode it deducts
// points during seeding from offline players whose latest_seeding_activity is older than
// minimum_reward_duration. A null date never matches that filter, so such a player keeps the reward forever.
// Otherwise a player is stuck when the points did not fall since the previous snapshot although a seeding phase
// ran after the player's last activity plus minimum_reward_duration.
function detectStuck(currentPlayers, previousSnapshot, alertedStuck, config, phases) {
  if (config?.tracking_mode !== 'incremental') return [];

  const requiredPoints = resolveRewardThreshold(config);
  const minimumRewardMs = durationToMs(config.minimum_reward_duration) ?? 0;
  const alerted = new Set(alertedStuck);
  const previousByID = new Map(
    (previousSnapshot?.players ?? []).map((player) => [player.steamid64, player])
  );
  const previousTime = previousSnapshot ? Date.parse(previousSnapshot.ts) : null;

  return currentPlayers.filter((player) => {
    if (player.seeding_points < requiredPoints || alerted.has(player.steamid64)) return false;

    const activity = player.latest_seeding_activity ?? null;
    if (activity === null) return true;

    const previous = previousByID.get(player.steamid64);
    if (!previous || previousTime === null) return false;
    if (player.seeding_points < previous.seeding_points) return false;
    if (activity !== previous.latest_seeding_activity) return false;

    const deductionFrom = Math.max(previousTime, Date.parse(activity) + minimumRewardMs);
    return phases.some((phase) => Date.parse(phase.endTs) > deductionFrom);
  });
}

function durationToMs(field) {
  if (field && typeof field.value === 'number' && typeof field.option === 'number') {
    return field.value * field.option;
  }
  return null;
}

function buildRecommendations(config, windowPhases, allSnapshots, cutoff) {
  if (windowPhases.length === 0) return [];

  const recommendations = [];
  const totalPhases = windowPhases.length;
  const abortedCount = windowPhases.filter((phase) => phase.outcome === 'aborted').length;
  const livePhases = windowPhases.filter((phase) => phase.outcome === 'live');

  const avgDurationMs =
    windowPhases.reduce((sum, phase) => sum + phase.durationMs, 0) / totalPhases;
  const avgTimeToLiveMs =
    livePhases.length > 0
      ? livePhases.reduce((sum, phase) => sum + phase.timeToLiveMs, 0) / livePhases.length
      : null;
  const abortRate = abortedCount / totalPhases;

  const requiredPoints = resolveRewardThreshold(config);
  const timeDeduction = safeConfigNum(config.time_deduction, null);
  const minRewardDuration = safeConfigNum(config.minimum_reward_duration, null);
  const seedingStartCount = Number(config.seeding_start_player_count) || null;

  // getPlayers returns every player with at least one point, also players who stopped seeding months ago,
  // so the share counts only players who seeded inside the window.
  let pctReachingReward = null;
  const latest = allSnapshots.at(-1);
  const activePlayers = (latest?.players ?? []).filter(
    (player) => player.latest_seeding_activity && player.latest_seeding_activity >= cutoff
  );
  if (activePlayers.length > 0) {
    const qualified = activePlayers.filter((player) => player.seeding_points >= requiredPoints);
    pctReachingReward = qualified.length / activePlayers.length;
  }

  if (avgDurationMs > 60 * 60 * 1000 && pctReachingReward !== null && pctReachingReward < 0.5) {
    // Two decimals, so a small deduction such as 0.2 still gives a lower suggestion.
    const suggested = timeDeduction != null ? Math.round(timeDeduction * 0.8 * 100) / 100 : null;
    // Recommend only when the suggestion is lower than the current value.
    if (suggested === null || suggested < timeDeduction) {
      recommendations.push(
        `🔻 **Lower \`time_deduction\`** — avg phase ${Math.round(
          avgDurationMs / 60000
        )}min but only ${Math.round(pctReachingReward * 100)}% reach reward.` +
          (suggested !== null ? ` Current: ${timeDeduction} → Suggested: ${suggested}` : '')
      );
    }
  }

  if (
    avgTimeToLiveMs !== null &&
    avgTimeToLiveMs < 30 * 60 * 1000 &&
    pctReachingReward !== null &&
    pctReachingReward > 0.8
  ) {
    recommendations.push(
      `🔺 **Raise \`reward_needed_time\`** — avg time-to-live ${Math.round(
        avgTimeToLiveMs / 60000
      )}min and ${Math.round(pctReachingReward * 100)}% already at threshold.` +
        ` Current: ${requiredPoints}min → Suggested: ${requiredPoints + 30}min`
    );
  }

  if (abortRate > 0.3 && seedingStartCount !== null && seedingStartCount > 1) {
    recommendations.push(
      `⚠️ **Lower \`seeding_start_player_count\`** — ${Math.round(
        abortRate * 100
      )}% of phases abort before going live.` +
        ` Current: ${seedingStartCount} → Suggested: ${Math.max(1, seedingStartCount - 2)}`
    );
  }

  if (avgDurationMs > 90 * 60 * 1000 && !minRewardDuration) {
    const suggested = Math.round(avgDurationMs / 60000 / 2);
    recommendations.push(
      `💡 **Set \`minimum_reward_duration\`** — avg phase ${Math.round(
        avgDurationMs / 60000
      )}min with no reward floor. Suggested: ${suggested}min`
    );
  }

  return recommendations;
}
