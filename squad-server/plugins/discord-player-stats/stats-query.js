import Sequelize from 'sequelize';

const { QueryTypes } = Sequelize;

// DBLog's table names. Its events reference players by steamID.
const TABLES = {
  players: 'DBLog_Players',
  wounds: 'DBLog_Wounds',
  deaths: 'DBLog_Deaths',
  revives: 'DBLog_Revives',
  matches: 'DBLog_Matches'
};

// Quoted for the connector's dialect: `match` is a reserved word in MySQL, and Postgres folds unquoted
// camelCase names such as steamID to lower case.
function identifiers(database) {
  const quote = (name) => database.getQueryInterface().quoteIdentifier(name);
  const table = Object.fromEntries(Object.entries(TABLES).map(([key, name]) => [key, quote(name)]));
  return { table, quote, matchColumn: quote('match') };
}

const TOP_WEAPONS = 3;

/**
 * Counts for one player in one statement, plus a short one for the top weapons, so the shared DBLog
 * connection is held only briefly.
 * Stat names follow MySquadStats: wounds are downs, kills are deaths the player caused.
 * Teamkills and self-kills are not counted as wounds or kills. Neither are events whose victim was not
 * resolved: DBLog stores those without a teamkill flag, so a teamkill cannot be ruled out (about 0.3% of
 * deaths on our server in Oct 2026).
 */
export async function fetchPlayerStats(database, steamID) {
  const { table, quote, matchColumn } = identifiers(database);
  const notSelf = '(victim IS NULL OR victim <> :steamID)';
  const [row] = await database.query(
    `SELECT
      (SELECT ${quote('lastName')} FROM ${table.players} WHERE ${quote(
      'steamID'
    )} = :steamID) AS name,
      (SELECT COUNT(*) FROM ${
        table.wounds
      } WHERE attacker = :steamID AND teamkill = :no AND ${notSelf}) AS wounds,
      (SELECT COUNT(*) FROM ${
        table.deaths
      } WHERE attacker = :steamID AND teamkill = :no AND ${notSelf}) AS kills,
      (SELECT COUNT(*) FROM ${table.deaths} WHERE victim = :steamID) AS deaths,
      (SELECT COUNT(*) FROM ${table.revives} WHERE reviver = :steamID) AS revives,
      (SELECT COUNT(*) FROM ${table.revives} WHERE victim = :steamID) AS revived,
      (SELECT COUNT(*) FROM ${
        table.wounds
      } WHERE attacker = :steamID AND teamkill = :yes AND ${notSelf}) AS teamkills,
      (SELECT COUNT(*) FROM (
        SELECT ${matchColumn} AS matchID FROM ${table.deaths} WHERE victim = :steamID
        UNION SELECT ${matchColumn} FROM ${table.wounds} WHERE attacker = :steamID
        UNION SELECT ${matchColumn} FROM ${table.revives} WHERE reviver = :steamID
      ) AS played WHERE matchID IS NOT NULL) AS matches,
      (SELECT COUNT(DISTINCT ${matchColumn}) FROM ${
      table.deaths
    } WHERE victim = :steamID) AS ${quote('deathMatches')}`,
    { replacements: { steamID, no: false, yes: true }, type: QueryTypes.SELECT }
  );
  // All weapons, cut in JavaScript: the row limit syntax differs between dialects (LIMIT vs TOP).
  const weapons = await database.query(
    `SELECT weapon, COUNT(*) AS wounds FROM ${table.wounds}
       WHERE attacker = :steamID AND teamkill = :no AND ${notSelf} AND weapon IS NOT NULL
       GROUP BY weapon ORDER BY COUNT(*) DESC`,
    { replacements: { steamID, no: false }, type: QueryTypes.SELECT }
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
    topWeapons: weapons
      .slice(0, TOP_WEAPONS)
      .map(({ weapon, wounds }) => ({ weapon, wounds: count(wounds) }))
  };
  stats.kd = killDeathRatio(stats);
  return stats;
}

// A nemesis, favorite victim or revive partner below this count is mostly chance (at the median regular
// they are ties at 2), so the card shows none instead.
export const MINIMUM_PERSON_COUNT = 3;

/**
 * Highlights for one player, each null when there is none: the enemy who killed them most (nemesis), the
 * enemy they killed most, the teammate they revived most and the one who revived them most, the match with
 * the most kills, and the longest kill streak (kills between their own deaths within one match).
 * Kills are counted as in `fetchPlayerStats`, at the time the victim died: DBLog's woundTime equals the death
 * time, so an enemy who bleeds out after the player's own death counts in the player's next streak.
 * Ties go to the latest match.
 */
