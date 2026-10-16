import Sequelize from 'sequelize';

const { QueryTypes } = Sequelize;

// DBLog's table names. Its events reference players by steamID.
const TABLES = {
  players: 'DBLog_Players',
  wounds: 'DBLog_Wounds',
  deaths: 'DBLog_Deaths',
  revives: 'DBLog_Revives'
};

// Quoted for the connector's dialect; `match` is a reserved word in MySQL.
function identifiers(database) {
  const quote = (name) => database.getQueryInterface().quoteIdentifier(name);
  const table = Object.fromEntries(Object.entries(TABLES).map(([key, name]) => [key, quote(name)]));
  return { table, matchColumn: quote('match') };
}

const TOP_WEAPONS = 3;

/**
 * Counts for one player in one statement, plus a short one for the top weapons, so the shared DBLog
 * connection is held only briefly.
 * Stat names follow MySquadStats: wounds are downs, kills are deaths the player caused.
 * Teamkills and self-kills are not counted as wounds or kills.
 */
export async function fetchPlayerStats(database, steamID) {
  const { table, matchColumn } = identifiers(database);
  const notSelf = '(victim IS NULL OR victim <> :steamID)';
  const [row] = await database.query(
    `SELECT
      (SELECT lastName FROM ${table.players} WHERE steamID = :steamID) AS name,
      (SELECT COUNT(*) FROM ${table.wounds} WHERE attacker = :steamID AND teamkill = :no AND ${notSelf}) AS wounds,
      (SELECT COUNT(*) FROM ${table.deaths} WHERE attacker = :steamID AND teamkill = :no AND ${notSelf}) AS kills,
      (SELECT COUNT(*) FROM ${table.deaths} WHERE victim = :steamID) AS deaths,
      (SELECT COUNT(*) FROM ${table.revives} WHERE reviver = :steamID) AS revives,
      (SELECT COUNT(*) FROM ${table.revives} WHERE victim = :steamID) AS revived,
      (SELECT COUNT(*) FROM ${table.wounds} WHERE attacker = :steamID AND teamkill = :yes AND ${notSelf}) AS teamkills,
      (SELECT COUNT(*) FROM (
        SELECT ${matchColumn} AS matchID FROM ${table.deaths} WHERE victim = :steamID
        UNION SELECT ${matchColumn} FROM ${table.wounds} WHERE attacker = :steamID
        UNION SELECT ${matchColumn} FROM ${table.revives} WHERE reviver = :steamID
      ) AS played WHERE matchID IS NOT NULL) AS matches,
      (SELECT COUNT(DISTINCT ${matchColumn}) FROM ${table.deaths} WHERE victim = :steamID) AS deathMatches`,
    { replacements: { steamID, no: false, yes: true }, type: QueryTypes.SELECT }
  );
  const topWeapons = await database.query(
    `SELECT weapon, COUNT(*) AS wounds FROM ${table.wounds}
       WHERE attacker = :steamID AND teamkill = :no AND ${notSelf} AND weapon IS NOT NULL
       GROUP BY weapon ORDER BY COUNT(*) DESC LIMIT :limit`,
    { replacements: { steamID, no: false, limit: TOP_WEAPONS }, type: QueryTypes.SELECT }
  );

  const count = (value) => Number(value) || 0;
  const stats = {
    steamID,
    name: row.name,
    wounds: count(row.wounds),
    kills: count(row.kills),
    deaths: count(row.deaths),
    revives: count(row.revives),
    revived: count(row.revived),
    teamkills: count(row.teamkills),
    matches: count(row.matches),
    deathMatches: count(row.deathMatches),
    topWeapons: topWeapons.map(({ weapon, wounds }) => ({ weapon, wounds: count(wounds) }))
  };
  stats.kd = killDeathRatio(stats);
  return stats;
}

export function killDeathRatio({ kills, deaths }) {
  return deaths > 0 ? kills / deaths : kills;
}

/**
 * The measures a player is ranked on, in the card's radar order (clockwise from the top): totals mixed
 * with rates, so the profile is not only playtime.
 * Rates divide by the matches the player died in, the one match count the leaderboard can get from a
 * single indexed GROUP BY.
 */
export const RANKED_MEASURES = [
  'kills',
  'wounds',
  'woundsPerMatch',
  'kd',
  'revivesPerMatch',
  'revives'
];

