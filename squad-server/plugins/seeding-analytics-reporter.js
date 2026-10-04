import { promises as fs } from 'fs';
import axios from 'axios';
import DiscordBasePlugin from './discord-base-plugin.js';
import { COPYRIGHT_MESSAGE } from '../utils/constants.js';

const SAVE_DEBOUNCE_MS = 2000;
const API_TIMEOUT_MS = 10000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_SNAPSHOTS = 14;
const MAX_PHASES = 30;
const TRACKER_RESUME_MS = 10 * 60 * 1000;

function emptyState() {
  return { snapshots: [], phases: [], alertedStuck: [], lastReportTs: null };
}

export default class SeedingAnalyticsReporter extends DiscordBasePlugin {
  static get description() {
    return 'Posts daily seeding analytics to Discord: leaderboard, stuck-player alerts, phase stats, and config recommendations.';
  }

  static get defaultEnabled() {
    return true;
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
        description: 'UTC hour (0–23) at which to post the daily report.',
        default: 12
      },
      leaderboardSize: {
        required: false,
        description: 'Number of top seeders to show in the leaderboard.',
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
          'Path to a JSON array of steamIDs already zeroed — prevents re-alerting on first run.',
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

    this.tracker = null;
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
  }

  async unmount() {
    this.server.removeListener('UPDATED_PLAYER_INFORMATION', this.boundOnUpdatedPlayerInfo);
    if (this.saveDebounceTimer) clearTimeout(this.saveDebounceTimer);
    if (this.reportTimer) clearTimeout(this.reportTimer);
    if (this.reportInterval) clearInterval(this.reportInterval);
    // flush any pending save
    if (this.saveDebounceTimer) await this.saveState();
  }

  // ─── State Persistence ───────────────────────────────────────────────────────

