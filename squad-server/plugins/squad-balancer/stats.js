import fs from 'fs';
import path from 'path';
import Sequelize from 'sequelize';

const REQUIRED_TABLES = ['DBLog_Matches', 'DBLog_Wounds', 'DBLog_Deaths', 'DBLog_Revives'];

export async function listTables(db) {
  try {
    return await db.query(
      'SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE()',
      { type: Sequelize.QueryTypes.SELECT }
    );
  } catch {
    return await db.query("SELECT name as table_name FROM sqlite_master WHERE type='table'", {
      type: Sequelize.QueryTypes.SELECT
    });
  }
}

export async function findMissingTables(db) {
  const rows = await listTables(db);
  const names = rows
    .map((row) =>
      typeof row.table_name === 'string'
        ? row.table_name
        : row.TABLE_NAME || row.name || row.NAME || ''
    )
    .map((tableName) => tableName.toUpperCase());
  return REQUIRED_TABLES.filter((required) => !names.includes(required.toUpperCase()));
}

export async function getCurrentMatchId(db, serverId) {
  const result = await db.query(
    `
      SELECT id
      FROM DBLog_Matches
      WHERE server = :serverId
      AND endTime IS NULL
      ORDER BY startTime DESC
      LIMIT 1
    `,
    {
      replacements: { serverId },
      type: Sequelize.QueryTypes.SELECT
    }
  );
  return result && result.length > 0 ? result[0].id : null;
}

async function fetchMatchDeaths(db, matchId) {
  return db.query(
    `
      SELECT attacker, victim, attackerTeamID, victimTeamID, teamkill
      FROM DBLog_Deaths
      WHERE match = :matchId
    `,
    { replacements: { matchId }, type: Sequelize.QueryTypes.SELECT }
  );
}

async function fetchMatchWounds(db, matchId) {
  return db.query(
    `
      SELECT attacker, victim, attackerTeamID, victimTeamID, teamkill
      FROM DBLog_Wounds
      WHERE match = :matchId
    `,
    { replacements: { matchId }, type: Sequelize.QueryTypes.SELECT }
  );
}

async function fetchMatchRevives(db, matchId) {
  return db.query(
    `
      SELECT reviver, victim, reviverTeamID, victimTeamID
      FROM DBLog_Revives
      WHERE match = :matchId
    `,
    { replacements: { matchId }, type: Sequelize.QueryTypes.SELECT }
  );
}

export async function fetchAllMatchData(db, matchId) {
  const [deaths, wounds, revives] = await Promise.all([
    fetchMatchDeaths(db, matchId),
    fetchMatchWounds(db, matchId),
    fetchMatchRevives(db, matchId)
  ]);
  return { deaths, wounds, revives };
}

export function processTeamStats(matchData) {
  const stats = {
    team1: { kills: 0, wounds: 0, teamkills: 0, revives: 0 },
    team2: { kills: 0, wounds: 0, teamkills: 0, revives: 0 }
  };

  for (const death of matchData.deaths) {
    if (death.teamkill) continue;
    if (death.attackerTeamID === 1) stats.team1.kills++;
    else if (death.attackerTeamID === 2) stats.team2.kills++;
  }

  for (const wound of matchData.wounds) {
    if (!wound.teamkill) {
      if (wound.victimTeamID === 2) stats.team1.wounds++;
      else if (wound.victimTeamID === 1) stats.team2.wounds++;
    } else {
      if (wound.attackerTeamID === 1) stats.team1.teamkills++;
      else if (wound.attackerTeamID === 2) stats.team2.teamkills++;
    }
  }

  for (const revive of matchData.revives) {
    if (revive.reviverTeamID === 1) stats.team1.revives++;
    else if (revive.reviverTeamID === 2) stats.team2.revives++;
  }

  return stats;
}

