/**
 * Pure decision function — no RCON, no DB, no side effects.
 *
 * Input: the winner and loser teams, each with their scored squads and player count,
 * plus tuning config. Output: the squads to move in each direction, with reasoning.
 *
 * Strategy:
 *   1. Target move size scales with per-player score delta between winner and loser,
 *      floored by `minMoveSize` and capped by `maxMoveFraction` of the smaller team.
 *      The cap wins over the floor. Only the first squad on each side may exceed it,
 *      so that a swap always moves at least one squad.
 *   2. Squads are ranked by score per player. A squad total mostly measures squad
 *      size, so ranking on it moved the biggest winner squad and the smallest loser
 *      squads every time.
 *   3. From winner: pick the strongest squads until the moved player count is as close
 *      to the target as the squad sizes allow.
 *   4. From loser: pick the weakest squads the same way, aiming at the number of
 *      players the winner sends, so the teams stay even. The auto-balancer only
 *      corrects what is left.
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
  const cap = Math.max(1, Math.floor(smallerTeamSize * config.maxMoveFraction));
  const reasoning = [];

  if (smallerTeamSize === 0) {
    reasoning.push('Smaller team has 0 players; no swap possible.');
    return { target: 0, cap, reasoning };
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
    return { target: Math.min(cap, config.minMoveSize), cap, reasoning };
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
  const target = Math.min(
    cap,
    Math.max(config.minMoveSize, Math.round(smallerTeamSize * fraction))
  );

  reasoning.push(`Relative delta: ${(relativeDelta * 100).toFixed(1)}% of match average.`);
  reasoning.push(
    `Fraction of smaller team (${smallerTeamSize}) to move: ${(fraction * 100).toFixed(
      1
    )}%; target=${target} (cap=${cap}, min=${config.minMoveSize}).`
  );

  return { target, cap, reasoning };
}

function perPlayerScore(squad) {
  return (squad.performanceScore || 0) / Math.max(1, squad.players.length);
}

/**
 * Adds squads in rank order while each one brings the moved player count closer to
 * the target. The first squad is always taken. A later squad is skipped in favor of a
 * smaller one further down when it would overshoot the target by more than the
 * count is short, or push the count past the cap.
 */
function pickSquads(squads, target, cap, { ascending }) {
  const sorted = [...squads].sort((a, b) =>
    ascending ? perPlayerScore(a) - perPlayerScore(b) : perPlayerScore(b) - perPlayerScore(a)
  );

  const selection = [];
  let totalPlayers = 0;

  for (const squad of sorted) {
    if (selection.length > 0 && totalPlayers >= target) break;
    const size = squad.players.length;
    const closer = Math.abs(totalPlayers + size - target) < Math.abs(totalPlayers - target);
    if (selection.length === 0 || (closer && totalPlayers + size <= cap)) {
      selection.push(squad);
      totalPlayers += size;
    }
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

  const {
    target,
    cap,
    reasoning: targetReasoning
  } = calcTargetMoveSize({
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

  const fromWinner = pickSquads(winnerEligible, target, cap, { ascending: false });
  // The loser side may match a first winner squad that is larger than the cap.
  const fromLoser = pickSquads(
    loserEligible,
    fromWinner.totalPlayers,
    Math.max(cap, fromWinner.totalPlayers),
    {
      ascending: true
    }
  );

  reasoning.push(
    `Winner→Loser: ${fromWinner.selection.length} squads / ${fromWinner.totalPlayers} players (highest score per player).`
  );
  reasoning.push(
    `Loser→Winner: ${fromLoser.selection.length} squads / ${fromLoser.totalPlayers} players (lowest score per player).`
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
