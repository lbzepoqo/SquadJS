// Profile links for Discord messages. Players from the Epic Games Store have no Steam ID, so every
// helper accepts a missing steamID.

const BATTLEMETRICS_RCON_PLAYERS_URL = 'https://www.battlemetrics.com/rcon/players';

/** Steam profile URL, or null when the player has no Steam ID. */
export function steamProfileUrl(steamID) {
  return steamID ? `https://steamcommunity.com/profiles/${steamID}` : null;
}

/**
 * BattleMetrics RCON player search that redirects to the single match. Searches by Steam ID when there
 * is one, else by EOS ID.
 */
export function battlemetricsPlayerUrl({ steamID, eosID }) {
  const searchID = steamID || eosID;
  return `${BATTLEMETRICS_RCON_PLAYERS_URL}?filter[search]=${searchID}&method=quick&redirect=1`;
}

/** Player name as a markdown link to the Steam profile, or plain code text without a Steam ID. */
export function playerNameLink(name, steamID) {
  const profileUrl = steamProfileUrl(steamID);
  return profileUrl ? `[\`${name}\`](<${profileUrl}>)` : `\`${name}\``;
}