export async function fetchPlayerHighlights(database, steamID) {
  const { table, quote, matchColumn } = identifiers(database);
  const select = (sql) =>
    database.query(sql, {
      replacements: { steamID, no: false, minimum: MINIMUM_PERSON_COUNT },
      type: QueryTypes.SELECT
    });
  const enemyKill =
    'teamkill = :no AND attacker IS NOT NULL AND victim IS NOT NULL AND attacker <> victim';

  // The most frequent other player, ties broken by steamID so the answer is stable.
  const topPerson = async (otherColumn, eventTable, where) => {
    const [row] = await select(
      `SELECT ${otherColumn} AS other, COUNT(*) AS total FROM ${eventTable} WHERE ${where}
         GROUP BY ${otherColumn} HAVING COUNT(*) >= :minimum ORDER BY COUNT(*) DESC, ${otherColumn}`
    );
    return row ? { steamID: row.other, count: Number(row.total) } : null;
  };
  const nemesis = await topPerson('attacker', table.deaths, `victim = :steamID AND ${enemyKill}`);
  const favoriteVictim = await topPerson(
    'victim',
    table.deaths,
    `attacker = :steamID AND ${enemyKill}`
  );
  const revivedMost = await topPerson(
    'victim',
    table.revives,
    'reviver = :steamID AND victim IS NOT NULL AND victim <> reviver'
  );
  const revivedByMost = await topPerson(
    'reviver',
    table.revives,
    'victim = :steamID AND reviver IS NOT NULL AND victim <> reviver'
  );

  // The player's kills and deaths in order; a death, or the next match, ends a streak.
  const timeline = await select(
    `SELECT ${matchColumn} AS ${quote('matchID')}, victim FROM ${table.deaths}
       WHERE ((attacker = :steamID AND ${enemyKill}) OR victim = :steamID) AND ${matchColumn} IS NOT NULL
       ORDER BY ${matchColumn}, ${quote('time')}, id`
  );
  let bestMatch = null;
  let longestStreak = null;
  let matchKills = 0;
  let streak = 0;
  let currentMatch = null;
  for (const event of timeline) {
    if (event.matchID !== currentMatch) {
      matchKills = 0;
      streak = 0;
      currentMatch = event.matchID;
    }
    if (event.victim === steamID) {
      streak = 0;
      continue;
    }
    matchKills++;
    streak++;
    // Matches come in ID order, so >= keeps the latest of equal ones.
    if (matchKills >= (bestMatch?.kills ?? 0))
      bestMatch = { matchID: event.matchID, kills: matchKills };
    if (streak >= (longestStreak?.kills ?? 0))
      longestStreak = { matchID: event.matchID, kills: streak };
  }

  const people = [nemesis, favoriteVictim, revivedMost, revivedByMost].filter(Boolean);
  if (people.length > 0) {
    const names = await database.query(
      `SELECT ${quote('steamID')}, ${quote('lastName')} FROM ${table.players}
         WHERE ${quote('steamID')} IN (:steamIDs)`,
      {
        replacements: { steamIDs: [...new Set(people.map((person) => person.steamID))] },
        type: QueryTypes.SELECT
      }
    );
    const nameOf = new Map(names.map((row) => [row.steamID, row.lastName]));
    for (const person of people) person.name = nameOf.get(person.steamID) ?? null;
  }

  const matchRecords = [bestMatch, longestStreak].filter(Boolean);
  if (matchRecords.length > 0) {
    const matches = await database.query(
      `SELECT id, layer, ${quote('layerClassname')}, ${quote('startTime')} FROM ${table.matches}
         WHERE id IN (:matchIDs)`,
      {
        replacements: { matchIDs: [...new Set(matchRecords.map((record) => record.matchID))] },
        type: QueryTypes.SELECT
      }
    );
    const matchByID = new Map(matches.map((match) => [match.id, match]));
    for (const record of matchRecords) {
      const match = matchByID.get(record.matchID);
      // DBLog leaves the layer name empty for layers its layer list does not know, such as seed and mod
      // layers; the class name is always set ("L_SAT_Tallil_Seed_v1" reads "SAT Tallil Seed v1").
      record.layer =
        match?.layer || match?.layerClassname?.replace(/^L_/, '').replace(/_/g, ' ') || null;
      record.startTime = match?.startTime ? new Date(match.startTime) : null;
    }
  }

  return { nemesis, favoriteVictim, revivedMost, revivedByMost, bestMatch, longestStreak };
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
  const { table, quote, matchColumn } = identifiers(database);
  const steamIDAlias = quote('steamID');
  const rows = await database.query(
    `SELECT victim AS ${steamIDAlias}, COUNT(*) AS deaths,
       COUNT(DISTINCT ${matchColumn}) AS ${quote('deathMatches')}
       FROM ${
         table.deaths
       } WHERE victim IS NOT NULL GROUP BY victim HAVING COUNT(*) >= :minimumDeaths`,
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
    `SELECT attacker AS ${steamIDAlias}, COUNT(*) AS total FROM ${eventTable}
       WHERE attacker IS NOT NULL AND teamkill = :no AND (victim IS NULL OR victim <> attacker)
       GROUP BY attacker`;
  await addCounts(enemyHits(table.deaths), 'kills');
  await addCounts(enemyHits(table.wounds), 'wounds');
  await addCounts(
    `SELECT reviver AS ${steamIDAlias}, COUNT(*) AS total FROM ${table.revives}
       WHERE reviver IS NOT NULL GROUP BY reviver`,
    'revives'
  );

  const values = [...players.values()].map(rankedValues);
  const sorted = (measure) =>
    values.map((value) => value[measure]).sort((lower, higher) => lower - higher);
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

/** A date like "28 Jun 2026", in UTC. */
export function formatDate(date) {
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC'
  });
}

/** Start time of the first match DBLog recorded, or null when there is none. */
export async function fetchFirstMatchTime(database) {
  const { table, quote } = identifiers(database);
  const startTime = quote('startTime');
  const [row] = await database.query(
    `SELECT MIN(${startTime}) AS ${startTime} FROM ${table.matches}`,
    { type: QueryTypes.SELECT }
  );
  return row?.startTime ? new Date(row.startTime) : null;
}
