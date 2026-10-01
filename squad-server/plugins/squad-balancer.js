import DiscordBasePlugin from './discord-base-plugin.js';
import { setTimeout as delay } from 'timers/promises';
import Sequelize from 'sequelize';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { loadWinStreak, saveWinStreak } from './squad-balancer/state.js';
import {
  findMissingTables,
  getCurrentMatchId,
  fetchAllMatchData,
  processTeamStats,
  calculateSquadScore,
  parseSatScoresFile,
  findAndPruneSatFiles,
  calculateSquadScoreFromSat
} from './squad-balancer/stats.js';
import {
  decideSwap,
  expectedTeamCounts,
  planDrift,
  MAX_PLAN_DRIFT
} from './squad-balancer/strategy.js';
import { buildReshuffleReport, buildDryRunReport, COLORS } from './squad-balancer/report.js';

// The game applies AdminForceTeamChange asynchronously, so a ListPlayers issued
// straight after a batch of switches can come back with the roster only part-way
// updated. Poll until two consecutive reads agree on the team sizes before any
// decision is made from those counts.
const SETTLE_READ_INTERVAL_MS = 750;
const SETTLE_MAX_READS = 5;

export default class SquadBalancer extends DiscordBasePlugin {
  static get description() {
    return 'Balances teams by swapping squads intelligently based on consecutive wins and per-player performance delta, preserving squad integrity.';
  }

  static get defaultEnabled() {
    return true;
  }