function rankedValues({ kills, deaths, wounds, revives, deathMatches }) {
  const perMatch = (total) => (deathMatches > 0 ? total / deathMatches : 0);
  return {
    kills,
    wounds,
    woundsPerMatch: perMatch(wounds),
    kd: killDeathRatio({ kills, deaths }),
    revivesPerMatch: perMatch(revives),
    revives
  };
}

/**
 * Per-player totals for ranking. Only players with at least `minimumDeaths` deaths are ranked,
 * so one-round visitors do not fill the bottom of every ranking.
 */
export async function fetchLeaderboard(database, minimumDeaths) {
  const { table, matchColumn } = identifiers(database);
  const rows = await database.query(
    `SELECT victim AS steamID, COUNT(*) AS deaths, COUNT(DISTINCT ${matchColumn}) AS deathMatches
       FROM ${table.deaths} WHERE victim IS NOT NULL GROUP BY victim HAVING COUNT(*) >= :minimumDeaths`,
    { replacements: { minimumDeaths }, type: QueryTypes.SELECT }
  );
  const players = new Map(
    rows.map((row) => [
      row.steamID,
      {
        kills: 0,
        deaths: Number(row.deaths),
        wounds: 0,
        revives: 0,
        deathMatches: Number(row.deathMatches)
      }
    ])
  );

  const addCounts = async (sql, field) => {
    const counted = await database.query(sql, {
      replacements: { no: false },
      type: QueryTypes.SELECT
    });
    for (const { steamID, total } of counted) {
      const player = players.get(steamID);
      if (player) player[field] = Number(total);
    }
  };
  // Kills and downs of enemies: teamkills and self-kills are not counted.
  const enemyHits = (eventTable) =>
    `SELECT attacker AS steamID, COUNT(*) AS total FROM ${eventTable}
       WHERE attacker IS NOT NULL AND teamkill = :no AND (victim IS NULL OR victim <> attacker)
       GROUP BY attacker`;
  await addCounts(enemyHits(table.deaths), 'kills');
  await addCounts(enemyHits(table.wounds), 'wounds');
  await addCounts(
    `SELECT reviver AS steamID, COUNT(*) AS total FROM ${table.revives}
       WHERE reviver IS NOT NULL GROUP BY reviver`,
    'revives'
  );

  const values = [...players.values()].map(rankedValues);
  const sorted = (measure) => values.map((value) => value[measure]).sort((a, b) => a - b);
  return {
    size: players.size,
    ...Object.fromEntries(RANKED_MEASURES.map((measure) => [measure, sorted(measure)]))
  };
}

/**
 * "Top X%" for a value among the ranked players: the share of players with the same or a higher value.
 * Returns null when there is no ranking yet.
 */
export function topPercent(sortedValues, value) {
  if (!sortedValues || sortedValues.length === 0) return null;
  let low = 0;
  let high = sortedValues.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sortedValues[middle] < value) low = middle + 1;
    else high = middle;
  }
  const atOrAbove = sortedValues.length - low;
  return Math.max(1, Math.ceil((100 * atOrAbove) / sortedValues.length));
}

/**
 * "Top X%" for each ranked measure. Players below the ranking's death minimum get none, since they are
 * not in the ranking and a short visit would otherwise rank near the top.
 */
export function rankPlayer(leaderboard, stats, minimumDeaths) {
  if (!leaderboard || stats.deaths < minimumDeaths) return {};
  const values = rankedValues(stats);
  return Object.fromEntries(
    RANKED_MEASURES.map((measure) => [measure, topPercent(leaderboard[measure], values[measure])])
  );
}

/** Turns a blueprint name like "RS_BP_AK74M_1P78" into "AK74M 1P78". */
export function weaponLabel(blueprint) {
  if (!blueprint) return null;
  return blueprint
    .replace(/^(RS_)?BP_/, '')
    .replace(/^Projectile_/, '')
    .replace(/_C$/, '')
    .replace(/_/g, ' ')
    .trim();
}

/** Start time of the first match DBLog recorded, or null when there is none. */
export async function fetchFirstMatchTime(database) {
  const quote = (name) => database.getQueryInterface().quoteIdentifier(name);
  const [row] = await database.query(
    `SELECT startTime FROM ${quote('DBLog_Matches')} ORDER BY id LIMIT 1`,
    { type: QueryTypes.SELECT }
  );
  return row?.startTime ? new Date(row.startTime) : null;
}
