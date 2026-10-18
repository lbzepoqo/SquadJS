// Presence points for seeding: each update credits the players who were on the server for the whole interval
// since the previous update, while the player count was in the seeding range, and who were active recently.

// An interval longer than this (a stalled player list update or a restart) is not credited, because who was
// on the server during it is not known.
export const MAX_CREDITED_INTERVAL_MS = 2 * 60 * 1000;

export function isSeeding(playerCount, settings) {
  return playerCount >= settings.seedingStartPlayerCount && playerCount < settings.livePlayerCount;
}

// The multiplier of the band with the highest minimum the player count reaches, or 0 below every band.
export function multiplierFor(playerCount, multipliers) {
  let best = null;
  for (const band of multipliers) {
    if (playerCount >= band.minimumPlayers && (!best || band.minimumPlayers > best.minimumPlayers))
      best = band;
  }
  return best ? best.multiplier : 0;
}

export function utcDay(time) {
  return new Date(time).toISOString().slice(0, 10);
}

// Returns one credit per player who earns points for the interval from previousUpdate to now. The player count
// at the previous update decides whether the interval was seeding and which multiplier applies.
export function presenceCredits({ previousUpdate, players, now, lastActivityAt, settings }) {
  if (!previousUpdate) return [];
  const elapsedMs = now - previousUpdate.time;
  if (elapsedMs <= 0 || elapsedMs > MAX_CREDITED_INTERVAL_MS) return [];
  if (!isSeeding(previousUpdate.playerCount, settings)) return [];

  const multiplier = multiplierFor(previousUpdate.playerCount, settings.multipliers);
  const minutes = elapsedMs / 60000;
  const credits = [];
  for (const player of players) {
    if (!player.eosID || !previousUpdate.eosIDs.has(player.eosID)) continue;
    if (settings.activityWindowMs > 0) {
      const lastActive = lastActivityAt.get(player.eosID);
      if (lastActive === undefined || now - lastActive > settings.activityWindowMs) continue;
    }
    credits.push({ player, minutes, points: minutes * multiplier });
  }
  return credits;
}
