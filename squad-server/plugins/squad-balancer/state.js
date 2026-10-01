import fs from 'fs';

export function loadWinStreak(filePath) {
  if (!fs.existsSync(filePath)) {
    return { consecutiveWins: 0, lastWinnerTeam: null };
  }
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return {
    consecutiveWins: data.consecutiveWins || 0,
    lastWinnerTeam: data.lastWinnerTeam ?? null
  };
}

export function saveWinStreak(filePath, { consecutiveWins, lastWinnerTeam }) {
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      consecutiveWins,
      lastWinnerTeam,
      lastUpdated: new Date().toISOString()
    }),
    'utf8'
  );
}
