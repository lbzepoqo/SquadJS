import assert from 'assert';
import { describe, it } from 'node:test';

import CommanderTracker from '../squad-server/plugins/commander-resign-alert/tracker.js';

const commander = {
  name: 'Commander',
  eosID: 'eos-commander',
  steamID: '76561190000000001',
  teamID: 2,
  squadID: 11,
  isLeader: true
};

function squad(squadName) {
  return {
    teamID: 2,
    teamName: 'WPMC',
    squadID: 11,
    squadName,
    creatorName: 'Commander',
    creatorEOSID: 'eos-commander'
  };
}

describe('CommanderTracker', () => {
  it('reports a resign with the time command was held', () => {
    const tracker = new CommanderTracker('Command Squad');
    tracker.update([squad('Squad 11')], [commander], 0);
    tracker.update([squad('Command Squad')], [commander], 55000);
    const resigns = tracker.update([squad('Squad 11')], [commander], 98000);

    assert.strictEqual(resigns.length, 1);
    assert.strictEqual(resigns[0].commander.name, 'Commander');
    assert.strictEqual(resigns[0].heldMs, 43000);
  });

  it('does not report a commander who disconnected or a squad that disappeared', () => {
    const tracker = new CommanderTracker('Command Squad');
    tracker.update([], [commander], 0);
    tracker.update([squad('Command Squad')], [commander], 1000);
    assert.deepStrictEqual(tracker.update([squad('Squad 11')], [], 2000), []);

    tracker.update([squad('Command Squad')], [commander], 3000);
    assert.deepStrictEqual(tracker.update([], [commander], 4000), []);
  });

  it('does not report a term that was already running at the first update', () => {
    const tracker = new CommanderTracker('Command Squad');
    tracker.update([squad('Command Squad')], [commander], 0);
    assert.deepStrictEqual(tracker.update([squad('Squad 11')], [commander], 1000), []);
  });
});
