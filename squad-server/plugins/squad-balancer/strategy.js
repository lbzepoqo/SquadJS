/**
 * Pure decision function — no RCON, no DB, no side effects.
 *
 * Input: the winner and loser teams, each with their scored squads and player count,
 * plus tuning config. Output: the squads to move in each direction, with reasoning.
 *
 * Strategy:
 *   1. Target move size scales with per-player score delta between winner and loser,
 *      capped by `maxMoveFraction` of the smaller team and floored by `minMoveSize`.
 *   2. From winner: greedily pick top-scoring squads (always include #1 even if it
 *      overshoots — it's the primary source of imbalance).
 *   3. From loser: greedily pick bottom-scoring squads so the weakest link moves to
 *      the dominant side (not their top squad — that was the original bug).
 *   4. Numerical mismatches between the two selections are left to the auto-balancer.
 */

function aggregateScore(squads) {
  return squads.reduce((sum, squad) => sum + (squad.performanceScore || 0), 0);
}

function eligibleSquads(squads) {
  return squads.filter(
    (squad) =>
      !String(squad.squadID).startsWith('unassigned-') &&
      Array.isArray(squad.players) &&
      squad.players.length > 0
  );
}

function calcTargetMoveSize({ winnerScore, loserScore, winnerCount, loserCount, config }) {
  const smallerTeamSize = Math.min(winnerCount, loserCount);
  const cap = Math.max(config.minMoveSize, Math.floor(smallerTeamSize * config.maxMoveFraction));
  const reasoning = [];

  if (smallerTeamSize === 0) {
    reasoning.push('Smaller team has 0 players; no swap possible.');
    return { target: 0, reasoning };
  }

  const perPlayerWinner = winnerScore / Math.max(1, winnerCount);
  const perPlayerLoser = loserScore / Math.max(1, loserCount);
  const delta = perPlayerWinner - perPlayerLoser;

  reasoning.push(
    `Per-player score: winner=${perPlayerWinner.toFixed(2)}, loser=${perPlayerLoser.toFixed(
      2
    )}, delta=${delta.toFixed(2)}`
  );

  if (delta <= 0) {
    reasoning.push(
      `Winner did not outperform loser by score; using minMoveSize=${config.minMoveSize}.`
    );
    return { target: Math.min(cap, config.minMoveSize), reasoning };
  }

  // The two scoring sources sit orders of magnitude apart: SAT per-player scores run
  // in the hundreds, DBLog kill/revive counts in the single digits. Scaling the move
  // size on the raw delta therefore saturates maxMoveFraction on every SAT round and
  // never leaves minMoveSize on a DBLog one, so scale on the delta relative to the
  // match average instead, which is the same number on either source.
  const averagePerPlayer = (perPlayerWinner + perPlayerLoser) / 2;
  const relativeDelta = averagePerPlayer > 0 ? delta / averagePerPlayer : 0;
  const rawFraction = relativeDelta * config.moveCoefficient;
  const fraction = Math.min(config.maxMoveFraction, rawFraction);
  const target = Math.max(
    config.minMoveSize,
    Math.min(cap, Math.round(smallerTeamSize * fraction))
  );

  reasoning.push(`Relative delta: ${(relativeDelta * 100).toFixed(1)}% of match average.`);
  reasoning.push(
    `Fraction of smaller team (${smallerTeamSize}) to move: ${(fraction * 100).toFixed(
      1
    )}%; target=${target} (cap=${cap}, min=${config.minMoveSize}).`
  );

  return { target, reasoning };
}

function pickSquads(squads, target, { ascending }) {
  const sorted = [...squads].sort((a, b) =>
    ascending
      ? (a.performanceScore || 0) - (b.performanceScore || 0)
      : (b.performanceScore || 0) - (a.performanceScore || 0)
  );

  const selection = [];
  let totalPlayers = 0;

  for (const squad of sorted) {
    const size = squad.players.length;
    if (selection.length === 0) {
      selection.push(squad);
      totalPlayers += size;
    } else if (totalPlayers + size <= target) {
      selection.push(squad);
      totalPlayers += size;
    }
    if (totalPlayers >= target) break;
  }

  return { selection, totalPlayers };
}

export function decideSwap({ winner, loser, config }) {
  const reasoning = [];

  const winnerEligible = eligibleSquads(winner.squads);
  const loserEligible = eligibleSquads(loser.squads);

  if (winnerEligible.length === 0 || loserEligible.length === 0) {
    reasoning.push('No eligible squads on one or both teams; no swap.');
    return {
      movesFromWinnerToLoser: [],
      movesFromLoserToWinner: [],
      reasoning
    };
  }

  const winnerScore = aggregateScore(winnerEligible);
  const loserScore = aggregateScore(loserEligible);

  const { target, reasoning: targetReasoning } = calcTargetMoveSize({
    winnerScore,
    loserScore,
    winnerCount: winner.playerCount,
    loserCount: loser.playerCount,
    config
  });
  reasoning.push(...targetReasoning);

  if (target === 0) {
    return {
      movesFromWinnerToLoser: [],
      movesFromLoserToWinner: [],
      reasoning
    };
  }

  const fromWinner = pickSquads(winnerEligible, target, { ascending: false });
  const fromLoser = pickSquads(loserEligible, target, { ascending: true });

  reasoning.push(
    `Winner→Loser: ${fromWinner.selection.length} squads / ${fromWinner.totalPlayers} players (top-scoring).`
  );
  reasoning.push(
    `Loser→Winner: ${fromLoser.selection.length} squads / ${fromLoser.totalPlayers} players (bottom-scoring).`
  );

  return {
    movesFromWinnerToLoser: fromWinner.selection,
    movesFromLoserToWinner: fromLoser.selection,
    reasoning
  };
}

/**
 * How far the observed roster may disagree with the executed plan before the
 * auto-balancer refuses to act on it. Players connect and disconnect while the
 * switches are being applied, so a couple of players either way is normal; a
 * larger gap means the read caught the server part-way through applying them.
 */
export const MAX_PLAN_DRIFT = 3;

/** Team sizes the executed plan should have produced. */
export function expectedTeamCounts({
  team1Count,
  team2Count,
  winnerIsTeam1,
  winnerMoved,
  loserMoved
}) {
  const team1Delta = winnerIsTeam1 ? loserMoved - winnerMoved : winnerMoved - loserMoved;
  return { team1: team1Count + team1Delta, team2: team2Count - team1Delta };
}

/** Largest per-team disagreement between the expected and observed rosters. */
export function planDrift(expected, observed) {
  return Math.max(
    Math.abs(observed.team1 - expected.team1),
    Math.abs(observed.team2 - expected.team2)
  );
}
