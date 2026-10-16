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

/**
 * Counts for one player in a single statement, so the shared DBLog connection is held once.
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
      (SELECT weapon FROM ${table.wounds} WHERE attacker = :steamID AND teamkill = :no AND ${notSelf}
        GROUP BY weapon ORDER BY COUNT(*) DESC LIMIT 1) AS topWeapon,
      (SELECT COUNT(*) FROM ${table.wounds} WHERE attacker = :steamID AND teamkill = :no AND ${notSelf}
        GROUP BY weapon ORDER BY COUNT(*) DESC LIMIT 1) AS topWeaponWounds`,
    { replacements: { steamID, no: false, yes: true }, type: QueryTypes.SELECT }
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
    topWeapon: row.topWeapon ? { weapon: row.topWeapon, wounds: count(row.topWeaponWounds) } : null
  };
  stats.kd = killDeathRatio(stats);
  return stats;
}

export function killDeathRatio({ kills, deaths }) {
  return deaths > 0 ? kills / deaths : kills;
}

/**
 * Per-player totals for ranking. Only players with at least `minimumDeaths` deaths are ranked,
 * so one-round visitors do not fill the bottom of every ranking.
 */
export async function fetchLeaderboard(database, minimumDeaths) {
  const { table } = identifiers(database);
  const rows = await database.query(
    `SELECT victim AS steamID, COUNT(*) AS deaths FROM ${table.deaths}
       WHERE victim IS NOT NULL GROUP BY victim HAVING COUNT(*) >= :minimumDeaths`,
    { replacements: { minimumDeaths }, type: QueryTypes.SELECT }
  );
  const players = new Map(
    rows.map((row) => [row.steamID, { kills: 0, deaths: Number(row.deaths), revives: 0 }])
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
  await addCounts(
    `SELECT attacker AS steamID, COUNT(*) AS total FROM ${table.deaths}
       WHERE attacker IS NOT NULL AND teamkill = :no AND (victim IS NULL OR victim <> attacker)
       GROUP BY attacker`,
    'kills'
  );
  await addCounts(
    `SELECT reviver AS steamID, COUNT(*) AS total FROM ${table.revives}
       WHERE reviver IS NOT NULL GROUP BY reviver`,
    'revives'
  );

  const sorted = (valueOf) => [...players.values()].map(valueOf).sort((a, b) => a - b);
  return {
    size: players.size,
    kills: sorted((player) => player.kills),
    kd: sorted(killDeathRatio),
    revives: sorted((player) => player.revives)
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
 * "Top X%" values for the card. Players below the ranking's death minimum get none, since they are
 * not in the ranking and a short visit would otherwise rank near the top.
 */
export function rankPlayer(leaderboard, stats, minimumDeaths) {
  if (!leaderboard || stats.deaths < minimumDeaths) return {};
  return {
    kills: topPercent(leaderboard.kills, stats.kills),
    kd: topPercent(leaderboard.kd, stats.kd),
    revives: topPercent(leaderboard.revives, stats.revives)
  };
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
