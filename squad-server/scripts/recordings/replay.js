// Replays RconRecorder files against the real SquadServer and the chosen plugins, on a simulated clock.
//
// node squad-server/scripts/recordings/replay.js <directory or files> --config <config.json> --plugins <names>
//
//   --plugins <names>     Plugins to run, comma separated. Their options come from the config. RconRecorder never runs.
//   --config <file>       SquadJS config. Connectors are replaced: Discord by a stand-in that records every call,
//                         databases by an empty in-memory SQLite database.
//   --from <time> --to <time>  Time range, UTC ("21:40" or "2026-10-02T21:40"). Default: the whole recording.
//   --admins <file>       Admin list in Squad Admins.cfg format. Default: no admins.
//   --out <directory>     Output directory. Default: ./replay-output/<start time>.
//
// How it works:
//   - SquadJS runs on a simulated clock that jumps to the time of each recorded entry, so the timers of SquadJS
//     and of the plugins run as they did on the server, much faster than real time.
//   - RCON: List... and Show... commands are answered with the response recorded at that time. Every other command
//     (AdminWarn, AdminKick, AdminBroadcast ...) is a plugin action: it is written to actions.jsonl and answered with
//     an empty response. The actions of the live server in the same range are written to live-actions.jsonl.
//   - The server information (public queue, player count) changes at the times of the recorded ShowServerInfo
//     responses, as on the server, not on a timer of the replay.
//   - Plugin timers start at --from. For plugins with timers (for example AutoKickUnassigned), set --from to the
//     time the plugins were mounted on the server (after the "Watching" line in the SquadJS log), and replay each
//     SquadJS restart separately, with the plugin code that ran at that time.
//   - Recorded log lines and pushed RCON messages (chat, warns, squad created ...) are fed in at their time.
//   - All network access is blocked, except the download of the layer list. Nothing is sent to Discord, RCON or
//     any other service.
//
// Output: squadjs.log, actions.jsonl, live-actions.jsonl, discord.jsonl, summary.txt.
import EventEmitter from 'events';
import fs from 'fs';
import http from 'http';
import https from 'https';
import os from 'os';
import path from 'path';
import util from 'util';

import FakeTimers from '@sinonjs/fake-timers';
import sequelize from 'sequelize';

import SquadServerFactory from '../../factory.js';
import { Layers } from '../../layers/index.js';
import fetchAdminLists from '../../utils/admin-lists.js';
import { listRecordingFiles, parseTime, readEntries } from './reader.js';

const { Sequelize } = sequelize;
const ALLOWED_HOSTS = new Set(['raw.githubusercontent.com']);
const QUERY_COMMAND = /^(List|Show)\w*/;
const NEVER_REPLAYED = new Set(['RconRecorder']);
const realSetImmediate = setImmediate;

function parseArguments(argv) {
  const options = { inputs: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) options[argv[i].slice(2)] = argv[++i];
    else options.inputs.push(argv[i]);
  }
  return options;
}

function hostOf(target) {
  if (typeof target === 'string') return new URL(target).hostname;
  if (target instanceof URL) return target.hostname;
  return target?.hostname || (target?.host || '').split(':')[0];
}

