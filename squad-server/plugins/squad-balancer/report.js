export const COLORS = {
  team1: 3447003,
  team2: 15158332,
  balance: 7506394,
  autoBalance: 16098851,
  dryRun: 15844367
};

function truncate(value, max = 1024) {
  if (!value) return value;
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function formatTeamStats(stats) {
  return `Tickets: ${stats.tickets || 'N/A'}\nKills: ${stats.kills} · Wounds: ${
    stats.wounds
  }\nTKs: ${stats.teamkills} · Revives: ${stats.revives}`;
}

function formatSquadMoves(squads, squadNames) {
  if (!squads || squads.length === 0) return 'None';
  return squads
    .map((squad) => {
      const name = squadNames?.get(String(squad.squadID));
      const label = name ? `Squad ${squad.squadID} "${name}"` : `Squad ${squad.squadID}`;
      const score = (squad.performanceScore || 0).toFixed(0);
      return `${label} — ${squad.players.length} players, score ${score}`;
    })
    .join('\n');
}

function formatAutoBalance(autoBalance) {
  if (!autoBalance) return null;

  if (autoBalance.skipped === 'plan-drift') {
    const { drift, expectedCounts, observedCounts } = autoBalance;
    return (
      `Skipped — the roster disagreed with the executed plan by ${drift} player(s), ` +
      `so the counts were not trusted.\n` +
      `Expected T1 ${expectedCounts.team1} / T2 ${expectedCounts.team2}, ` +
      `read T1 ${observedCounts.team1} / T2 ${observedCounts.team2}.`
    );
  }
  if (autoBalance.skipped === 'unsettled') {
    const { observedCounts } = autoBalance;
    return `Skipped — team sizes had not settled (read T1 ${observedCounts.team1} / T2 ${observedCounts.team2}).`;
  }

  if (autoBalance.switchedCount === 0) return null;
  const { priorityAnalytics, remainingGap, switchedCount, cappedFrom } = autoBalance;
  const p1 = Array.from(priorityAnalytics.priority1.values()).reduce(
    (n, entry) => n + entry.players.length,
    0
  );
  const p2 = priorityAnalytics.priority2.length;
  const p3 = priorityAnalytics.priority3.length;
  let line = `${switchedCount} players — P1 (squads): ${p1} · P2 (unassigned): ${p2} · P3 (fallback): ${p3}`;
  if (cappedFrom)
    line += `\nCapped: ${cappedFrom} excess measured, correction limited to ${
      switchedCount + remainingGap
    }.`;
  if (remainingGap > 0) line += `\nResidual gap: ${remainingGap}`;
  return line;
}

function buildTriggerEmbed({
  currentWinTeam,
  consecutiveWins,
  ticketDifferenceStr,
  considerTicketDifference,
  teamStats,
  scoringSource,
  color
}) {
  const ticketLine = considerTicketDifference ? `\nTicket difference: ${ticketDifferenceStr}` : '';
  const scoringLabel =
    scoringSource?.type === 'SAT'
      ? `SAT${scoringSource.matchedCount ? ` (${scoringSource.matchedCount} matched)` : ''}`
      : 'DBLog';

  return {
    title: '📊 Squad Balancer Triggered',
    color,
    description: `Team ${currentWinTeam} won ${consecutiveWins} round(s) in a row — reshuffling.${ticketLine}`,
    fields: [
      { name: '🔵 Team 1', value: formatTeamStats(teamStats.team1), inline: true },
      { name: '🔴 Team 2', value: formatTeamStats(teamStats.team2), inline: true },
      { name: '📈 Scoring', value: scoringLabel, inline: true }
    ],
    timestamp: new Date()
  };
}

export function buildReshuffleReport({
  currentWinTeam,
  consecutiveWins,
  ticketDifferenceStr,
  considerTicketDifference,
  color,
  teamStats,
  players,
  plan,
  autoBalance,
  scoringSource,
  winnerSquadNames,
  loserSquadNames
}) {
  const strategyMoved =
    plan.movesFromWinnerToLoser.reduce((total, squad) => total + squad.players.length, 0) +
    plan.movesFromLoserToWinner.reduce((total, squad) => total + squad.players.length, 0);
  const autoCount = autoBalance?.switchedCount || 0;
  const totalMoved = strategyMoved + autoCount;

  const parts = [];
  if (strategyMoved > 0) parts.push(`${strategyMoved} via strategy`);
  if (autoCount > 0) parts.push(`${autoCount} via auto-balance`);
  const description = `Moved ${totalMoved} player(s)${
    parts.length ? ` (${parts.join(', ')})` : ''
  }.`;

  const team1Count = players.filter((player) => String(player.teamID) === '1').length;
  const team2Count = players.filter((player) => String(player.teamID) === '2').length;

  const fields = [
    {
      name: '➡️ Winner → Loser (top squads)',
      value: truncate(formatSquadMoves(plan.movesFromWinnerToLoser, winnerSquadNames)),
      inline: false
    },
    {
      name: '⬅️ Loser → Winner (bottom squads)',
      value: truncate(formatSquadMoves(plan.movesFromLoserToWinner, loserSquadNames)),
      inline: false
    }
  ];

  const autoLine = formatAutoBalance(autoBalance);
  if (autoLine) {
    fields.push({ name: '⚙️ Auto-Balance', value: autoLine, inline: false });
  }

  fields.push({
    name: '✅ Final',
    value: `🔵 Team 1: ${team1Count} players · 🔴 Team 2: ${team2Count} players`,
    inline: false
  });

  return [
    buildTriggerEmbed({
      currentWinTeam,
      consecutiveWins,
      ticketDifferenceStr,
      considerTicketDifference,
      teamStats,
      scoringSource,
      color
    }),
    {
      title: '🔄 Reshuffle Results',
      color,
      description,
      fields
    }
  ];
}

export function buildDryRunReport({
  winTeam,
  consecutiveWins,
  ticketDifferenceStr,
  considerTicketDifference,
  teamStats,
  plan,
  scoringSource,
  color,
  winnerSquadNames,
  loserSquadNames
}) {
  return [
    buildTriggerEmbed({
      currentWinTeam: winTeam,
      consecutiveWins,
      ticketDifferenceStr,
      considerTicketDifference,
      teamStats,
      scoringSource,
      color
    }),
    {
      title: '🔍 Dry-Run: Proposed Swap Plan',
      color,
      description: 'No RCON actions taken. This is what would have happened.',
      fields: [
        {
          name: '🧠 Reasoning',
          value: truncate(plan.reasoning.join('\n')) || '(none)',
          inline: false
        },
        {
          name: '➡️ Winner → Loser (top squads)',
          value: truncate(formatSquadMoves(plan.movesFromWinnerToLoser, winnerSquadNames)),
          inline: false
        },
        {
          name: '⬅️ Loser → Winner (bottom squads)',
          value: truncate(formatSquadMoves(plan.movesFromLoserToWinner, loserSquadNames)),
          inline: false
        }
      ],
      timestamp: new Date()
    }
  ];
}
