import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { pipeline } from 'stream/promises';

import BasePlugin from './base-plugin.js';

// Hourly files are named by their UTC hour, for example 2026-10-02T21.jsonl.
const FILE_PATTERN = /^(\d{4}-\d\d-\d\dT\d\d)\.jsonl(\.gz)?$/;

export default class RconRecorder extends BasePlugin {
  static get description() {
    return (
      'The <code>RconRecorder</code> plugin records every RCON command that SquadJS sends with its ' +
      'response, the messages the server pushes over RCON, and optionally every game log line that ' +
      'SquadJS reads. It writes one JSON line per entry into one file per UTC hour, compresses finished ' +
      'hours with gzip, and deletes old files by age and total size. A response that equals the previous ' +
      'response of the same command is written as <code>"same": true</code>. It sends no extra RCON commands.'
    );
  }

  static get defaultEnabled() {
    return false;
  }

  static get optionsSpecification() {
    return {
      directory: {
        required: false,
        description: 'Directory for the recordings, relative to the SquadJS directory.',
        default: './rcon-recordings'
      },
      recordLogLines: {
        required: false,
        description: 'Also record every game log line that SquadJS reads.',
        default: true
      },
      retentionDays: {
        required: false,
        description: 'Files older than this number of days are deleted.',
        default: 14
      },
      maxTotalMB: {
        required: false,
        description:
          'Maximum total size of all recordings in MB. The oldest files are deleted first.',
        default: 1024
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.onLogLine = this.onLogLine.bind(this);
    this.attach = this.attach.bind(this);

    this.wrapped = new WeakSet();
    this.wrappedRcon = null;
    this.logReader = null;
    this.stream = null;
    this.currentHour = null;
    this.writeFailed = false;
  }

  async mount() {
    this.directory = path.resolve(this.options.directory);
    await fs.promises.mkdir(this.directory, { recursive: true });

    // Files of earlier hours that were not compressed, for example after a crash.
    this.currentHour = this.hourOf(new Date());
    for (const fileName of await fs.promises.readdir(this.directory)) {
      const match = fileName.match(FILE_PATTERN);
      if (match && !match[2] && match[1] !== this.currentHour)
        await this.compress(path.join(this.directory, fileName));
    }
    await this.enforceRetention();

    this.openStream();
    this.attach();
    // SquadJS replaces the RCON object and the log parser when they are restarted.
    this.attachInterval = setInterval(this.attach, 10 * 1000);

    this.verbose(1, `Recording to ${this.directory}`);
  }

  async unmount() {
    clearInterval(this.attachInterval);
    if (this.wrappedRcon) {
      delete this.wrappedRcon.execute;
      delete this.wrappedRcon.processChatPacket;
      this.wrappedRcon = null;
    }
    if (this.logReader) this.logReader.removeListener('line', this.onLogLine);
    this.logReader = null;
    if (this.stream) this.stream.end();
    this.stream = null;
  }

  attach() {
    const rcon = this.server.rcon;
    if (rcon && !this.wrapped.has(rcon)) {
      this.wrapRcon(rcon);
      this.wrapped.add(rcon);
      this.wrappedRcon = rcon;
    }

    if (!this.options.recordLogLines) return;
    const reader = this.server.logParser?.logReader?.reader;
    if (reader && reader !== this.logReader) {
      if (this.logReader) this.logReader.removeListener('line', this.onLogLine);
      reader.on('line', this.onLogLine);
      this.logReader = reader;
    }
  }

  wrapRcon(rcon) {
    const execute = rcon.execute;
    const processChatPacket = rcon.processChatPacket;
    const recorder = this;

    rcon.execute = async function (command) {
      const start = new Date();
      try {
        const response = await execute.call(this, command);
        recorder.write({
          time: start.toISOString(),
          type: 'rcon',
          command,
          ms: Date.now() - start.getTime(),
          response
        });
        return response;
      } catch (error) {
        recorder.write({
          time: start.toISOString(),
          type: 'rcon-error',
          command,
          ms: Date.now() - start.getTime(),
          error: error?.message || String(error)
        });
        throw error;
      }
    };

    rcon.processChatPacket = function (decodedPacket) {
      recorder.write({ time: new Date().toISOString(), type: 'push', body: decodedPacket?.body });
      return processChatPacket.call(this, decodedPacket);
    };
  }

  onLogLine(line) {
    this.write({ time: new Date().toISOString(), type: 'log', line });
  }

  write(entry) {
    try {
      const hour = entry.time.slice(0, 13);
      if (hour !== this.currentHour) this.rotate(hour);
      if (!this.stream || this.writeFailed) return;

      // A response that equals the previous response of the same command in this file is written
      // as "same": true. PlayersSquadsList polls ListPlayers and ListSquads every 500 ms, and most
      // of these responses do not change.
      if (entry.type === 'rcon') {
        if (this.lastResponses.get(entry.command) === entry.response) {
          const { response, ...rest } = entry;
          entry = { ...rest, same: true };
        } else {
          this.lastResponses.set(entry.command, entry.response);
        }
      }

      this.stream.write(JSON.stringify(entry) + '\n');
    } catch (error) {
      this.verbose(1, `Could not record an entry: ${error.message}`);
    }
  }

  rotate(hour) {
    const finishedFile = this.filePath(this.currentHour);
    const finishedStream = this.stream;
    this.currentHour = hour;
    this.openStream();

    if (!finishedStream) return;
    // Compression starts after the finished file is closed, and runs without blocking new writes.
    finishedStream.end(() => {
      this.compress(finishedFile)
        .then(() => this.enforceRetention())
        .catch((error) => this.verbose(1, `Could not finish ${finishedFile}: ${error.message}`));
    });
  }

  openStream() {
    this.writeFailed = false;
    // Each file starts with full responses, so it can be read on its own.
    this.lastResponses = new Map();
    this.stream = fs.createWriteStream(this.filePath(this.currentHour), { flags: 'a' });
    this.stream.on('error', (error) => {
      // Writing stops until the next hour opens a new file.
      this.writeFailed = true;
      this.verbose(1, `Could not write ${this.filePath(this.currentHour)}: ${error.message}`);
    });
  }

  async compress(filePath) {
    if (!fs.existsSync(filePath)) return;
    await pipeline(
      fs.createReadStream(filePath),
      zlib.createGzip(),
      fs.createWriteStream(`${filePath}.gz`)
    );
    await fs.promises.unlink(filePath);
  }

  async enforceRetention() {
    const files = [];
    for (const fileName of await fs.promises.readdir(this.directory)) {
      const match = fileName.match(FILE_PATTERN);
      if (!match || match[1] === this.currentHour) continue;
      const filePath = path.join(this.directory, fileName);
      const { size } = await fs.promises.stat(filePath);
      files.push({ filePath, hour: match[1], size });
    }
    files.sort((a, b) => a.hour.localeCompare(b.hour));

    const oldestHourToKeep = this.hourOf(
      new Date(Date.now() - this.options.retentionDays * 24 * 60 * 60 * 1000)
    );
    let totalSize = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files) {
      if (file.hour >= oldestHourToKeep && totalSize <= this.options.maxTotalMB * 1024 * 1024)
        break;
      await fs.promises.unlink(file.filePath);
      totalSize -= file.size;
      this.verbose(1, `Deleted old recording ${path.basename(file.filePath)}`);
    }
  }

  hourOf(date) {
    return date.toISOString().slice(0, 13);
  }

  filePath(hour) {
    return path.join(this.directory, `${hour}.jsonl`);
  }
}