  async loadState() {
    try {
      const raw = await fs.readFile(this.options.dataFile, 'utf8');
      this.state = JSON.parse(raw);
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

  async saveState() {
    try {
      await fs.writeFile(this.options.dataFile, JSON.stringify(this.state, null, 2), 'utf8');
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
      for (const id of steamIDs) existing.add(id);
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

  // ─── API ─────────────────────────────────────────────────────────────────────

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

  // ─── Phase Tracker ───────────────────────────────────────────────────────────

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

    await this.advanceTracker(count, now, startThreshold, liveThreshold);
    this.tracker.updatedAt = now;
    this.scheduleSave();
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

  // ─── Snapshot + Stuck Detection ──────────────────────────────────────────────

  async takeSnapshot() {
    let players, config;
    try {
      [players, config] = await Promise.all([this.fetchPlayers(), this.fetchConfig()]);
    } catch (error) {
      this.verbose(1, `Snapshot fetch failed: ${error.message}`);
      return { players: null, config: null, newStuck: [] };
    }
    this.verbose(2, `Raw config: ${JSON.stringify(config)}`);

    const prevSnapshot = this.state.snapshots.at(-1);
    const newStuck = detectStuck(
      players,
      prevSnapshot?.players ?? [],
      this.state.alertedStuck,
      config
    );

    const ts = new Date().toISOString();
    this.state.snapshots.push({
      ts,
      players: players.map((p) => ({
        steamid64: p.steamid64,
        username: p.username,
        seeding_points: p.seeding_points,
        latest_seeding_activity: p.latest_seeding_activity ?? null
      }))
    });
    if (this.state.snapshots.length > MAX_SNAPSHOTS) {
      this.state.snapshots = this.state.snapshots.slice(-MAX_SNAPSHOTS);
    }

    for (const player of newStuck) {
      this.state.alertedStuck.push(player.steamid64);
    }

    this.scheduleSave();
    this.verbose(1, `Snapshot taken: ${players.length} players, ${newStuck.length} new stuck.`);
    return { players, config, newStuck };
  }

  // ─── Discord Report ──────────────────────────────────────────────────────────

  async buildAndPostReport() {
    const { players, config, newStuck } = await this.takeSnapshot();

    const today = new Date().toISOString().slice(0, 10);
    const requiredPoints = resolveRewardThreshold(config);

    const leaderboardLines = players
      ? [...players]
          .sort((a, b) => b.seeding_points - a.seeding_points)
          .slice(0, this.options.leaderboardSize)
          .map((p, i) => {
            const pct = Math.round((p.seeding_points / requiredPoints) * 100);
            const lastActive = p.latest_seeding_activity
              ? `<t:${Math.floor(new Date(p.latest_seeding_activity).getTime() / 1000)}:R>`
              : 'never';
            return `**${i + 1}.** ${p.username ?? p.steamid64} — ${p.seeding_points.toFixed(
              1
            )}pts (${pct}%) · ${lastActive}`;
          })
      : ['Could not fetch player data.'];

    const configLines = config
      ? [
          `reward_needed_time: **${formatDuration(
            config.reward_needed_time
          )}** (${resolveRewardThreshold(config)}pts threshold)`,
          `time_deduction: **${safeConfigDisplay(config.time_deduction)}**/min`,
          `minimum_reward_duration: **${
            formatDuration(config.minimum_reward_duration) ?? 'not set'
          }**`,
          `seeding_player_threshold: **${config.seeding_player_threshold}**`,
          `seeding_start_player_count: **${config.seeding_start_player_count}**`,
          `tracking_mode: **${config.tracking_mode ?? 'N/A'}**`
        ]
      : ['Could not fetch config.'];

    const yesterday = new Date(Date.now() - MS_PER_DAY).toISOString().slice(0, 10);
    const yesterdayPhases = this.state.phases.filter((p) => p.date === yesterday);
    const phaseLines =
      yesterdayPhases.length > 0
        ? yesterdayPhases.map((p) => {
            const startUnix = Math.floor(new Date(p.startTs).getTime() / 1000);
            const endUnix = Math.floor(new Date(p.endTs).getTime() / 1000);
            const dur = Math.round(p.durationMs / 60000);
            const ttl =
              p.timeToLiveMs != null
                ? `${Math.round(p.timeToLiveMs / 60000)}min to live`
                : 'aborted';
            return `<t:${startUnix}:t> → <t:${endUnix}:t> · ${dur}min · peak ${p.peakCount} · ${p.uniqueSeederCount} seeders · ${ttl}`;
          })
        : ['No seeding phase recorded yesterday.'];

    const stuckLines =
      newStuck.length > 0
        ? [
            `${newStuck.length} new stuck player${newStuck.length !== 1 ? 's' : ''}:`,
            ...newStuck
              .slice(0, 10)
              .map((p) => `• ${p.username ?? p.steamid64} — ${p.seeding_points.toFixed(1)}pts`),
            ...(newStuck.length > 10
              ? [`…and ${newStuck.length - 10} more — check ${this.options.dataFile}`]
              : [])
          ]
        : null;

    const windowDays = this.options.recommendationWindowDays;
    const cutoff = new Date(Date.now() - windowDays * MS_PER_DAY).toISOString();
    const windowPhases = this.state.phases.filter((p) => p.startTs >= cutoff);
    const recommendations = config
      ? buildRecommendations(config, windowPhases, this.state.snapshots, cutoff)
      : [];
    const recLines =
      recommendations.length > 0 ? recommendations : ['✅ Config matches observed pattern.'];

    const leaderboardEmbeds = chunkEmbeds(
      `Top ${this.options.leaderboardSize} Seeders — ${today} UTC`,
      leaderboardLines.length ? leaderboardLines : ['No data.'],
      0xf1c40f
    );

    const summaryEmbeds = [
      {
        title: 'Active Whitelister Config',
        color: 0x95a5a6,
        description: configLines.join('\n')
      },
      {
        title: "Yesterday's Seeding Phase",
        color: 0x3498db,
        description: phaseLines.join('\n')
      },
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
        description: recLines.join('\n'),
        footer: { text: COPYRIGHT_MESSAGE },
        timestamp: new Date().toISOString()
      }
    ];

    const allEmbeds = [...leaderboardEmbeds, ...summaryEmbeds];
    const totalChars = allEmbeds.reduce(
      (sum, e) =>
        sum + (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.footer?.text?.length ?? 0),
      0
    );

    if (allEmbeds.length > 10 || totalChars > 5900) {
      // Split into two messages when Discord limits would be hit
      await this.sendDiscordMessage({ embeds: leaderboardEmbeds });
      await this.sendDiscordMessage({ embeds: summaryEmbeds });
      this.verbose(
        1,
        `Report split into 2 messages (${allEmbeds.length} embeds, ~${totalChars} chars).`
      );
    } else {
      await this.sendDiscordMessage({ embeds: allEmbeds });
    }

    this.state.lastReportTs = new Date().toISOString();
    this.scheduleSave();
    this.verbose(1, 'Daily seeding report posted.');
  }

  // ─── Scheduler ───────────────────────────────────────────────────────────────

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
      this.buildAndPostReport().catch((err) => this.verbose(1, `Report error: ${err.message}`));
      this.reportInterval = setInterval(() => {
        this.buildAndPostReport().catch((err) => this.verbose(1, `Report error: ${err.message}`));
      }, MS_PER_DAY);
    }, msUntilNext);
  }
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function chunkEmbeds(title, lines, color, descLimit = 3800) {
  const embeds = [];
  let buf = '';
  let part = 0;
  for (const line of lines) {
    const candidate = buf ? `${buf}\n${line}` : line;
    const safeLine = line.length > descLimit ? `${line.slice(0, descLimit - 1)}…` : line;
    if (candidate.length > descLimit && buf) {
      embeds.push({
        title: part === 0 ? title : `${title} (cont. ${part + 1})`,
        color,
        description: buf
      });
      part++;
      buf = safeLine;
    } else {
      buf = buf ? `${buf}\n${safeLine}` : safeLine;
    }
  }
  if (buf) {
    embeds.push({
      title: part === 0 ? title : `${title} (cont. ${part + 1})`,
      color,
      description: buf
    });
  }
  if (embeds.length === 0) {
    embeds.push({ title, color, description: '—' });
  }
  return embeds;
}

function msUntilHourUTC(hourUTC) {
  const now = new Date();
  const target = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUTC, 0, 0, 0)
  );
  if (target <= now) target.setUTCDate(target.getUTCDate() + 1);
  return target.getTime() - now.getTime();
}