export function calculateSquadScore(squad, matchData, weights) {
  if (String(squad.squadID).startsWith('unassigned-')) {
    return {
      ...squad,
      performanceScore: 0,
      stats: {
        kills: 0,
        teamkills: 0,
        revives: 0,
        memberCount: squad.players.length || 1
      }
    };
  }

  const memberIds = squad.players.map((player) => player.steamID);
  if (memberIds.length === 0) {
    return {
      ...squad,
      performanceScore: 0,
      stats: { kills: 0, teamkills: 0, revives: 0, memberCount: 0 }
    };
  }

  const memberSet = new Set(memberIds);
  let kills = 0;
  let teamkills = 0;
  let revives = 0;

  for (const death of matchData.deaths) {
    if (!death.teamkill && memberSet.has(death.attacker)) kills++;
  }
  for (const wound of matchData.wounds) {
    if (wound.teamkill && memberSet.has(wound.attacker)) teamkills++;
  }
  for (const revive of matchData.revives) {
    if (memberSet.has(revive.reviver)) revives++;
  }

  const performanceScore =
    kills * weights.killWeight +
    revives * weights.reviveWeight +
    teamkills * weights.teamkillWeight;

  return {
    ...squad,
    performanceScore,
    stats: { kills, teamkills, revives, memberCount: memberIds.length }
  };
}

function listSatFilesDescending(directory) {
  return fs
    .readdirSync(directory)
    .filter((fileName) => fileName.startsWith('PlayerScores_') && fileName.endsWith('.log'))
    .sort((a, b) => b.localeCompare(a));
}

export async function parseSatScoresFile(filePath) {
  const scoresMap = new Map();
  const content = await fs.promises.readFile(filePath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;
    const parts = trimmed.split(',');
    if (parts.length < 13) continue;
    const eosId = parts[0].trim();
    const combatScore = parseFloat(parts[2]) || 0;
    const objectiveScore = parseFloat(parts[3]) || 0;
    const teamWorkScore = parseFloat(parts[4]) || 0;
    const teamKills = parseFloat(parts[5]) || 0;
    scoresMap.set(eosId, { combatScore, objectiveScore, teamWorkScore, teamKills });
  }
  return scoresMap;
}

export function findLatestSatFile(directory) {
  if (!fs.existsSync(directory)) return null;
  const files = listSatFilesDescending(directory);
  return files.length === 0 ? null : path.join(directory, files[0]);
}

export function pruneSatFiles(directory, retainCount) {
  if (!fs.existsSync(directory)) return 0;
  const files = listSatFilesDescending(directory);
  if (files.length <= retainCount) return 0;
  for (const file of files.slice(retainCount)) {
    fs.unlinkSync(path.join(directory, file));
  }
  return files.length - retainCount;
}

export function findAndPruneSatFiles(directory, retainCount) {
  if (!fs.existsSync(directory)) return { latestFile: null, pruned: 0 };
  const files = listSatFilesDescending(directory);
  if (files.length === 0) return { latestFile: null, pruned: 0 };
  const latestFile = path.join(directory, files[0]);
  let pruned = 0;
  if (files.length > retainCount) {
    for (const file of files.slice(retainCount)) {
      fs.unlinkSync(path.join(directory, file));
      pruned++;
    }
  }
  return { latestFile, pruned };
}

export function calculateSquadScoreFromSat(squad, satScoresMap, weights) {
  if (String(squad.squadID).startsWith('unassigned-') || squad.players.length === 0) {
    return {
      ...squad,
      performanceScore: 0,
      stats: { memberCount: squad.players.length, matchedCount: 0 }
    };
  }

  let performanceScore = 0;
  let matchedCount = 0;
  for (const player of squad.players) {
    const scores = satScoresMap.get(player.eosID);
    if (!scores) continue;
    matchedCount++;
    performanceScore +=
      scores.combatScore +
      scores.objectiveScore +
      scores.teamWorkScore +
      scores.teamKills * weights.teamkillWeight;
  }

  return {
    ...squad,
    performanceScore,
    stats: { memberCount: squad.players.length, matchedCount }
  };
}
