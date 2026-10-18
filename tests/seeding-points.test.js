import assert from 'assert';
import Sequelize from 'sequelize';
import { before, describe, it } from 'node:test';

import {
  MAX_CREDITED_INTERVAL_MS,
  multiplierFor,
  presenceCredits
} from '../squad-server/plugins/seeding-points/points.js';
import {
  defineSeedingDay,
  fetchDayLeaderboard,
  fetchSeedingSummary,
  readDay,
  writeDay
} from '../squad-server/plugins/seeding-points/store.js';

const MULTIPLIERS = [
  { minimumPlayers: 1, multiplier: 3 },
  { minimumPlayers: 5, multiplier: 2 },
  { minimumPlayers: 10, multiplier: 1.5 },
  { minimumPlayers: 20, multiplier: 1 }
];
const SETTINGS = {
  seedingStartPlayerCount: 1,
  livePlayerCount: 35,
  multipliers: MULTIPLIERS,
  activityWindowMs: 15 * 60 * 1000
};
const NOW = Date.UTC(2026, 9, 19, 3, 0, 0);
const HALF_MINUTE = 30 * 1000;

const eosID = (index) => String(index).padStart(32, '0');
const playersOf = (count) =>
  Array.from({ length: count }, (unused, index) => ({
    eosID: eosID(index + 1),
    name: `p${index}`
  }));
const updateOf = (players, time = NOW - HALF_MINUTE) => ({
  time,
  playerCount: players.length,
  eosIDs: new Set(players.map((player) => player.eosID))
});
const allActive = (players) => new Map(players.map((player) => [player.eosID, NOW]));

describe('SeedingPoints presence credits', () => {
  it('uses the band of the player count at the previous update', () => {
    assert.strictEqual(multiplierFor(0, MULTIPLIERS), 0);
    assert.strictEqual(multiplierFor(4, MULTIPLIERS), 3);
    assert.strictEqual(multiplierFor(5, MULTIPLIERS), 2);
    assert.strictEqual(multiplierFor(34, MULTIPLIERS), 1);

    const before = playersOf(4);
    const after = playersOf(5);
    const credits = presenceCredits({
      previousUpdate: updateOf(before),
      players: after,
      now: NOW,
      lastActivityAt: allActive(after),
      settings: SETTINGS
    });
    // The fifth player joined during the interval and is not credited for it.
    assert.strictEqual(credits.length, 4);
    assert.strictEqual(credits[0].minutes, 0.5);
    assert.strictEqual(credits[0].points, 1.5);
  });

  it('credits nothing when live, below the start count, or after a gap', () => {
    const live = playersOf(35);
    const creditsFor = (previousUpdate, players) =>
      presenceCredits({
        previousUpdate,
        players,
        now: NOW,
        lastActivityAt: allActive(players),
        settings: SETTINGS
      });
    assert.strictEqual(creditsFor(updateOf(live), live).length, 0);
    assert.strictEqual(creditsFor(updateOf(playersOf(34)), playersOf(34)).length, 34);
    assert.strictEqual(
      creditsFor(updateOf([]), playersOf(1)).length,
      0,
      'an empty server is not seeding'
    );
    const gap = updateOf(playersOf(3), NOW - MAX_CREDITED_INTERVAL_MS - 1);
    assert.strictEqual(creditsFor(gap, playersOf(3)).length, 0);
    assert.strictEqual(creditsFor(null, playersOf(3)).length, 0);
  });

  it('skips players inactive for longer than the window, unless the window is 0', () => {
    const players = playersOf(3);
    const lastActivityAt = new Map([
      [players[0].eosID, NOW - 15 * 60 * 1000],
      [players[1].eosID, NOW - 15 * 60 * 1000 - 1]
    ]);
    const credited = (settings) =>
      presenceCredits({
        previousUpdate: updateOf(players),
        players,
        now: NOW,
        lastActivityAt,
        settings
      }).map((credit) => credit.player.eosID);
    assert.deepStrictEqual(credited(SETTINGS), [players[0].eosID]);
    assert.strictEqual(credited({ ...SETTINGS, activityWindowMs: 0 }).length, 3);
  });
});

describe('SeedingPoints store', () => {
  const database = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const SeedingDay = defineSeedingDay(database);

  const total = {
    eosID: eosID(1),
    day: '2026-10-19',
    steamID: null,
    name: 'Old',
    minutes: 10,
    points: 30
  };

  before(async () => {
    await SeedingDay.sync();
    await writeDay(SeedingDay, total);
    await writeDay(SeedingDay, {
      eosID: eosID(2),
      day: '2026-10-19',
      steamID: '76561190000000002',
      name: 'B',
      minutes: 5,
      points: 20
    });
    await writeDay(SeedingDay, { ...total, day: '2026-09-01', minutes: 100, points: 100 });
  });

  it('writes absolute totals, so writing the same total again changes nothing', async () => {
    const updated = {
      ...total,
      steamID: '76561190000000001',
      name: 'New',
      minutes: 12,
      points: 36
    };
    await writeDay(SeedingDay, updated);
    await writeDay(SeedingDay, updated);
    const row = await readDay(SeedingDay, eosID(1), '2026-10-19');
    assert.deepStrictEqual(row, updated);
    assert.strictEqual(await readDay(SeedingDay, eosID(3), '2026-10-19'), null);
  });

  it('ranks the day by points and sums the last 30 days and the total', async () => {
    const leaderboard = await fetchDayLeaderboard(SeedingDay, '2026-10-19', 10);
    assert.deepStrictEqual(
      leaderboard.map((row) => [row.name, row.points]),
      [
        ['New', 36],
        ['B', 20]
      ]
    );
    const summary = await fetchSeedingSummary(SeedingDay, { eosID: eosID(1) }, '2026-10-19');
    assert.deepStrictEqual(summary, {
      recentMinutes: 12,
      recentPoints: 36,
      totalMinutes: 112,
      totalPoints: 136
    });
    const bySteamID = await fetchSeedingSummary(
      SeedingDay,
      { steamID: '76561190000000002' },
      '2026-10-19'
    );
    assert.strictEqual(bySteamID.totalPoints, 20);
  });
});
