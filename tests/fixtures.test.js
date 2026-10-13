/**
 * Replays captured game lines through the parsers and compares the emitted events with the
 * expected events. Each folder in tests/fixtures holds the lines of one game version:
 *   <name>.log   SquadGame.log lines, read by the log parser
 *   <name>.txt   RCON chat packet bodies, read by SquadServer
 *   <name>.expected.json   the events these lines must emit, in order
 * Player names and IDs in the fixtures are replaced with placeholders.
 */
import assert from 'assert';
import EventEmitter from 'events';
import fs from 'fs';
import path from 'path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'url';

import SquadLogParser from '../squad-server/log-parser/index.js';
import SquadServer from '../squad-server/index.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

const readLines = (filePath) =>
  fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.length > 0);

const readExpected = (filePath) =>
  JSON.parse(fs.readFileSync(filePath.replace(/\.(log|txt)$/, '.expected.json'), 'utf8'));

const team = (data) =>
  data && {
    team: data.team,
    subfaction: data.subfaction,
    faction: data.faction,
    tickets: data.tickets,
    layer: data.layer,
    level: data.level
  };

const parseLogLines = async (lines) => {
  // The tail reader only stores the path, so no log file is opened.
  const logParser = new SquadLogParser({ mode: 'tail', logDir: fixturesDir });
  await logParser.setupRules();

  const events = [];
  logParser.on('NEW_GAME', (data) =>
    events.push({
      event: 'NEW_GAME',
      layerClassname: data.layerClassname,
      winner: data.winner ?? null,
      layer: data.layer ?? null
    })
  );
  logParser.on('ROUND_ENDED', (data) =>
    events.push({ event: 'ROUND_ENDED', winner: team(data.winner), loser: team(data.loser) })
  );

  for (const line of lines) await logParser.processLine(line);
  return events;
};

const parseChatPackets = async (bodies) => {
  // Runs the RCON event wiring of SquadServer without the constructor, which would start the
  // admin list, layer and player list updates.
  const server = Object.create(SquadServer.prototype);
  EventEmitter.call(server);
  server.options = { host: '127.0.0.1', rconPort: 0, rconPassword: '' };
  server.getPlayerByEOSID = async () => null;
  server.setupRCON();

  const events = [];
  const emit = server.emit.bind(server);
  server.emit = (eventName, data) => {
    if (eventName.startsWith('CHAT_COMMAND:'))
      events.push({ event: eventName, name: data.name, eosID: data.eosID, message: data.message });
    return emit(eventName, data);
  };

  for (const body of bodies) server.rcon.processChatPacket({ body });
  // The chat handler awaits the player lookup before it emits.
  await new Promise((resolve) => setImmediate(resolve));
  return events;
};

const parsers = { '.log': parseLogLines, '.txt': parseChatPackets };

for (const version of fs.readdirSync(fixturesDir)) {
  describe(version, () => {
    for (const fileName of fs.readdirSync(path.join(fixturesDir, version))) {
      const parse = parsers[path.extname(fileName)];
      if (!parse) continue;

      it(fileName, async () => {
        const filePath = path.join(fixturesDir, version, fileName);
        assert.deepStrictEqual(await parse(readLines(filePath)), readExpected(filePath));
      });
    }
  });
}
