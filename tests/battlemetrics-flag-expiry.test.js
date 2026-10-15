import assert from 'assert';
import http from 'http';
import { after, before, beforeEach, describe, it } from 'node:test';

import BattleMetricsFlagClient, {
  selectExpiredFlags
} from '../squad-server/plugins/battlemetrics-flag-expiry/flag-client.js';

const RESTRICTION_FLAG = 'restriction-flag';
const BAN_RECORD_FLAG = 'ban-record-flag';
const DAY_MS = 24 * 60 * 60 * 1000;

const flagRecord = (id, playerID, flagID, addedAt, removedAt = null) => ({
  type: 'flagPlayer',
  id,
  attributes: { addedAt, removedAt },
  relationships: {
    player: { data: { type: 'player', id: playerID } },
    playerFlag: { data: { type: 'playerFlag', id: flagID } }
  }
});

// Minimal stand-in for the BattleMetrics player list (two pages) and the flag delete endpoint.
const requests = [];
let baseURL;

const fakeBattleMetrics = http.createServer((request, response) => {
  requests.push({
    method: request.method,
    url: decodeURIComponent(request.url),
    authorization: request.headers.authorization
  });
  const url = new URL(request.url, baseURL);
  let body = { data: {} };

  if (
    request.method === 'GET' &&
    url.pathname === '/players' &&
    !url.searchParams.has('page[key]')
  ) {
    body = {
      data: [
        { type: 'player', id: '1', attributes: { name: 'Alpha' } },
        { type: 'player', id: '2', attributes: { name: 'Bravo' } }
      ],
      included: [
        flagRecord('a', '1', RESTRICTION_FLAG, '2026-01-01T00:00:00.000Z'),
        flagRecord('b', '1', BAN_RECORD_FLAG, '2024-01-01T00:00:00.000Z'),
        flagRecord(
          'c',
          '2',
          RESTRICTION_FLAG,
          '2025-01-01T00:00:00.000Z',
          '2025-02-01T00:00:00.000Z'
        )
      ],
      links: {
        next: `${baseURL}/players?filter[playerFlags]=${RESTRICTION_FLAG}&include=flagPlayer&page[size]=100&page[key]=2`
      }
    };
  } else if (request.method === 'GET' && url.pathname === '/players') {
    body = {
      data: [{ type: 'player', id: '3', attributes: { name: 'Charlie' } }],
      included: [flagRecord('d', '3', RESTRICTION_FLAG, '2026-10-10T00:00:00.000Z')],
      links: {}
    };
  }

  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
});

before(async () => {
  await new Promise((resolve) => fakeBattleMetrics.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${fakeBattleMetrics.address().port}`;
});

after(() => fakeBattleMetrics.close());

beforeEach(() => {
  requests.length = 0;
});

describe('BattleMetricsFlagClient', () => {
  it('lists only active records of the requested flag across pages', async () => {
    const client = new BattleMetricsFlagClient('token', { baseURL });
    const entries = await client.listActiveFlags(RESTRICTION_FLAG);

    assert.deepStrictEqual(entries, [
      {
        playerID: '1',
        playerName: 'Alpha',
        flagID: RESTRICTION_FLAG,
        addedAt: '2026-01-01T00:00:00.000Z'
      },
      {
        playerID: '3',
        playerName: 'Charlie',
        flagID: RESTRICTION_FLAG,
        addedAt: '2026-10-10T00:00:00.000Z'
      }
    ]);
    assert.strictEqual(requests.length, 2);
    assert.ok(requests.every((request) => request.authorization === 'Bearer token'));
  });

  it('removes a flag through the player flag relationship', async () => {
    const client = new BattleMetricsFlagClient('token', { baseURL });
    await client.removeFlag('1', RESTRICTION_FLAG);

    assert.deepStrictEqual(
      requests.map((request) => `${request.method} ${request.url}`),
      [`DELETE /players/1/relationships/flags/${RESTRICTION_FLAG}`]
    );
  });
});

describe('selectExpiredFlags', () => {
  const now = Date.parse('2026-10-16T00:00:00.000Z');

  it('selects flags older than the maximum age', () => {
    const entries = [
      { playerID: '1', flagID: RESTRICTION_FLAG, addedAt: '2026-10-05T00:00:00.000Z' },
      { playerID: '2', flagID: RESTRICTION_FLAG, addedAt: '2026-10-07T00:00:00.000Z' }
    ];
    assert.deepStrictEqual(
      selectExpiredFlags(entries, 10, now).map((entry) => entry.playerID),
      ['1']
    );
  });

  it('uses the newest record when a player holds the same flag twice', () => {
    const entries = [
      { playerID: '1', flagID: RESTRICTION_FLAG, addedAt: '2026-01-01T00:00:00.000Z' },
      { playerID: '1', flagID: RESTRICTION_FLAG, addedAt: new Date(now - DAY_MS).toISOString() }
    ];
    assert.deepStrictEqual(selectExpiredFlags(entries, 10, now), []);
  });
});
