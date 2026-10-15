const DAY_MS = 24 * 60 * 60 * 1000;

export const activationKey = (playerID, flagID) => `${playerID}:${flagID}`;

// Works out since when each active flag has been on its player. BattleMetrics keeps one record per player
// and flag, and adding a removed flag again keeps the first addedAt. So addedAt is only used the first
// time a flag is seen; a flag that was absent at an earlier check and is back counts from this check.
// previousActivations maps activationKey to { playerID, flagID, activeSince, active } from the earlier checks.
// Returns the updated map and the active entries with their activeSince.
export function trackActivations(previousActivations, entries, now = Date.now()) {
  const activations = new Map();
  for (const [key, activation] of previousActivations)
    activations.set(key, { ...activation, active: false });

  const activeEntries = [];
  for (const entry of entries) {
    const key = activationKey(entry.playerID, entry.flagID);
    const previous = previousActivations.get(key);

    let activeSince = entry.addedAt;
    if (previous?.active) activeSince = previous.activeSince;
    else if (previous) activeSince = new Date(now).toISOString();

    activations.set(key, {
      playerID: entry.playerID,
      flagID: entry.flagID,
      activeSince,
      active: true
    });
    activeEntries.push({ ...entry, activeSince });
  }

  return { activations, activeEntries };
}

// Picks the entries that have been active for maxAgeDays or longer, oldest first.
export function selectExpiredFlags(activeEntries, maxAgeDays, now = Date.now()) {
  const cutoff = now - maxAgeDays * DAY_MS;
  return activeEntries
    .filter((entry) => Date.parse(entry.activeSince) <= cutoff)
    .sort((first, second) => Date.parse(first.activeSince) - Date.parse(second.activeSince));
}
