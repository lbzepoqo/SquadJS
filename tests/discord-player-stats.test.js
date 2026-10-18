import assert from 'assert';
import Sequelize from 'sequelize';
import { after, before, describe, it } from 'node:test';

import {
  fetchLeaderboard,
  fetchPlayerHighlights,
  fetchPlayerStats,
  rankPlayer,
  topPercent
} from '../squad-server/plugins/discord-player-stats/stats-query.js';
import { backgroundAttachment } from '../squad-server/plugins/discord-player-stats/backgrounds.js';

const PLAYER = '76561190000000001';
const ENEMY = '76561190000000002';
const TEAMMATE = '76561190000000003';

const database = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });

// The columns of DBLog's tables that the queries read.
const event = (extraColumns = '') =>
  `(id INTEGER PRIMARY KEY AUTOINCREMENT, attacker VARCHAR(255), victim VARCHAR(255),
    teamkill TINYINT(1), weapon VARCHAR(255), \`match\` INTEGER${extraColumns})`;

const insert = (table, rows) =>
  Promise.all(
    rows.map((row) =>
      database.query(
        `INSERT INTO ${table} (${Object.keys(row).map((column) => `\`${column}\``)})
         VALUES (${Object.keys(row).map((column) => `:${column}`)})`,
        { replacements: row }
      )
    )
  );

before(async () => {
  await database.query('CREATE TABLE DBLog_Players (steamID VARCHAR(255), lastName VARCHAR(255))');
  await database.query(`CREATE TABLE DBLog_Wounds ${event()}`);
  await database.query(`CREATE TABLE DBLog_Deaths ${event()}`);
  await database.query(`CREATE TABLE DBLog_Revives ${event(', reviver VARCHAR(255)')}`);

  await insert('DBLog_Players', [{ steamID: PLAYER, lastName: 'PSG - Ignis ®' }]);
  await insert('DBLog_Wounds', [
    { attacker: PLAYER, victim: ENEMY, teamkill: 0, weapon: 'BP_M4_M68', match: 1 },
    { attacker: PLAYER, victim: ENEMY, teamkill: 0, weapon: 'BP_M4_M68', match: 2 },
    { attacker: PLAYER, victim: ENEMY, teamkill: 0, weapon: 'BP_M9', match: 2 },
    { attacker: PLAYER, victim: TEAMMATE, teamkill: 1, weapon: 'BP_M4_M68', match: 2 },
    { attacker: PLAYER, victim: PLAYER, teamkill: 0, weapon: 'BP_Frag', match: 2 }
  ]);
  await insert('DBLog_Deaths', [
    { attacker: PLAYER, victim: ENEMY, teamkill: 0, weapon: 'BP_M4_M68', match: 1 },
    { attacker: PLAYER, victim: TEAMMATE, teamkill: 1, weapon: 'BP_M4_M68', match: 2 },
    { attacker: PLAYER, victim: PLAYER, teamkill: 0, weapon: 'BP_Frag', match: 2 },
    { attacker: ENEMY, victim: PLAYER, teamkill: 0, weapon: 'BP_AK74M', match: 3 }
  ]);
  await insert('DBLog_Revives', [
    { attacker: ENEMY, victim: TEAMMATE, reviver: PLAYER, match: 1 },
    { attacker: ENEMY, victim: PLAYER, reviver: TEAMMATE, match: 3 }
  ]);
});

after(() => database.close());

describe('DiscordPlayerStats queries', () => {
  it('counts a player without teamkills or self-kills', async () => {
    const stats = await fetchPlayerStats(database, PLAYER);

    assert.deepStrictEqual(
      {
        name: stats.name,
        wounds: stats.wounds,
        kills: stats.kills,
        deaths: stats.deaths,
        revives: stats.revives,
        revived: stats.revived,
        teamkills: stats.teamkills,
        matches: stats.matches,
        deathMatches: stats.deathMatches,
        kd: stats.kd,
        topWeapons: stats.topWeapons
      },
      {
        name: 'PSG - Ignis ®',
        wounds: 3,
        kills: 1,
        deaths: 2,
        revives: 1,
        revived: 1,
        teamkills: 1,
        matches: 3,
        deathMatches: 2,
        kd: 0.5,
        topWeapons: [
          { weapon: 'BP_M4_M68', wounds: 2 },
          { weapon: 'BP_M9', wounds: 1 }
        ]
      }
    );
  });

  it('ranks only players with enough deaths and reports the top share', async () => {
    const board = await fetchLeaderboard(database, 2);

    assert.strictEqual(board.size, 1);
    assert.deepStrictEqual(board.kills, [1]);
    assert.deepStrictEqual(board.wounds, [3]);
    assert.deepStrictEqual(board.woundsPerMatch, [1.5]);
    assert.deepStrictEqual(board.revivesPerMatch, [0.5]);
    assert.strictEqual(topPercent([0, 0, 1, 5, 9], 5), 40);
    assert.strictEqual(topPercent([0, 0, 1, 5, 9], 9), 20);
    assert.strictEqual(topPercent([], 3), null);
  });

  it('gives no ranks to a player below the death minimum', () => {
    const board = {
      kills: [1, 2],
      wounds: [2, 4],
      woundsPerMatch: [1, 2],
      kd: [0.5, 1],
      revivesPerMatch: [0, 1],
      revives: [0, 3]
    };
    const newcomer = { kills: 5, deaths: 1, wounds: 3, revives: 0, deathMatches: 1 };

    assert.deepStrictEqual(rankPlayer(board, newcomer, 20), {});
    assert.deepStrictEqual(rankPlayer(board, { ...newcomer, deaths: 20 }, 20), {
      kills: 1,
      wounds: 50,
      woundsPerMatch: 1,
      kd: 100,
      revivesPerMatch: 100,
      revives: 100
    });
  });
});

describe('DiscordPlayerStats backgrounds', () => {
  it('takes the first decodable image within the size and pixel limits and says why others were skipped', () => {
    const attachment = (name, contentType, size, width = 4000, height = 3000) => ({
      name,
      contentType,
      size,
      width,
      height
    });
    const message = {
      attachments: new Map([
        ['1', attachment('notes.txt', 'text/plain', 10, null, null)],
        ['2', attachment('shot.webp', 'image/webp', 10)],
        ['3', attachment('huge.png', 'image/png', 2000000)],
        ['4', attachment('panorama.jpg', 'image/jpeg', 900000, 16000, 8000)],
        ['5', attachment('tank.jpg', 'image/jpeg', 900000)]
      ])
    };
    const { attachment: chosen, reasons } = backgroundAttachment(message, 1500000);

    assert.strictEqual(chosen.name, 'tank.jpg');
    assert.deepStrictEqual(reasons, [
      'shot.webp is image/webp, use PNG, JPEG or GIF',
      'huge.png is larger than 1.4 MB',
      'panorama.jpg is 16000x8000 pixels, more than 50 megapixels'
    ]);
    assert.strictEqual(backgroundAttachment({ attachments: new Map() }, 30).attachment, null);
  });
});

describe('DiscordPlayerStats highlights', () => {
  const HERO = '76561190000000011';
  const RIVAL = '76561190000000012';
  const TARGET = '76561190000000013';
  const MEDIC = '76561190000000014';
  const highlightsDatabase = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false
  });
  const add = (table, rows) =>
    Promise.all(
      rows.map((row) =>
        highlightsDatabase.query(
          `INSERT INTO ${table} (${Object.keys(row).map((column) => `\`${column}\``)})
           VALUES (${Object.keys(row).map((column) => `:${column}`)})`,
          { replacements: row }
        )
      )
    );

  before(async () => {
    await highlightsDatabase.query(
      'CREATE TABLE DBLog_Players (steamID VARCHAR(255), lastName VARCHAR(255))'
    );
    await highlightsDatabase.query(
      `CREATE TABLE DBLog_Deaths ${event(', time DATETIME').replace('weapon VARCHAR(255), ', '')}`
    );
    await highlightsDatabase.query(`CREATE TABLE DBLog_Revives ${event(', reviver VARCHAR(255)')}`);
    await highlightsDatabase.query(
      `CREATE TABLE DBLog_Matches (id INTEGER PRIMARY KEY, layer VARCHAR(255),
         layerClassname VARCHAR(255), startTime DATETIME)`
    );

    await add('DBLog_Players', [
      { steamID: RIVAL, lastName: 'Rival' },
      { steamID: TARGET, lastName: 'Target' },
      { steamID: MEDIC, lastName: 'Medic' }
    ]);
    await add('DBLog_Matches', [
      {
        id: 1,
        layer: null,
        layerClassname: 'L_SAT_Tallil_Seed_v1',
        startTime: '2026-10-01 10:00:00'
      },
      {
        id: 2,
        layer: 'Mestia AAS v2',
        layerClassname: 'Mestia_AAS_v2',
        startTime: '2026-10-02 10:00:00'
      }
    ]);
    const death = (attacker, victim, match, minute, teamkill = 0) => ({
      attacker,
      victim,
      teamkill,
      match,
      time: `2026-10-0${match} 10:${String(minute).padStart(2, '0')}:00`
    });
    // Match 1: 3 kills, a death, 1 kill. Match 2: 3 kills, a streak of 3 only if it restarts with the match.
    await add('DBLog_Deaths', [
      death(HERO, RIVAL, 1, 1),
      death(HERO, RIVAL, 1, 2),
      death(HERO, TARGET, 1, 3),
      death(RIVAL, HERO, 1, 4),
      death(HERO, RIVAL, 1, 5),
      death(HERO, TARGET, 2, 1),
      death(HERO, TARGET, 2, 2),
      death(HERO, TARGET, 2, 3),
      death(HERO, MEDIC, 2, 4, 1),
      death(RIVAL, HERO, 2, 5),
      death(RIVAL, HERO, 2, 6)
    ]);
    // The medic revived the hero 3 times; the hero revived the medic twice, below the minimum.
    await add('DBLog_Revives', [
      { victim: HERO, reviver: MEDIC, match: 1 },
      { victim: HERO, reviver: MEDIC, match: 2 },
      { victim: HERO, reviver: MEDIC, match: 2 },
      { victim: MEDIC, reviver: HERO, match: 1 },
      { victim: MEDIC, reviver: HERO, match: 2 }
    ]);
  });

  after(() => highlightsDatabase.close());

  it('finds the people, the best match and the longest streak within one match', async () => {
    const highlights = await fetchPlayerHighlights(highlightsDatabase, HERO);

    assert.deepStrictEqual(highlights, {
      nemesis: { steamID: RIVAL, count: 3, name: 'Rival' },
      favoriteVictim: { steamID: TARGET, count: 4, name: 'Target' },
      revivedMost: null,
      revivedByMost: { steamID: MEDIC, count: 3, name: 'Medic' },
      bestMatch: {
        matchID: 1,
        kills: 4,
        layer: 'SAT Tallil Seed v1',
        startTime: new Date('2026-10-01 10:00:00')
      },
      // Equal streaks in both matches: the latest wins.
      longestStreak: {
        matchID: 2,
        kills: 3,
        layer: 'Mestia AAS v2',
        startTime: new Date('2026-10-02 10:00:00')
      }
    });
  });
});
