// Reads RconRecorder files (one JSON line per entry, one file per UTC hour, finished hours gzipped).
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import zlib from 'zlib';

const FILE_PATTERN = /^(\d{4}-\d\d-\d\dT\d\d)\.jsonl(\.gz)?$/;

// Accepts a directory or file paths. Returns the recording files sorted by hour.
export function listRecordingFiles(inputs) {
  const files = [];
  for (const input of inputs) {
    if (fs.statSync(input).isDirectory()) {
      for (const fileName of fs.readdirSync(input))
        if (FILE_PATTERN.test(fileName)) files.push(path.join(input, fileName));
    } else {
      files.push(input);
    }
  }
  return files.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

// Parses "2026-10-02T21:40", "2026-10-02 21:40:15", or "21:40" (taken as UTC on `defaultDate`) into a Date.
export function parseTime(value, defaultDate) {
  if (!value) return null;
  const text = String(value).trim().replace(' ', 'T');
  const withDate = /^\d\d:\d\d/.test(text) ? `${defaultDate}T${text}` : text;
  const date = new Date(/Z$|[+-]\d\d:?\d\d$/.test(withDate) ? withDate : `${withDate}Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid time: ${value}`);
  return date;
}

async function* readLines(file) {
  const input = fs.createReadStream(file);
  const stream = file.endsWith('.gz') ? input.pipe(zlib.createGunzip()) : input;
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) if (line.trim()) yield line;
}

// Yields entries in file order. An entry with "same": true gets the response of the previous entry of the
// same command and keeps "same": true. Each file starts with full responses, so files can be read alone.
// Entries before `from` are read (to resolve "same") but not yielded.
export async function* readEntries(files, { from = null, to = null } = {}) {
  for (const file of files) {
    const hour = path.basename(file).match(FILE_PATTERN)?.[1];
    // A file covers one UTC hour; skip files that end before `from` or start after `to`.
    if (hour && from && new Date(`${hour}:59:59.999Z`) < from) continue;
    if (hour && to && new Date(`${hour}:00:00.000Z`) > to) continue;

    const lastResponses = new Map();
    for await (const line of readLines(file)) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // An unfinished last line of the current hour.
      }
      if (entry.type === 'rcon') {
        if (entry.same) entry.response = lastResponses.get(entry.command) ?? null;
        else lastResponses.set(entry.command, entry.response);
      }
      const time = new Date(entry.time);
      if (from && time < from) continue;
      if (to && time > to) continue;
      yield entry;
    }
  }
}