  static get optionsSpecification() {
    return {
      ...DiscordBasePlugin.optionsSpecification,
      channelID: {
        required: true,
        description: 'The ID of the Discord channel to log squad balancing events to.',
        default: '',
        example: '667741905228136459'
      },
      color: {
        required: false,
        description: 'The color of the embed for Discord logging.',
        default: 16761867
      },
      database: {
        required: true,
        connector: 'sequelize',
        description: 'The Sequelize connector to access game stats.',
        default: 'mysql'
      },
      dryRun: {
        required: false,
        description:
          'When enabled, runs the full decision pipeline and sends a preview embed to Discord but skips all team-switch RCON actions.',
        default: false
      },
      testMode: {
        required: false,
        description: 'Deprecated alias for dryRun. Use dryRun instead.',
        default: false
      },
      consecutiveWinsThreshold: {
        required: false,
        description: 'Number of consecutive round wins before triggering reshuffle.',
        default: 3
      },
      shuffleDelaySeconds: {
        required: false,
        description: 'Delay in seconds after round end before performing the reshuffle.',
        default: 15
      },
      showBroadcasts: {
        required: false,
        description: 'Whether to broadcast messages about the reshuffling action.',
        default: true
      },
      considerTicketDifference: {
        required: false,
        description: 'Whether to require a minimum ticket difference to count a round win.',
        default: false
      },
      ticketDifferenceThreshold: {
        required: false,
        description: 'Ticket difference threshold for non-invasion layers to count as a valid win.',
        default: 200
      },
      invasionTicketDifferenceThreshold: {
        required: false,
        description: 'Ticket difference threshold for invasion layers to count as a valid win.',
        default: 700
      },
      excludedLayers: {
        required: false,
        description:
          "An array of layer identifiers to exclude. If the winner's layer includes any of these (case insensitive), the round will be skipped.",
        default: ['seed', 'jensen']
      },
      killWeight: {
        required: false,
        description: 'Weight factor for kills in performance calculation.',
        default: 1
      },
      reviveWeight: {
        required: false,
        description: 'Weight factor for revives in performance calculation.',
        default: 1
      },
      teamkillWeight: {
        required: false,
        description:
          'Weight factor for teamkills in performance calculation (negative reduces score).',
        default: -2
      },
      moveCoefficient: {
        required: false,
        description:
          "Fraction of the smaller team to move per unit of relative per-player score delta, where the delta is expressed as a share of the match average. At 0.35 a winner scoring twice the loser's rate moves about a third of the smaller team. Higher = more aggressive redistribution.",
        default: 0.35
      },
      maxMoveFraction: {
        required: false,
        description:
          'Hard cap on the fraction of the smaller team that can be moved in a single swap.',
        default: 0.35
      },
      minMoveSize: {
        required: false,
        description: 'Minimum number of players to move when a swap is triggered.',
        default: 1
      },
      autoBalanceMaxMoves: {
        required: false,
        description:
          'Hard cap on how many players the follow-up auto-balancer may move. The reshuffle it runs after is designed to end roughly even, so a large correction means the roster read is wrong rather than the teams being lopsided.',
        default: 8
      },
      satScoresDir: {
        required: false,
        description:
          'Local path to the SAT PlayerScores directory (e.g. C:/SquadGame/Saved/SquadAdminTools/PlayerScores). When set and files exist, this is the primary scoring source. Falls back to DBLog if the directory is missing or contains no files.',
        default: ''
      },
      satFileRetainCount: {
        required: false,
        description:
          'Number of SAT PlayerScores files to keep. The most recent N files are retained; older ones are deleted automatically after each scored round.',
        default: 6
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.shuffleAbortController = null;
    this.consecutiveWins = 0;
    this.lastWinnerTeam = null;
    this.swappedPlayers = new Set();
    this.teamStats = this.emptyTeamStats();

    const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const dataDir = path.join(rootDir, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    this.stateFilePath = path.join(dataDir, `squad-balancer-state-${server.id}.json`);

    this.onRoundEnd = this.onRoundEnd.bind(this);
    this.onNewGame = this.onNewGame.bind(this);
  }

  emptyTeamStats() {
    return {
      team1: { tickets: 0, kills: 0, wounds: 0, teamkills: 0, revives: 0 },
      team2: { tickets: 0, kills: 0, wounds: 0, teamkills: 0, revives: 0 }
    };
  }

  isDryRun() {
    if (this.options.testMode) {
      this.verbose(1, 'testMode is deprecated; use dryRun instead. Treating as dryRun.');
      return true;
    }
    return !!this.options.dryRun;
  }

  persistStreak() {
    try {
      saveWinStreak(this.stateFilePath, {
        consecutiveWins: this.consecutiveWins,
        lastWinnerTeam: this.lastWinnerTeam
      });
    } catch (error) {
      this.verbose(1, `Failed to save win streak state: ${error.message}`);
    }
  }

  restoreStreak() {
    try {
      const { consecutiveWins, lastWinnerTeam } = loadWinStreak(this.stateFilePath);
      this.consecutiveWins = consecutiveWins;
      this.lastWinnerTeam = lastWinnerTeam;
      if (consecutiveWins > 0) {
        this.verbose(
          1,
          `Restored win streak from disk: ${consecutiveWins} consecutive wins, last winner Team ${lastWinnerTeam}`
        );
      }
    } catch (error) {
      this.verbose(1, `Failed to load win streak state: ${error.message}`);
    }
  }

  async sendReport(embeds) {
    const validEmbeds = embeds.filter(Boolean);
    if (validEmbeds.length === 0) return;
    try {
      await this.sendDiscordMessage({ embeds: validEmbeds });
    } catch (error) {
      this.verbose(1, `Failed to send Discord report: ${error.message}`);
    }
  }

  async mount() {
    this.verbose(1, 'Mounting SquadBalancer plugin.');

    try {
      await this.options.database.query('SELECT 1', {
        type: Sequelize.QueryTypes.SELECT
      });
    } catch (error) {
      this.verbose(1, `Database connection error: ${error.message}. Disabling SquadBalancer.`);
      this.disable();
      return;
    }

    try {
      const missing = await findMissingTables(this.options.database);
      if (missing.length > 0) {
        this.verbose(
          1,
          `Missing required table(s): ${missing.join(', ')}. Disabling SquadBalancer.`
        );
        this.disable();
        return;
      }
    } catch (error) {
      this.verbose(1, `Failed to verify database structure: ${error.message}. Disabling.`);
      this.disable();
      return;
    }

    this.restoreStreak();

    this.server.on('ROUND_ENDED', this.onRoundEnd);
    this.server.on('NEW_GAME', this.onNewGame);
  }

  async unmount() {
    this.verbose(1, 'Unmounting SquadBalancer plugin.');

    if (this.shuffleAbortController) {
      this.shuffleAbortController.abort();
      this.shuffleAbortController = null;
    }

    this.server.removeEventListener('ROUND_ENDED', this.onRoundEnd);
    this.server.removeEventListener('NEW_GAME', this.onNewGame);
  }

  onNewGame() {
    if (this.shuffleAbortController) {
      this.verbose(1, 'NEW_GAME: aborting pending shuffle.');
      this.shuffleAbortController.abort();
      this.shuffleAbortController = null;
      this.consecutiveWins = 0;
      this.lastWinnerTeam = null;
      this.persistStreak();
    }
    this.swappedPlayers.clear();
  }

  async onRoundEnd(info) {
    this.swappedPlayers.clear();
    this.teamStats = this.emptyTeamStats();

    const excludedLayers = Array.isArray(this.options.excludedLayers)
      ? this.options.excludedLayers.map((layer) => layer.toLowerCase())
      : [];

    const winnerLayer = info?.winner?.layer;
    if (
      !info?.winner ||
      !info?.loser ||
      (winnerLayer && excludedLayers.some((ex) => winnerLayer.toLowerCase().includes(ex)))
    ) {
      this.verbose(1, 'Round skipped: missing winner/loser or excluded layer.');
      this.consecutiveWins = 0;
      this.lastWinnerTeam = null;
      this.persistStreak();
      return;
    }

    let ticketDifferenceStr = 'N/A';
    let ticketBanner = '';
    if (
      this.options.considerTicketDifference &&
      typeof info.winner.tickets !== 'undefined' &&
      typeof info.loser.tickets !== 'undefined'
    ) {
      const ticketDifference = info.winner.tickets - info.loser.tickets;
      const requiredTicketDiff =
        winnerLayer && winnerLayer.toLowerCase().includes('invasion')
          ? this.options.invasionTicketDifferenceThreshold
          : this.options.ticketDifferenceThreshold;
      if (ticketDifference < requiredTicketDiff) {
        if (this.options.showBroadcasts) {
          await this.server.rcon.broadcast(
            `Round win not counted for consecutive win streak:\nTeam ${info.winner.team}'s ticket difference of ${ticketDifference} is below threshold ${requiredTicketDiff}.`
          );
        }
        this.verbose(
          1,
          `Ticket diff too low (${ticketDifference} < ${requiredTicketDiff}); resetting streak.`
        );
        this.consecutiveWins = 0;
        this.lastWinnerTeam = null;
        this.persistStreak();
        return;
      }
      ticketDifferenceStr = `${ticketDifference} (Threshold: ${requiredTicketDiff})`;
      ticketBanner = ` (Ticket diff: ${ticketDifference} >= ${requiredTicketDiff})`;
    }

    const currentWinTeam = parseInt(info.winner.team, 10);
    if (isNaN(currentWinTeam)) {
      this.verbose(1, 'Invalid winner team number; skipping.');
      return;
    }

    if (currentWinTeam === 1) {
      this.teamStats.team1.tickets = info.winner.tickets || 0;
      this.teamStats.team2.tickets = info.loser.tickets || 0;
    } else {
      this.teamStats.team2.tickets = info.winner.tickets || 0;
      this.teamStats.team1.tickets = info.loser.tickets || 0;
    }

    // Squad's team IDs swap between rounds. The same dominant side winning
    // again shows up as an ALTERNATING winner-team value; increment on change,
    // reset on repeat.
    if (this.lastWinnerTeam !== null && this.lastWinnerTeam !== currentWinTeam) {
      this.consecutiveWins++;
    } else {
      this.consecutiveWins = 1;
    }
    this.lastWinnerTeam = currentWinTeam;
    this.persistStreak();

    if (this.options.showBroadcasts) {
      await this.server.rcon.broadcast(
        `Team ${currentWinTeam} won this round!\n${ticketBanner} (Consecutive wins: ${this.consecutiveWins})`
      );
    }
    this.verbose(1, `Consecutive wins: ${this.consecutiveWins} for Team ${currentWinTeam}.`);

    if (this.consecutiveWins < this.options.consecutiveWinsThreshold) {
      this.verbose(
        1,
        `Below threshold (${this.consecutiveWins}/${this.options.consecutiveWinsThreshold}); no action.`
      );
      return;
    }

    if (this.options.showBroadcasts) {
      await this.server.rcon.broadcast(
        `Team ${currentWinTeam} has won consecutively ${this.consecutiveWins} times.\nReshuffling squads in ${this.options.shuffleDelaySeconds} seconds.`
      );
    }

    this.shuffleAbortController = new AbortController();
    const { signal } = this.shuffleAbortController;

    try {
      await delay(this.options.shuffleDelaySeconds * 1000, undefined, {
        signal
      });
    } catch (error) {
      if (error.name === 'AbortError') {
        this.verbose(1, 'Shuffle delay aborted (NEW_GAME). Cancelling.');
        if (this.options.showBroadcasts) {
          await this.server.rcon.broadcast('Squad reshuffling cancelled: new match started.');
        }
        return;
      }
      throw error;
    }
    await this.executeReshuffle(currentWinTeam, ticketDifferenceStr, signal);
    this.shuffleAbortController = null;

    this.consecutiveWins = 0;
    this.lastWinnerTeam = null;
    this.persistStreak();
  }

  async executeReshuffle(currentWinTeam, ticketDifferenceStr, signal) {
    if (signal.aborted) return;
    const players = await this.server.rcon.getListPlayers();
    if (signal.aborted) return;
    const squadsSnapshot = await this.server.rcon.getSquads();
    const { team1, team2 } = this.groupPlayersBySquad(players);

    const team1Count = team1.playerCount;
    const team2Count = team2.playerCount;
    this.verbose(
      1,
      `Team 1: ${team1Count} players in ${team1.squads.length} squads; Team 2: ${team2Count} players in ${team2.squads.length} squads.`
    );

    const matchId = await getCurrentMatchId(this.options.database, this.server.id).catch((err) => {
      this.verbose(1, `getCurrentMatchId failed: ${err.message}`);
      return null;
    });

    const weights = {
      killWeight: this.options.killWeight,
      reviveWeight: this.options.reviveWeight,
      teamkillWeight: this.options.teamkillWeight
    };

    let scoredTeam1 = team1.squads.map((squad) => ({
      ...squad,
      performanceScore: 0,
      stats: null
    }));
    let scoredTeam2 = team2.squads.map((squad) => ({
      ...squad,
      performanceScore: 0,
      stats: null
    }));

    let scoringSource = { type: 'DBLog' };

    if (this.options.satScoresDir) {
      try {
        const { latestFile, pruned } = findAndPruneSatFiles(
          this.options.satScoresDir,
          this.options.satFileRetainCount
        );
        if (latestFile) {
          const rawScoresMap = await parseSatScoresFile(latestFile);
          const presentEosIds = new Set(players.map((player) => player.eosID));
          const satScoresMap = new Map(
            [...rawScoresMap.entries()].filter(([eosId]) => presentEosIds.has(eosId))
          );
          scoredTeam1 = scoredTeam1.map((squad) =>
            calculateSquadScoreFromSat(squad, satScoresMap, weights)
          );
          scoredTeam2 = scoredTeam2.map((squad) =>
            calculateSquadScoreFromSat(squad, satScoresMap, weights)
          );
          if (pruned > 0) this.verbose(1, `SAT: pruned ${pruned} old file(s).`);
          scoringSource = { type: 'SAT', matchedCount: satScoresMap.size };
        } else {
          this.verbose(1, 'SAT: no files found in satScoresDir; falling back to DBLog.');
        }
      } catch (error) {
        this.verbose(1, `SAT scoring failed: ${error.message}. Falling back to DBLog.`);
      }
    }

    if (matchId) {
      try {
        const matchData = await fetchAllMatchData(this.options.database, matchId);
        const teamStats = processTeamStats(matchData);
        this.teamStats.team1 = { ...this.teamStats.team1, ...teamStats.team1 };
        this.teamStats.team2 = { ...this.teamStats.team2, ...teamStats.team2 };
        if (scoringSource === 'DBLog') {
          scoredTeam1 = scoredTeam1.map((squad) => calculateSquadScore(squad, matchData, weights));
          scoredTeam2 = scoredTeam2.map((squad) => calculateSquadScore(squad, matchData, weights));
        }
      } catch (error) {
        this.verbose(
          1,
          `Failed to fetch match data: ${error.message}. Proceeding with zero scores.`
        );
      }
    } else {
      this.verbose(1, 'No active match found; squad scores default to 0.');
    }

    this.verbose(1, `Scoring source: ${scoringSource.type}`);

    const winnerIsTeam1 = currentWinTeam === 1;

    const winnerSquadNames = new Map();
    const loserSquadNames = new Map();
    for (const squadSnapshot of squadsSnapshot) {
      const isWinnerTeam = String(squadSnapshot.teamID) === (winnerIsTeam1 ? '1' : '2');
      if (isWinnerTeam)
        winnerSquadNames.set(String(squadSnapshot.squadID), squadSnapshot.squadName);
      else loserSquadNames.set(String(squadSnapshot.squadID), squadSnapshot.squadName);
    }

    const plan = decideSwap({
      winner: {
        squads: winnerIsTeam1 ? scoredTeam1 : scoredTeam2,
        playerCount: winnerIsTeam1 ? team1Count : team2Count
      },
      loser: {
        squads: winnerIsTeam1 ? scoredTeam2 : scoredTeam1,
        playerCount: winnerIsTeam1 ? team2Count : team1Count
      },
      config: {
        moveCoefficient: this.options.moveCoefficient,
        maxMoveFraction: this.options.maxMoveFraction,
        minMoveSize: this.options.minMoveSize
      }
    });

    for (const reason of plan.reasoning) this.verbose(1, `Strategy: ${reason}`);

    if (this.isDryRun()) {
      this.verbose(1, 'Dry-run enabled: sending preview embed, skipping RCON actions.');
      if (this.options.showBroadcasts) {
        await this.server.rcon.broadcast('Squad reshuffling skipped (dry-run mode).');
      }
      await this.sendReport(
        buildDryRunReport({
          winTeam: currentWinTeam,
          consecutiveWins: this.consecutiveWins,
          ticketDifferenceStr,
          considerTicketDifference: this.options.considerTicketDifference,
          teamStats: this.teamStats,
          plan,
          scoringSource,
          color: COLORS.dryRun,
          winnerSquadNames,
          loserSquadNames
        })
      );
      return;
    }

    if (plan.movesFromWinnerToLoser.length === 0 && plan.movesFromLoserToWinner.length === 0) {
      this.verbose(1, 'Strategy returned no moves; skipping reshuffle.');
      if (this.options.showBroadcasts) {
        await this.server.rcon.broadcast('Squad reshuffling skipped: no eligible squads found.');
      }
      return;
    }

    const winnerMoved = plan.movesFromWinnerToLoser.reduce(
      (total, squad) => total + squad.players.length,
      0
    );
    const loserMoved = plan.movesFromLoserToWinner.reduce(
      (total, squad) => total + squad.players.length,
      0
    );

    if (this.options.showBroadcasts) {
      await this.server.rcon.broadcast(
        `Swapping squads: ${winnerMoved} players from winning team, ${loserMoved} from losing team.`
      );
    }

    if (signal.aborted) return;
    await this.executeSquadMoves(plan.movesFromWinnerToLoser, signal);
    if (signal.aborted) return;
    await this.executeSquadMoves(plan.movesFromLoserToWinner, signal);

    if (signal.aborted) return;
    if (this.options.showBroadcasts) {
      await this.server.rcon.broadcast('Squad reshuffling complete.');
    }

    if (signal.aborted) return;
    const expected = expectedTeamCounts({
      team1Count,
      team2Count,
      winnerIsTeam1,
      winnerMoved,
      loserMoved
    });
    const autoBalance = await this.autoBalanceTeams(expected, signal);
    if (signal.aborted) return;
    const finalReading = await this.readSettledPlayers(signal);
    if (!finalReading) return;
    const playersAfter = finalReading.players;

    await this.sendReport(
      buildReshuffleReport({
        currentWinTeam,
        consecutiveWins: this.consecutiveWins,
        ticketDifferenceStr,
        considerTicketDifference: this.options.considerTicketDifference,
        color: this.options.color,
        teamStats: this.teamStats,
        players: playersAfter,
        plan,
        autoBalance,
        scoringSource,
        winnerSquadNames,
        loserSquadNames
      })
    );
  }

  countTeams(players) {
    let team1 = 0;
    let team2 = 0;
    for (const player of players) {
      if (String(player.teamID) === '1') team1++;
      else if (String(player.teamID) === '2') team2++;
    }
    return { team1, team2 };
  }

  /**
   * Read the roster and wait for it to stop moving. Returns null if aborted, or
   * `{ players, counts, settled }` where `settled` is false when the team sizes
   * were still changing on the final read.
   */
  async readSettledPlayers(signal) {
    let previous = null;
    for (let attempt = 0; attempt < SETTLE_MAX_READS; attempt++) {
      if (signal?.aborted) return null;
      const players = await this.server.rcon.getListPlayers();
      const counts = this.countTeams(players);
      if (
        previous &&
        previous.counts.team1 === counts.team1 &&
        previous.counts.team2 === counts.team2
      ) {
        return { players, counts, settled: true };
      }
      previous = { players, counts };
      if (attempt === SETTLE_MAX_READS - 1) break;
      try {
        await delay(SETTLE_READ_INTERVAL_MS, undefined, { signal });
      } catch (error) {
        if (error.name === 'AbortError') return null;
        throw error;
      }
    }
    return { ...previous, settled: false };
  }

  groupPlayersBySquad(players) {
    const group = (teamId) => {
      const squadMap = {};
      let playerCount = 0;
      for (const player of players) {
        if (String(player.teamID) !== teamId) continue;
        playerCount++;
        const key = player.squadID != null ? player.squadID : `unassigned-${player.steamID}`;
        if (!squadMap[key]) squadMap[key] = { squadID: key, players: [] };
        squadMap[key].players.push(player);
      }
      return { squads: Object.values(squadMap), playerCount };
    };
    return { team1: group('1'), team2: group('2') };
  }

  async executeSquadMoves(squads, signal) {
    const switched = new Set();
    for (const squad of squads) {
      if (signal.aborted) break;
      const validSquadId = String(squad.squadID).replace('unassigned-', '');
      let anySwitched = false;
      for (const player of squad.players) {
        if (signal.aborted) break;
        try {
          await this.server.rcon.switchTeam(player.eosID);
          this.swappedPlayers.add(player.eosID);
          anySwitched = true;
        } catch (error) {
          this.verbose(1, `Failed to switchTeam for ${player.steamID}: ${error.message}`);
        }
      }
      if (anySwitched && !String(squad.squadID).startsWith('unassigned-')) {
        switched.add(validSquadId);
      }
    }
    return Array.from(switched);
  }

  async autoBalanceTeams(expectedCounts = null, signal = null) {
    this.verbose(1, 'Starting auto-balance.');
    const reading = await this.readSettledPlayers(signal);
    if (!reading) return null;
    const { players, counts: observedCounts, settled } = reading;

    if (!settled) {
      this.verbose(
        1,
        `Auto-balance skipped: team sizes were still changing after ${SETTLE_MAX_READS} reads (Team 1: ${observedCounts.team1}, Team 2: ${observedCounts.team2}).`
      );
      return { skipped: 'unsettled', observedCounts, switchedCount: 0 };
    }

    // The reshuffle that just ran was sized to leave the teams roughly even, so a
    // roster that disagrees with it is a bad read rather than a real imbalance.
    // Acting on one moved 19 uninvolved players off Team 1 on 2026-08-02.
    if (expectedCounts) {
      const drift = planDrift(expectedCounts, observedCounts);
      if (drift > MAX_PLAN_DRIFT) {
        this.verbose(
          1,
          `Auto-balance skipped: roster disagrees with the executed plan by ${drift} players (expected Team 1: ${expectedCounts.team1}, Team 2: ${expectedCounts.team2}; read Team 1: ${observedCounts.team1}, Team 2: ${observedCounts.team2}).`
        );
        return {
          skipped: 'plan-drift',
          drift,
          expectedCounts,
          observedCounts,
          switchedCount: 0
        };
      }
    }

    const team1 = players.filter((player) => String(player.teamID) === '1');
    const team2 = players.filter((player) => String(player.teamID) === '2');

    if (Math.abs(team1.length - team2.length) <= 1) {
      this.verbose(1, 'Teams already balanced.');
      return null;
    }

    const totalPlayers = team1.length + team2.length;
    const targetCount = totalPlayers % 2 === 0 ? totalPlayers / 2 : Math.ceil(totalPlayers / 2);
    let sourceTeamPlayers;
    let excess;
    let teamLabel;
    if (team1.length > team2.length) {
      sourceTeamPlayers = team1;
      excess = team1.length - targetCount;
      teamLabel = 'Team 1';
    } else {
      sourceTeamPlayers = team2;
      excess = team2.length - targetCount;
      teamLabel = 'Team 2';
    }
    this.verbose(1, `Auto-balancer: ${teamLabel} has ${excess} excess. Target: ${targetCount}.`);

    let cappedFrom = null;
    if (excess > this.options.autoBalanceMaxMoves) {
      cappedFrom = excess;
      excess = this.options.autoBalanceMaxMoves;
      this.verbose(
        1,
        `Auto-balancer: capping the correction at ${excess} moves (${cappedFrom} excess measured).`
      );
    }

    let switchedCount = 0;
    let remaining = excess;
    const prioritiesTriggered = new Set();
    const priorityAnalytics = {
      priority1: new Map(),
      priority2: [],
      priority3: []
    };

    const recordP1 = (squad, player) => {
      const key = String(squad?.squadID ?? player?.squadID ?? 'unassigned');
      if (!priorityAnalytics.priority1.has(key)) {
        priorityAnalytics.priority1.set(key, {
          squadID: squad?.squadID ?? player?.squadID ?? 'unassigned',
          approximateSize: Array.isArray(squad?.players) ? squad.players.length : 1,
          players: []
        });
      }
      priorityAnalytics.priority1.get(key).players.push({
        name: player?.name || 'Unknown',
        steamID: player?.steamID ?? 'unknown'
      });
    };
    const recordSolo = (pri, player) => {
      priorityAnalytics[pri].push({
        name: player?.name || 'Unknown',
        steamID: player?.steamID ?? 'unknown',
        squadID: player?.squadID ?? null
      });
    };

    // Priority 1: whole squads that fit
    const squadsByID = {};
    for (const player of sourceTeamPlayers) {
      if (player.squadID != null && !this.swappedPlayers.has(player.eosID)) {
        if (!squadsByID[player.squadID])
          squadsByID[player.squadID] = { squadID: player.squadID, players: [] };
        squadsByID[player.squadID].players.push(player);
      }
    }
    const squadArray = Object.values(squadsByID).sort(
      (a, b) => a.players.length - b.players.length
    );
    for (const squad of squadArray) {
      if (remaining <= 0 || signal?.aborted) break;
      if (squad.players.length <= remaining) {
        try {
          for (const player of squad.players) {
            await this.server.rcon.switchTeam(player.eosID);
            this.swappedPlayers.add(player.eosID);
            switchedCount++;
            prioritiesTriggered.add('Priority 1');
            recordP1(squad, player);
          }
          remaining -= squad.players.length;
          this.verbose(
            1,
            `Auto-balancer switched squad ${squad.squadID} (${squad.players.length}). Gap: ${remaining}.`
          );
        } catch (error) {
          this.verbose(1, `Failed to switch squad ${squad.squadID}: ${error.message}`);
        }
      }
    }

    // Priority 2: unassigned singletons
    if (remaining > 0) {
      for (const player of sourceTeamPlayers) {
        if (remaining <= 0 || signal?.aborted) break;
        if (player.squadID == null && !this.swappedPlayers.has(player.eosID)) {
          try {
            await this.server.rcon.switchTeam(player.eosID);
            this.swappedPlayers.add(player.eosID);
            switchedCount++;
            remaining--;
            prioritiesTriggered.add('Priority 2');
            recordSolo('priority2', player);
          } catch (error) {
            this.verbose(1, `Failed to switch unassigned ${player.steamID}: ${error.message}`);
          }
        }
      }
    }

    // Priority 3: fallback, break squad cohesion
    if (remaining > 0) {
      for (const player of sourceTeamPlayers) {
        if (remaining <= 0 || signal?.aborted) break;
        if (!this.swappedPlayers.has(player.eosID)) {
          try {
            await this.server.rcon.switchTeam(player.eosID);
            this.swappedPlayers.add(player.eosID);
            switchedCount++;
            remaining--;
            prioritiesTriggered.add('Priority 3');
            recordSolo('priority3', player);
          } catch (error) {
            this.verbose(1, `Failed to switch ${player.steamID}: ${error.message}`);
          }
        }
      }
    }

    if (remaining <= 0) {
      this.verbose(1, `Auto-balancer complete on ${teamLabel}. Switched ${switchedCount}.`);
      if (this.options.showBroadcasts) {
        await this.server.rcon.broadcast(
          `Auto-balancer: Balanced ${teamLabel} by switching ${switchedCount} players.`
        );
      }
    } else {
      this.verbose(1, `Auto-balancer: ${teamLabel} partial. Gap: ${remaining}.`);
    }

    return {
      teamLabel,
      priorityAnalytics,
      prioritiesTriggered,
      remainingGap: remaining,
      switchedCount,
      cappedFrom,
      observedCounts
    };
  }
}