// reward_needed_time: { value: 2, option: 3600000 } → 2h × (3600000ms / 60000) = 120pts threshold
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
  const n = Number(field);
  return isNaN(n) ? 120 : n;
}

function formatDuration(val) {
  if (val === null || val === undefined) return null;
  if (typeof val !== 'object') return String(val);
  if (typeof val.value === 'number' && typeof val.option === 'number') {
    const minutes = val.value * (val.option / 60000);
    return `${val.value}h (${minutes}min)`;
  }
  return safeConfigDisplay(val);
}

function safeConfigNum(val, fallback = null) {
  if (val === null || val === undefined) return fallback;
  if (typeof val === 'number') return val;
  if (typeof val === 'object') {
    const candidate = val.value ?? val.current ?? val.minutes ?? val.points ?? null;
    const n = Number(candidate);
    return isNaN(n) ? fallback : n;
  }
  const n = Number(val);
  return isNaN(n) ? fallback : n;
}

function safeConfigDisplay(val) {
  if (val === null || val === undefined) return null;
  if (typeof val !== 'object') return String(val);
  const n = safeConfigNum(val);
  return n !== null ? String(n) : JSON.stringify(val);
}

function detectStuck(currentPlayers, prevPlayers, alertedStuck, config) {
  const requiredPoints = resolveRewardThreshold(config);
  const alerted = new Set(alertedStuck);
  const prevByID = Object.fromEntries(prevPlayers.map((p) => [p.steamid64, p]));

  return currentPlayers.filter((player) => {
    if (player.seeding_points < requiredPoints) return false;
    if (alerted.has(player.steamid64)) return false;

    const activity = player.latest_seeding_activity ?? null;
    const isNull = activity === null;
    const prevActivity = prevByID[player.steamid64]?.latest_seeding_activity ?? null;
    const isFrozen = !isNull && prevActivity !== null && prevActivity === activity;

    return isNull || isFrozen;
  });
}

function buildRecommendations(config, windowPhases, allSnapshots, cutoff) {
  if (windowPhases.length === 0) return [];

  const recommendations = [];
  const totalPhases = windowPhases.length;
  const abortedCount = windowPhases.filter((p) => p.outcome === 'aborted').length;
  const livePhases = windowPhases.filter((p) => p.outcome === 'live');

  const avgDurationMs = windowPhases.reduce((sum, p) => sum + p.durationMs, 0) / totalPhases;
  const avgTimeToLiveMs =
    livePhases.length > 0
      ? livePhases.reduce((sum, p) => sum + p.timeToLiveMs, 0) / livePhases.length
      : null;
  const abortRate = abortedCount / totalPhases;

  const requiredPoints = resolveRewardThreshold(config);
  const timeDed = safeConfigNum(config.time_deduction, null);
  const minRewardDuration = safeConfigNum(config.minimum_reward_duration, null);
  const seedingStartCount = config.seeding_start_player_count ?? null;

  const recentSnapshots = allSnapshots.filter((s) => s.ts >= cutoff);
  let pctReachingReward = null;
  if (recentSnapshots.length >= 2) {
    const latest = recentSnapshots.at(-1);
    const total = latest.players.length;
    if (total > 0) {
      const qualified = latest.players.filter((p) => p.seeding_points >= requiredPoints).length;
      pctReachingReward = qualified / total;
    }
  }

  if (avgDurationMs > 60 * 60 * 1000 && pctReachingReward !== null && pctReachingReward < 0.5) {
    // Two decimals so small decay values (e.g. 0.2) still produce a lower suggestion.
    const suggested = timeDed != null ? Math.round(timeDed * 0.8 * 100) / 100 : null;
    // Only recommend when the suggestion is genuinely lower than the current value.
    if (suggested === null || suggested < timeDed) {
      recommendations.push(
        `🔻 **Lower \`time_deduction\`** — avg phase ${Math.round(
          avgDurationMs / 60000
        )}min but only ${Math.round(pctReachingReward * 100)}% reach reward.` +
          (suggested !== null ? ` Current: ${timeDed} → Suggested: ${suggested}` : '')
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
        ` Current: ${requiredPoints} → Suggested: ${requiredPoints + 30}`
    );
  }

  if (abortRate > 0.3 && seedingStartCount !== null) {
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
