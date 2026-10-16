import assert from 'assert';
import Sequelize from 'sequelize';
import { after, before, describe, it } from 'node:test';

import {
  fetchLeaderboard,
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
  it('takes the first decodable image within the size limit and says why others were skipped', () => {
    const attachment = (name, contentType, size) => ({ name, contentType, size });
    const message = {
      attachments: new Map([
        ['1', attachment('notes.txt', 'text/plain', 10)],
        ['2', attachment('shot.webp', 'image/webp', 10)],
        ['3', attachment('huge.png', 'image/png', 50)],
        ['4', attachment('tank.jpg', 'image/jpeg', 20)]
      ])
    };
    const { attachment: chosen, reasons } = backgroundAttachment(message, 30);

    assert.strictEqual(chosen.name, 'tank.jpg');
    assert.deepStrictEqual(reasons, [
      'shot.webp is image/webp, use PNG or JPEG',
      'huge.png is larger than 0 MB'
    ]);
    assert.strictEqual(backgroundAttachment({ attachments: new Map() }, 30).attachment, null);
  });
});