// Blocks http, https and fetch, except the hosts in ALLOWED_HOSTS.
function blockNetwork(onBlocked) {
  for (const module of [http, https]) {
    for (const method of ['request', 'get']) {
      const original = module[method];
      module[method] = function (...args) {
        const host = hostOf(args[0]);
        if (ALLOWED_HOSTS.has(host)) return original.apply(this, args);
        onBlocked(host);
        throw new Error(`Network access to ${host} is blocked during a replay.`);
      };
    }
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const host = hostOf(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (ALLOWED_HOSTS.has(host)) return originalFetch(input, init);
    onBlocked(host);
    throw new Error(`Network access to ${host} is blocked during a replay.`);
  };
}

// A stand-in object: every property is another stand-in, every call is recorded and returns a stand-in that can
// also be awaited. This lets plugins use Discord without a connection.
function standIn(pathParts, onCall, awaitable = false) {
  return new Proxy(function () {}, {
    get(_, property) {
      if (property === 'then')
        return awaitable ? (resolve) => resolve(standIn(pathParts, onCall)) : undefined;
      if (typeof property === 'symbol') return undefined;
      if (property === 'toString' || property === 'toJSON') return () => `[${pathParts.join('.')}]`;
      return standIn([...pathParts, property], onCall);
    },
    apply(_, __, args) {
      onCall(pathParts.join('.'), args);
      return standIn(
        [...pathParts.slice(0, -1), `${pathParts[pathParts.length - 1]}()`],
        onCall,
        true
      );
    }
  });
}

// An object with real values for some properties and a stand-in for all others.
function withStandIn(values, pathParts, onCall) {
  return new Proxy(values, {
    get(target, property) {
      if (property === 'then' || typeof property === 'symbol' || property in target)
        return target[property];
      return standIn([...pathParts, property], onCall);
    }
  });
}

function makeDiscordClient(onCall) {
  const emitter = new EventEmitter();
  emitter.user = withStandIn(
    { id: '0', tag: 'replay#0000', username: 'replay' },
    ['discord', 'user'],
    onCall
  );
  return new Proxy(emitter, {
    get(target, property) {
      // Not awaitable, so `await createConnector()` returns the client itself.
      if (property === 'then' || typeof property === 'symbol') return target[property];
      if (property in target) {
        const value = target[property];
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return standIn(['discord', property], onCall);
    }
  });
}

function summarizeArguments(args) {
  return args.map((argument) => {
    if (typeof argument === 'string') return argument;
    try {
      return JSON.parse(JSON.stringify(argument));
    } catch {
      return util.inspect(argument, { depth: 2 });
    }
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.inputs.length === 0 || !options.config || !options.plugins) {
    console.error(
      'Usage: replay.js <recordings> --config <file> --plugins <names>. See the top of replay.js.'
    );
    process.exit(1);
  }

  const files = listRecordingFiles(options.inputs);
  if (files.length === 0) throw new Error('No recording files found.');
  const defaultDate = options.date || path.basename(files[0]).slice(0, 10);
  let from = parseTime(options.from, defaultDate);
  const to = parseTime(options.to, defaultDate);

  // The responses that were current when the replay starts. A command first answered within one minute after
  // the start is also used, so SquadJS starts with data.
  const responses = new Map();
  for await (const entry of readEntries(files, {
    to: from ? new Date(from.getTime() + 60000) : null
  })) {
    from = from || new Date(entry.time);
    const time = new Date(entry.time);
    if (time > new Date(from.getTime() + 60000)) break;
    if (entry.type !== 'rcon' || !QUERY_COMMAND.test(entry.command)) continue;
    if (time <= from || !responses.has(entry.command)) responses.set(entry.command, entry.response);
  }
  if (!from) throw new Error('The recording has no entries in this range.');

  const outputDirectory = path.resolve(
    options.out || path.join('replay-output', from.toISOString().replace(/[:.]/g, '-'))
  );
  fs.mkdirSync(outputDirectory, { recursive: true });
  const outputs = {};
  for (const name of ['squadjs.log', 'actions.jsonl', 'live-actions.jsonl', 'discord.jsonl'])
    outputs[name] = fs.createWriteStream(path.join(outputDirectory, name));
  const counts = {
    queries: {},
    actions: {},
    liveActions: {},
    discordCalls: {},
    blockedHosts: {},
    errors: 0,
    entries: 0
  };
  const increment = (map, key) => (map[key] = (map[key] || 0) + 1);

  // SquadJS writes its log with console.log; it goes to squadjs.log.
  const write = (...args) => outputs['squadjs.log'].write(util.format(...args) + '\n');
  console.log = write;
  console.info = write;
  console.warn = write;
  console.error = write;
  process.on('unhandledRejection', (error) => {
    counts.errors++;
    write('Unhandled rejection:', error);
  });
  process.on('uncaughtException', (error) => {
    counts.errors++;
    write('Uncaught exception:', error);
  });

  blockNetwork((host) => increment(counts.blockedHosts, host));

  const config = JSON.parse(fs.readFileSync(options.config, 'utf8'));
  const pluginNames = new Set(options.plugins.split(',').map((name) => name.trim()));
  for (const name of pluginNames) {
    if (NEVER_REPLAYED.has(name)) throw new Error(`${name} cannot run in a replay.`);
    if (!config.plugins.some((plugin) => plugin.plugin === name))
      throw new Error(`Plugin ${name} is not in the config.`);
  }
  config.plugins = config.plugins.map((plugin) => ({
    ...plugin,
    enabled: pluginNames.has(plugin.plugin)
  }));
  const logDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'squadjs-replay-'));
  fs.writeFileSync(path.join(logDirectory, 'SquadGame.log'), '');
  config.server = {
    ...config.server,
    logReaderMode: 'tail',
    logDir: logDirectory,
    adminLists: options.admins ? [{ type: 'local', source: path.resolve(options.admins) }] : []
  };
  config.logger = { ...config.logger, timestamps: true };

  SquadServerFactory.createConnector = async (_server, type, name) => {
    if (type === 'discord')
      return makeDiscordClient((call, args) => {
        increment(counts.discordCalls, call);
        outputs['discord.jsonl'].write(
          JSON.stringify({ time: new Date().toISOString(), call, args: summarizeArguments(args) }) +
            '\n'
        );
      });
    if (type === 'sequelize') return new Sequelize('sqlite::memory:', { logging: false });
    return standIn([type, name], () => {});
  };

  const clock = FakeTimers.install({
    now: from,
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
  });

  const server = await SquadServerFactory.buildFromConfig(config);
  const rcon = server.rcon;
  rcon.connect = async () => {};
  rcon.disconnect = async () => {};
  rcon.connected = true;
  rcon.execute = async (command) => {
    if (!QUERY_COMMAND.test(command)) {
      increment(counts.actions, command.split(' ')[0]);
      outputs['actions.jsonl'].write(
        JSON.stringify({ time: new Date().toISOString(), command }) + '\n'
      );
      return '';
    }
    increment(counts.queries, command);
    return responses.get(command) ?? '';
  };
  server.pingSquadJSAPI = async () => {};

  // The same steps as SquadServer.watch(), without network access and without the log file reader.
  await Layers.pull();
  server.admins = await fetchAdminLists(config.server.adminLists);
  await server.updateSquadList();
  await server.updatePlayerList();
  await server.updateLayerInformation();
  await server.updateA2SInformation();
  // Only SquadServer sends ShowServerInfo, so every recorded ShowServerInfo is one of its updates. Its timer
  // starts again after each response and drifts by the response time, so a timer in the replay runs at other
  // times than on the server. The replay updates the server information at the recorded times instead.
  clearTimeout(server.updateA2SInformationTimeout);
  // SquadLogParser loads its rules in watch(), which also starts the file reader that a replay does not use.
  await server.logParser.setupRules();
  server.logParser.parsingStatsInterval = setInterval(server.logParser.logStats, 60 * 1000);
  await Promise.all(server.plugins.map((plugin) => plugin.mount()));

  const reader = server.logParser.logReader.reader;
  let lastTime = from.getTime();
  for await (const entry of readEntries(files, { from, to })) {
    // Entries are written when a command finishes, so their start times can be slightly out of order.
    const time = Math.max(lastTime, Date.parse(entry.time));
    await clock.tickAsync(time - clock.now);
    lastTime = time;
    counts.entries++;

    if (entry.type === 'rcon') {
      if (entry.command === 'ShowServerInfo') {
        // The server information changed on the server when the response arrived.
        const response = entry.response;
        setTimeout(async () => {
          responses.set(entry.command, response);
          await server.updateA2SInformation();
          clearTimeout(server.updateA2SInformationTimeout);
        }, Math.max(0, Date.parse(entry.time) + (entry.ms || 0) - clock.now));
      } else if (QUERY_COMMAND.test(entry.command)) {
        responses.set(entry.command, entry.response);
      } else {
        increment(counts.liveActions, entry.command.split(' ')[0]);
        outputs['live-actions.jsonl'].write(
          JSON.stringify({ time: entry.time, command: entry.command }) + '\n'
        );
      }
    } else if (entry.type === 'push') {
      rcon.processChatPacket({ body: entry.body });
    } else if (entry.type === 'log') {
      reader.emit('line', entry.line);
    }

    // Lets real I/O (for example the in-memory database) continue between simulated steps.
    if (counts.entries % 200 === 0) await new Promise((resolve) => realSetImmediate(resolve));
  }
  await clock.tickAsync(5000);
  await new Promise((resolve) => realSetImmediate(resolve));

  const lines = [
    `Replay of ${from.toISOString()} to ${new Date(lastTime).toISOString()}, ${
      counts.entries
    } entries.`,
    `Plugins: ${[...pluginNames].join(', ')}`,
    `RCON queries answered from the recording: ${JSON.stringify(counts.queries)}`,
    `Plugin actions (replay): ${JSON.stringify(counts.actions)}`,
    `Actions on the live server: ${JSON.stringify(counts.liveActions)}`,
    `Discord calls: ${JSON.stringify(counts.discordCalls)}`,
    `Blocked network hosts: ${JSON.stringify(counts.blockedHosts)}`,
    `Errors: ${counts.errors}`,
    `Output: ${outputDirectory}`
  ];
  fs.writeFileSync(path.join(outputDirectory, 'summary.txt'), lines.join('\n') + '\n');
  await Promise.all(
    Object.values(outputs).map((stream) => new Promise((resolve) => stream.end(resolve)))
  );
  process.stdout.write(lines.join('\n') + '\n');
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
