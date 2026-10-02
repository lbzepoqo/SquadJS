import fs from "fs";
import path from "path";
import inspector from "inspector";
import asyncHooks from "async_hooks";
import { performance } from "perf_hooks";
import BasePlugin from "./base-plugin.js";

export default class CpuProfiler extends BasePlugin {
  static get description() {
    return (
      "Diagnostics: logs the CPU use of the SquadJS process and the event loop utilization of the main thread, " +
      "and writes CPU profiles of the main thread to disk."
    );
  }

  static get defaultEnabled() {
    return false;
  }

  static get optionsSpecification() {
    return {
      statsInterval: {
        required: false,
        description: "Milliseconds between CPU and event loop log lines.",
        default: 60000,
      },
      profileInterval: {
        required: false,
        description:
          "Milliseconds between the start of two CPU profiles. The first profile starts after one interval.",
        default: 1200000,
      },
      profileDuration: {
        required: false,
        description: "Length of one CPU profile in milliseconds.",
        default: 60000,
      },
      maxProfiles: {
        required: false,
        description: "Number of CPU profiles to write before profiling stops.",
        default: 0,
      },
      database: {
        required: false,
        connector: "sequelize",
        description:
          "Sequelize connector whose queries are timed. Leave empty to skip query timing.",
        default: "sqlite",
      },
      slowQueryMs: {
        required: false,
        description:
          "Queries that take at least this many milliseconds are counted in the slow query summary.",
        default: 200,
      },
      outputDir: {
        required: false,
        description:
          "Folder for the .cpuprofile files, relative to the SquadJS folder.",
        default: "cpu-profiles",
      },
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.logStats = this.logStats.bind(this);
    this.startProfile = this.startProfile.bind(this);
    this.profilesWritten = 0;
  }

  async mount() {
    this.lastCpuUsage = process.cpuUsage();
    this.lastTime = performance.now();
    this.lastLoopUtilization = performance.eventLoopUtilization();
    this.lastThreadTicks = this.readThreadTicks();
    // Counts async resources by type, to show which operations feed the libuv thread pool.
    this.asyncTypeCounts = new Map();
    this.asyncHook = asyncHooks
      .createHook({
        init: (_asyncId, type) => {
          this.asyncTypeCounts.set(
            type,
            (this.asyncTypeCounts.get(type) || 0) + 1
          );
        },
      })
      .enable();
    this.wrapDatabaseQuery();
    this.statsTimer = setInterval(this.logStats, this.options.statsInterval);
    this.profileTimer = setInterval(
      this.startProfile,
      this.options.profileInterval
    );
    this.verbose(1, "Mounted.");
  }

  async unmount() {
    clearInterval(this.statsTimer);
    clearInterval(this.profileTimer);
    if (this.asyncHook) this.asyncHook.disable();
    if (this.originalQuery) this.options.database.query = this.originalQuery;
    if (this.session) this.session.disconnect();
  }

  // All plugins share one Sequelize instance per connector, and model calls also go through
  // sequelize.query, so timing that method covers every query. The time includes waiting for a
  // free thread in the libuv pool.
  wrapDatabaseQuery() {
    this.queryStats = new Map();
    this.queryCount = 0;
    this.queryTotalMs = 0;
    const database = this.options.database;
    if (!database || typeof database.query !== "function") return;

    const originalQuery = database.query.bind(database);
    database.query = async (sql, queryOptions) => {
      const start = performance.now();
      try {
        return await originalQuery(sql, queryOptions);
      } finally {
        const durationMs = performance.now() - start;
        this.queryCount++;
        this.queryTotalMs += durationMs;
        if (durationMs >= this.options.slowQueryMs) {
          const text =
            typeof sql === "string" ? sql : sql?.query || String(sql);
          const key = text.replace(/\s+/g, " ").trim().slice(0, 160);
          const entry = this.queryStats.get(key) || { count: 0, totalMs: 0 };
          entry.count++;
          entry.totalMs += durationMs;
          this.queryStats.set(key, entry);
        }
      }
    };
    this.originalQuery = originalQuery;
  }

  // Returns user + system clock ticks per thread ID from /proc (Linux only; empty elsewhere).
  readThreadTicks() {
    const ticks = new Map();
    try {
      for (const threadID of fs.readdirSync("/proc/self/task")) {
        const stat = fs.readFileSync(
          `/proc/self/task/${threadID}/stat`,
          "utf8"
        );
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        ticks.set(threadID, Number(fields[11]) + Number(fields[12]));
      }
    } catch (error) {
      this.verbose(2, `Could not read thread CPU: ${error.message}`);
    }
    return ticks;
  }

  logStats() {
    const now = performance.now();
    const cpuUsage = process.cpuUsage(this.lastCpuUsage);
    const elapsedMicroseconds = (now - this.lastTime) * 1000;
    const processCpuPercent =
      ((cpuUsage.user + cpuUsage.system) / elapsedMicroseconds) * 100;
    const loopUtilization = performance.eventLoopUtilization(
      this.lastLoopUtilization
    );
    const memory = process.memoryUsage();

    this.verbose(
      1,
      `Process CPU: ${processCpuPercent.toFixed(1)}% (user ${(
        cpuUsage.user / 1000
      ).toFixed(0)} ms, ` +
        `system ${(cpuUsage.system / 1000).toFixed(
          0
        )} ms) | Main thread busy: ` +
        `${(loopUtilization.utilization * 100).toFixed(1)}% | Players: ${
          this.server.players.length
        } | ` +
        `RSS ${Math.round(memory.rss / 1048576)} MB, heap ${Math.round(
          memory.heapUsed / 1048576
        )} MB`
    );

    // Clock ticks are 10 ms each (CLK_TCK 100 on Linux x86-64). The main thread ID equals the process ID.
    const threadTicks = this.readThreadTicks();
    const elapsedTicks = (elapsedMicroseconds / 1000000) * 100;
    const busyThreads = [...threadTicks]
      .map(([threadID, ticks]) => [
        threadID,
        ((ticks - (this.lastThreadTicks.get(threadID) || 0)) / elapsedTicks) *
          100,
      ])
      .filter(([, percent]) => percent >= 1)
      .sort((first, second) => second[1] - first[1])
      .map(
        ([threadID, percent]) =>
          `${threadID}${
            threadID === String(process.pid) ? " (main)" : ""
          } ${percent.toFixed(0)}%`
      );
    this.verbose(
      1,
      `Threads: ${threadTicks.size} | Busy threads: ${
        busyThreads.join(", ") || "none"
      }`
    );
    this.lastThreadTicks = threadTicks;

    const asyncTypes = [...this.asyncTypeCounts]
      .sort((first, second) => second[1] - first[1])
      .slice(0, 10)
      .map(([type, count]) => `${type} ${count}`);
    this.verbose(1, `Async operations started: ${asyncTypes.join(", ")}`);
    this.asyncTypeCounts.clear();

    const slowQueries = [...this.queryStats]
      .sort((first, second) => second[1].totalMs - first[1].totalMs)
      .slice(0, 5)
      .map(
        ([key, entry]) =>
          `${entry.count}x ${Math.round(entry.totalMs)} ms: ${key}`
      );
    this.verbose(
      1,
      `Database: ${this.queryCount} queries, ${Math.round(
        this.queryTotalMs
      )} ms total | Slow queries: ${
        slowQueries.length ? "\n  " + slowQueries.join("\n  ") : "none"
      }`
    );
    this.queryStats.clear();
    this.queryCount = 0;
    this.queryTotalMs = 0;

    this.lastCpuUsage = process.cpuUsage();
    this.lastTime = now;
    this.lastLoopUtilization = performance.eventLoopUtilization();
  }

  startProfile() {
    if (this.session || this.profilesWritten >= this.options.maxProfiles)
      return;

    this.session = new inspector.Session();
    this.session.connect();
    this.session.post("Profiler.enable", () => {
      this.session.post("Profiler.start", () => {
        this.verbose(
          1,
          `CPU profile started (${this.server.players.length} players).`
        );
        setTimeout(() => this.stopProfile(), this.options.profileDuration);
      });
    });
  }

  stopProfile() {
    this.session.post("Profiler.stop", (error, result) => {
      try {
        if (error) throw error;
        fs.mkdirSync(this.options.outputDir, { recursive: true });
        const fileName = `squadjs-${new Date()
          .toISOString()
          .replace(/[:.]/g, "-")}.cpuprofile`;
        fs.writeFileSync(
          path.join(this.options.outputDir, fileName),
          JSON.stringify(result.profile)
        );
        this.profilesWritten++;
        this.verbose(
          1,
          `CPU profile written: ${fileName} (${this.profilesWritten}/${this.options.maxProfiles}).`
        );
      } catch (writeError) {
        this.verbose(1, `CPU profile failed: ${writeError.message}`);
      } finally {
        this.session.disconnect();
        this.session = null;
      }
    });
  }
}
