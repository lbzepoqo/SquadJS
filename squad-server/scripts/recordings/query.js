// Searches RconRecorder files.
//
// node squad-server/scripts/recordings/query.js <directory or files> [options]
//
//   --from <time> --to <time>   Time range, UTC. "21:40", "21:40:15" or "2026-10-02T21:40".
//                               A time without a date uses the date of the first file (or --date).
//   --type <types>              rcon, rcon-error, push, log (comma separated).
//   --command <name>            RCON command, for example ListPlayers.
//   --grep <text>               Entries that contain the text (case-insensitive). For RCON responses, only
//                               the matching lines of the response are printed.
//   --changes                   RCON entries only when the response differs from the previous response of
//                               the same command.
//   --at <time>                 With --command: print the full response that was current at that time.
//   --stats                     Count entries per hour, type and command.
//   --cut <file>                Write the selected entries to one JSONL file with full responses.
//   --json                      Print the selected entries as JSON lines.
//
// Examples:
//   query.js ./rcon-recordings --command ListPlayers --at 21:40
//   query.js ./rcon-recordings --from 20:00 --to 21:00 --grep "76561198000000000"
//   query.js ./rcon-recordings --type push --from 20:00
//   query.js ./rcon-recordings --from 20:00 --to 21:00 --cut evening.jsonl
import fs from 'fs';
import path from 'path';

import { listRecordingFiles, parseTime, readEntries } from './reader.js';

function parseArguments(argv) {
  const options = { inputs: [] };
  const flags = new Set(['changes', 'stats', 'json']);
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (!argument.startsWith('--')) {
      options.inputs.push(argument);
      continue;
    }
    const name = argument.slice(2);
    if (flags.has(name)) options[name] = true;
    else options[name] = argv[++i];
  }
  return options;
}

function entryText(entry) {
  if (entry.type === 'rcon') return `${entry.command}\n${entry.response ?? ''}`;
  if (entry.type === 'rcon-error') return `${entry.command}\n${entry.error}`;
  if (entry.type === 'push') return entry.body ?? '';
  return entry.line ?? '';
}

function formatEntry(entry, grep) {
  const time = entry.time.slice(11, 23);
  if (entry.type === 'log') return `${time} log   ${entry.line}`;
  if (entry.type === 'push') return `${time} push  ${entry.body}`;
  if (entry.type === 'rcon-error')
    return `${time} error ${entry.command} (${entry.ms} ms): ${entry.error}`;

  const lines = (entry.response ?? '').split('\n');
  const shown = grep ? lines.filter((line) => line.toLowerCase().includes(grep)) : lines;
  const header = `${time} rcon  ${entry.command} (${entry.ms} ms${
    entry.same ? ', unchanged' : ''
  }, ${lines.length} lines)`;
  return [header, ...shown.map((line) => `      ${line}`)].join('\n');
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.inputs.length === 0) {
    console.error(
      'Usage: query.js <directory or files> [options]. See the comment at the top of query.js.'
    );
    process.exit(1);
  }

  const files = listRecordingFiles(options.inputs);
  if (files.length === 0) throw new Error('No recording files found.');
  const defaultDate = options.date || path.basename(files[0]).slice(0, 10);
  const from = parseTime(options.from, defaultDate);
  const to = parseTime(options.to, defaultDate);
  const types = options.type ? new Set(options.type.split(',')) : null;
  const grep = options.grep ? options.grep.toLowerCase() : null;

  if (options.at) {
    if (!options.command) throw new Error('--at needs --command.');
    const at = parseTime(options.at, defaultDate);
    let current = null;
    for await (const entry of readEntries(files, { to: at })) {
      if (entry.type === 'rcon' && entry.command === options.command) current = entry;
    }
    if (!current) {
      console.log(`No ${options.command} response at or before ${at.toISOString()}.`);
      return;
    }
    console.log(`${options.command} at ${current.time} (current at ${at.toISOString()}):`);
    console.log(current.response);
    return;
  }

  const stats = new Map();
  // Compared here, not with "same": files written before "same" existed repeat full responses.
  const previousResponses = new Map();
  const cut = options.cut ? fs.createWriteStream(options.cut) : null;
  let count = 0;
  for await (const entry of readEntries(files, { from, to })) {
    if (types && !types.has(entry.type)) continue;
    if (options.command && entry.command !== options.command) continue;
    if (options.changes && entry.type === 'rcon') {
      const unchanged = previousResponses.get(entry.command) === entry.response;
      previousResponses.set(entry.command, entry.response);
      if (unchanged) continue;
    }
    if (grep && !entryText(entry).toLowerCase().includes(grep)) continue;
    count++;

    if (options.stats) {
      const key = `${entry.time.slice(0, 13)} ${entry.type}${
        entry.command ? ' ' + entry.command : ''
      }`;
      stats.set(key, (stats.get(key) || 0) + 1);
    } else if (cut) {
      const { same, ...full } = entry;
      cut.write(JSON.stringify(full) + '\n');
    } else if (options.json) {
      console.log(JSON.stringify(entry));
    } else {
      console.log(formatEntry(entry, grep));
    }
  }

  if (options.stats) for (const [key, value] of stats) console.log(`${key}: ${value}`);
  if (cut) {
    await new Promise((resolve) => cut.end(resolve));
    console.log(`Wrote ${count} entries to ${options.cut}.`);
  } else if (!options.json && !options.stats) {
    console.log(`${count} entries.`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
