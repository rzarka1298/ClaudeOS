import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseTranscriptChunk, TRANSCRIPT_PARSER_VERSION } from "@ccc/collectors";
import { newRunId, UsageSummarySchema } from "@ccc/domain";
import {
  appendToggleLog,
  applyMigrations,
  getCollectorSetting,
  latestRunBySession,
  type OperationalStore,
  openStore,
  queryTokenActivity,
  readCursor,
  setCollectorSetting,
} from "@ccc/operational-store";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../events/event-bus.js";
import { createClaudePipeline, type SessionFactsProvider } from "./pipeline.js";
import {
  createTranscriptJob,
  nodeTranscriptIo,
  TRANSCRIPT_CHUNK_BYTES,
  TRANSCRIPT_PARSER_VERSION_SETTING,
  type TranscriptJobDeps,
} from "./transcript-job.js";
import { startUsageServices, TRANSCRIPT_ANALYSIS_SETTING } from "./usage-services.js";
import { buildUsageSummary, EMPTY_STATUS_LINE_OBSERVATION, localDayOf } from "./usage-summary.js";

// Every transcript here is synthetic, written into a temp dir under the
// test base; the owner's real Claude config dir is never read (PRIV-04).
const TEST_BASE = join(homedir(), ".ccc-test");
const SENTINEL = "CCC-TRANSCRIPT-SENTINEL";
const TZ = "America/New_York";
const NOW = new Date("2026-09-20T16:00:00.000Z");
const WIDE = { start: "2020-01-01T00:00:00.000Z", end: "2030-01-01T00:00:00.000Z" };
const silent = pino({ level: "silent" });

interface Usage {
  readonly input: number;
  readonly output: number;
  readonly cacheWrite: number;
  readonly cacheRead: number;
}

/** One assistant record line, shaped like Claude Code's (RESEARCH Q8), content planted with the sentinel. */
function assistantLine(options: {
  messageId: string;
  sessionId: string;
  usage?: Usage;
  version?: string;
  model?: string;
  timestamp?: string;
  withUsage?: boolean;
}): string {
  const usage = options.usage ?? { input: 1, output: 1, cacheWrite: 1, cacheRead: 1 };
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    cwd: "/Users/USERNAME/code/synthetic-project",
    sessionId: options.sessionId,
    version: options.version ?? "2.1.283",
    gitBranch: "main",
    message: {
      id: options.messageId,
      type: "message",
      role: "assistant",
      model: options.model ?? "claude-opus-4-8",
      content: [{ type: "text", text: `${SENTINEL} assistant words` }],
      ...(options.withUsage === false
        ? {}
        : {
            usage: {
              input_tokens: usage.input,
              output_tokens: usage.output,
              cache_creation_input_tokens: usage.cacheWrite,
              cache_read_input_tokens: usage.cacheRead,
            },
          }),
    },
    type: "assistant",
    uuid: randomUUID(),
    timestamp: options.timestamp ?? "2026-09-20T12:00:00.000Z",
  });
}

function userLine(sessionId: string): string {
  return JSON.stringify({
    type: "user",
    sessionId,
    version: "2.1.283",
    message: { role: "user", content: `${SENTINEL} a synthetic prompt` },
    timestamp: "2026-09-20T11:59:00.000Z",
  });
}

function lines(...items: string[]): string {
  return items.map((item) => `${item}\n`).join("");
}

const A1 = { input: 10, output: 100, cacheWrite: 1000, cacheRead: 10000 };
const A2 = { input: 5, output: 50, cacheWrite: 500, cacheRead: 5000 };
const B1 = { input: 1, output: 2, cacheWrite: 3, cacheRead: 4 };
const C1 = { input: 7, output: 70, cacheWrite: 700, cacheRead: 7000 };
const S1 = { input: 2, output: 20, cacheWrite: 200, cacheRead: 2000 };
/** Hand-computed: each message id once, whatever lines or files repeat it. */
const EXPECTED_TOTALS = { input: 25, output: 242, cacheWrite: 2403, cacheRead: 24004 };

let dir: string;
let root: string;
let store: OperationalStore;
let enabled: boolean;

function file(...segments: string[]): string {
  return join(root, ...segments);
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** Three session files and one subagent file; msg_a1 spans lines and reappears in the subagent file. */
function writeFixture(): void {
  write(
    file("-synthetic-alpha", "sess-a.jsonl"),
    lines(
      userLine("sess-a"),
      assistantLine({ messageId: "msg_a1", sessionId: "sess-a", usage: A1 }),
      assistantLine({ messageId: "msg_a1", sessionId: "sess-a", usage: A1 }),
      assistantLine({ messageId: "msg_a1", sessionId: "sess-a", usage: A1 }),
      userLine("sess-a"),
      assistantLine({ messageId: "msg_a2", sessionId: "sess-a", usage: A2 }),
    ),
  );
  write(
    file("-synthetic-alpha", "sess-b.jsonl"),
    lines(
      assistantLine({ messageId: "msg_b1", sessionId: "sess-b", usage: B1 }),
      assistantLine({ messageId: "msg_b1", sessionId: "sess-b", usage: B1 }),
    ),
  );
  write(
    file("-synthetic-beta", "sess-c.jsonl"),
    lines(assistantLine({ messageId: "msg_c1", sessionId: "sess-c", usage: C1 })),
  );
  write(
    file("-synthetic-alpha", "sess-a", "subagents", "agent-x.jsonl"),
    lines(
      assistantLine({ messageId: "msg_s1", sessionId: "sess-a", usage: S1 }),
      assistantLine({ messageId: "msg_a1", sessionId: "sess-a", usage: A1 }),
    ),
  );
}

function spies() {
  const io = nodeTranscriptIo();
  return {
    readChunk: vi.fn(io.readChunk),
    stat: vi.fn(io.stat),
    listFiles: vi.fn(io.listFiles),
    parse: vi.fn(parseTranscriptChunk),
  };
}

function makeJob(io: ReturnType<typeof spies>, overrides: Partial<TranscriptJobDeps> = {}) {
  return createTranscriptJob({
    db: store.db,
    logger: silent,
    claudeProjectsRoot: root,
    ...io,
    now: () => NOW,
    isEnabled: () => enabled,
    dayOf: (iso) => localDayOf(iso, TZ),
    cleanupPeriodDays: () => 30,
    yieldNow: () => Promise.resolve(),
    ...overrides,
  });
}

beforeEach(() => {
  mkdirSync(TEST_BASE, { recursive: true });
  dir = mkdtempSync(join(TEST_BASE, "tj-"));
  root = join(dir, "claude", "projects");
  mkdirSync(root, { recursive: true });
  store = openStore(join(dir, "operational.db"));
  applyMigrations(store.db);
  enabled = true;
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the analysis gate (Test 1, D-03, D-47, USAGE-07)", () => {
  it("with analysis off, a Stop settle, the sweep timer and the startup sweep never read or parse a transcript", async () => {
    writeFixture();
    const transcriptPath = file("-synthetic-alpha", "sess-a.jsonl");
    const facts: SessionFactsProvider = {
      factsFor: async () => ({
        pidStartedAt: null,
        launchSource: null,
        projectId: null,
        worktreeRoot: null,
        transcriptPath,
      }),
    };
    const bus = createEventBus();
    const pipeline = createClaudePipeline({
      db: store.db,
      bus,
      logger: silent,
      now: () => new Date(),
      mintRunId: newRunId,
      facts,
    });
    const io = spies();
    const usage = startUsageServices({
      db: store.db,
      bus,
      pipeline,
      poller: { setStatusLineSink() {}, dropCount: () => 0 },
      logger: silent,
      env: { CCC_TRANSCRIPT_SWEEP_MS: "10" },
      now: () => new Date(),
      claudeProjectsRoot: root,
      transcriptIo: io,
      settingsFacts: () => ({ statusLine: "not-installed", cleanupPeriodDays: 30 }),
    });
    usage.start();
    const record = (event: string, extra: Record<string, unknown> = {}) => ({
      eventId: randomUUID(),
      observedAt: new Date().toISOString(),
      hook_event_name: event,
      session_id: "sess-a",
      cwd: join(dir, "code"),
      env: { CLAUDE_PID: "4242" },
      ...extra,
    });
    expect(await pipeline.ingest(record("SessionStart", { source: "startup" }), "socket")).toBe(
      "applied",
    );
    expect(await pipeline.ingest(record("Stop"), "socket")).toBe("applied");
    await new Promise((resolve) => setTimeout(resolve, 80));
    await usage.stop();
    await pipeline.stop();

    // Hook ingest kept working: the Run exists and carries the transcript path.
    expect(latestRunBySession(store.db, "sess-a")?.transcriptPath).toBe(transcriptPath);
    expect(io.listFiles).not.toHaveBeenCalled();
    expect(io.stat).not.toHaveBeenCalled();
    expect(io.readChunk).not.toHaveBeenCalled();
    expect(io.parse).not.toHaveBeenCalled();
    expect(usage.summary().ranges.today.activity).toEqual({
      kind: "unavailable",
      reason: "analysis-off",
      version: null,
    });
  });

  it("with analysis on, a Stop settle scans that Run's transcript off the ingest path and publishes usage.updated once", async () => {
    writeFixture();
    setCollectorSetting(store.db, TRANSCRIPT_ANALYSIS_SETTING, "true", NOW.toISOString());
    const transcriptPath = file("-synthetic-beta", "sess-c.jsonl");
    const bus = createEventBus();
    const pipeline = createClaudePipeline({
      db: store.db,
      bus,
      logger: silent,
      now: () => new Date(),
      mintRunId: newRunId,
      facts: {
        factsFor: async () => ({
          pidStartedAt: null,
          launchSource: null,
          projectId: null,
          worktreeRoot: null,
          transcriptPath,
        }),
      },
    });
    const io = spies();
    const usage = startUsageServices({
      db: store.db,
      bus,
      pipeline,
      poller: { setStatusLineSink() {}, dropCount: () => 0 },
      logger: silent,
      env: {},
      now: () => new Date(),
      claudeProjectsRoot: root,
      transcriptIo: io,
      settingsFacts: () => ({ statusLine: "not-installed", cleanupPeriodDays: 30 }),
    });
    const record = (event: string, extra: Record<string, unknown> = {}) => ({
      eventId: randomUUID(),
      observedAt: new Date().toISOString(),
      hook_event_name: event,
      session_id: "sess-c",
      cwd: join(dir, "code"),
      env: { CLAUDE_PID: "4343" },
      ...extra,
    });
    await pipeline.ingest(record("SessionStart", { source: "startup" }), "socket");
    await pipeline.ingest(record("Stop"), "socket");
    // The settle listener only schedules; nothing was read inside ingest.
    await vi.waitFor(() => {
      expect(queryTokenActivity(store.db, WIDE).totals).toEqual(C1);
    });
    expect(io.listFiles).not.toHaveBeenCalled();
    expect(io.readChunk.mock.calls.every(([path]) => path === transcriptPath)).toBe(true);
    await vi.waitFor(() => {
      const replay = bus.buffer.since(0);
      if (replay.mode !== "replay") throw new Error("expected a replay");
      expect(replay.events.filter((e) => e.type === "usage.updated")).toHaveLength(1);
    });
    await usage.stop();
    await pipeline.stop();
  });
});

describe("scanning (Test 2, D-40, PR-11, USAGE-01)", () => {
  it("sweeps session and subagent files into hourly aggregates, counting each message id once", async () => {
    writeFixture();
    const io = spies();
    const job = makeJob(io);
    const outcome = await job.sweep();
    expect(outcome.completed).toBe(true);
    expect(outcome.files).toBe(4);

    const activity = queryTokenActivity(store.db, WIDE);
    expect(activity.totals).toEqual(EXPECTED_TOTALS);
    expect(activity.byModel).toEqual([{ model: "claude-opus-4-8", counters: EXPECTED_TOTALS }]);

    // A second sweep over unchanged files reads nothing more and counts nothing twice.
    io.readChunk.mockClear();
    await job.sweep();
    expect(io.readChunk).not.toHaveBeenCalled();
    expect(queryTokenActivity(store.db, WIDE).totals).toEqual(EXPECTED_TOTALS);
  });

  it("keeps no transcript content in the store (D-49)", async () => {
    writeFixture();
    await makeJob(spies()).sweep();
    store.db.pragma("wal_checkpoint(TRUNCATE)");
    const dbPath = join(dir, "operational.db");
    for (const path of [dbPath, `${dbPath}-wal`]) {
      if (existsSync(path)) expect(readFileSync(path).includes(SENTINEL)).toBe(false);
    }
  });

  it("reads in chunks no larger than 256 KiB, even when asked for more", async () => {
    const path = file("-synthetic-big", "sess-big.jsonl");
    const many: string[] = [];
    for (let i = 0; i < 2500; i += 1) {
      many.push(assistantLine({ messageId: `msg_big_${i}`, sessionId: "sess-big" }));
    }
    write(path, lines(...many));
    const io = spies();
    const job = makeJob(io, { chunkBytes: 10 * 1024 * 1024 });
    await job.scanFile(path);
    expect(io.readChunk.mock.calls.length).toBeGreaterThan(1);
    for (const [, , length] of io.readChunk.mock.calls) {
      expect(length).toBeLessThanOrEqual(TRANSCRIPT_CHUNK_BYTES);
    }
    expect(queryTokenActivity(store.db, WIDE).totals.input).toBe(2500);
  });
});

describe("incremental cursors (Test 3, D-40, T-05-16)", () => {
  it("reads only from the stored offset after an append", async () => {
    writeFixture();
    const path = file("-synthetic-alpha", "sess-b.jsonl");
    const io = spies();
    const job = makeJob(io);
    await job.scanFile(path);
    const before = readCursor(store.db, path);
    expect(before?.offset).toBe(readFileSync(path).length);

    const appended: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      appended.push(assistantLine({ messageId: `msg_b_more_${i}`, sessionId: "sess-b" }));
    }
    appendFileSync(path, lines(...appended));
    io.readChunk.mockClear();
    await job.scanFile(path);
    expect(io.readChunk).toHaveBeenCalled();
    for (const [, position] of io.readChunk.mock.calls) {
      expect(position).toBeGreaterThanOrEqual(before?.offset ?? 0);
    }
    expect(io.readChunk.mock.calls[0]?.[1]).toBeGreaterThan(0);
    expect(queryTokenActivity(store.db, WIDE).totals.input).toBe(B1.input + 10);
  });

  it("restarts a rotated file at 0 and dedup prevents double counting", async () => {
    writeFixture();
    const path = file("-synthetic-alpha", "sess-a.jsonl");
    const io = spies();
    const job = makeJob(io);
    await job.scanFile(path);
    const firstInode = readCursor(store.db, path)?.inode;

    // Rotate: a new inode holding the same lines plus one more message.
    const rotated = `${path}.new`;
    writeFileSync(
      rotated,
      readFileSync(path, "utf8") +
        lines(assistantLine({ messageId: "msg_a3", sessionId: "sess-a", usage: B1 })),
    );
    renameSync(rotated, path);
    io.readChunk.mockClear();
    await job.scanFile(path);
    expect(readCursor(store.db, path)?.inode).not.toBe(firstInode);
    expect(io.readChunk.mock.calls[0]?.[1]).toBe(0);
    expect(queryTokenActivity(store.db, WIDE).totals.input).toBe(A1.input + A2.input + B1.input);
  });

  it("does not consume a partial last line until it is complete", async () => {
    const path = file("-synthetic-alpha", "sess-p.jsonl");
    const complete = assistantLine({ messageId: "msg_p1", sessionId: "sess-p", usage: C1 });
    const partial = assistantLine({ messageId: "msg_p2", sessionId: "sess-p", usage: S1 });
    write(path, `${complete}\n${partial.slice(0, 40)}`);
    const job = makeJob(spies());
    await job.scanFile(path);
    expect(readCursor(store.db, path)?.offset).toBe(Buffer.byteLength(`${complete}\n`));
    expect(queryTokenActivity(store.db, WIDE).totals).toEqual(C1);

    appendFileSync(path, `${partial.slice(40)}\n`);
    await job.scanFile(path);
    expect(queryTokenActivity(store.db, WIDE).totals.input).toBe(C1.input + S1.input);
  });
});

describe("containment (Test 4, PR-28, T-05-50)", () => {
  it("refuses a path outside the projects root, and a symlink escaping it, before any open", async () => {
    const outside = join(dir, "elsewhere", "sess-x.jsonl");
    write(outside, lines(assistantLine({ messageId: "msg_x", sessionId: "sess-x" })));
    const link = file("-synthetic-alpha", "escape.jsonl");
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(outside, link);
    const io = spies();
    const job = makeJob(io);

    expect((await job.scanFile(outside)).kind).toBe("refused");
    expect((await job.scanFile(link)).kind).toBe("refused");
    expect((await job.scanFile(file("-synthetic-alpha", "..", "..", "x.jsonl"))).kind).toBe(
      "refused",
    );
    expect(io.stat).not.toHaveBeenCalled();
    expect(io.readChunk).not.toHaveBeenCalled();
    expect(queryTokenActivity(store.db, WIDE).totals.input).toBe(0);

    // The sweep never follows the escaping symlink either.
    await job.sweep();
    expect(io.readChunk).not.toHaveBeenCalled();
  });
});

describe("format change (Test 5, D-41, PR-11, SESS-18)", () => {
  it("makes token activity unavailable with reason format-changed and that version", async () => {
    const records: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      records.push(
        assistantLine({
          messageId: `msg_f_${i}`,
          sessionId: "sess-f",
          version: "2.1.290",
          withUsage: i < 20,
        }),
      );
    }
    write(file("-synthetic-format", "sess-f.jsonl"), lines(...records));
    const job = makeJob(spies());
    await job.sweep();
    expect(job.recognition()).toEqual({ kind: "unavailable", version: "2.1.290" });

    const summary = buildUsageSummary({
      db: store.db,
      statusLineInstall: "not-installed",
      observation: EMPTY_STATUS_LINE_OBSERVATION,
      now: NOW,
      timeZone: TZ,
      analysis: { enabled: true, firstScanPending: false },
      cleanupPeriodDays: 30,
      transcripts: job.facts(),
    });
    UsageSummarySchema.parse(summary);
    for (const range of Object.values(summary.ranges)) {
      expect(range.activity).toEqual({
        kind: "unavailable",
        reason: "format-changed",
        version: "2.1.290",
      });
    }
  });
});

describe("cancellation (Test 8, D-47, T-05-52)", () => {
  it("disabling analysis mid-scan stops at the next chunk boundary", async () => {
    const path = file("-synthetic-cancel", "sess-k.jsonl");
    const many: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      many.push(assistantLine({ messageId: `msg_k_${i}`, sessionId: "sess-k" }));
    }
    write(path, lines(...many));
    const io = spies();
    const readChunk = vi.fn(async (p: string, position: number, length: number) => {
      const bytes = await io.readChunk(p, position, length);
      enabled = false; // the owner switches analysis off while this chunk is in flight
      return bytes;
    });
    const job = makeJob({ ...io, readChunk }, { chunkBytes: 1024 });
    const outcome = await job.scanFile(path);
    expect(outcome.kind).toBe("cancelled");
    expect(readChunk).toHaveBeenCalledTimes(1);
    // Nothing from the in-flight chunk is written after the switch.
    expect(queryTokenActivity(store.db, WIDE).totals.input).toBe(0);
    expect(readCursor(store.db, path)).toBeNull();
  });
});

describe("per-file errors (wave 4 review)", () => {
  it("logs a non-ENOENT stat or read failure and keeps sweeping; a vanished file is silent", async () => {
    writeFixture();
    const denied = file("-synthetic-alpha", "sess-b.jsonl");
    const vanished = file("-synthetic-beta", "sess-c.jsonl");
    const io = spies();
    const stat = vi.fn(async (path: string) => {
      if (path === denied) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      return io.stat(path);
    });
    const readChunk = vi.fn(async (path: string, position: number, length: number) => {
      if (path === vanished) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return io.readChunk(path, position, length);
    });
    const logged: Array<{ level: number; msg: string; code?: unknown }> = [];
    const logger = pino(
      { level: "info" },
      { write: (line: string) => logged.push(JSON.parse(line)) },
    );
    const job = makeJob({ ...io, stat, readChunk }, { logger });
    const outcome = await job.sweep();
    // Every other file was still scanned.
    expect(queryTokenActivity(store.db, WIDE).totals.input).toBe(
      EXPECTED_TOTALS.input - B1.input - C1.input,
    );
    expect(outcome).toMatchObject({ completed: true, failedFiles: 1 });
    const failures = logged.filter((entry) => entry.msg === "transcript scan failed; skipped");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.code).toBe("EACCES");
    // The path never reaches a log line (D-49).
    expect(JSON.stringify(logged)).not.toContain(root);
  });
});

function coveredDays(): string[] {
  return (
    store.db.prepare("SELECT day FROM coverage_days ORDER BY day").all() as Array<{ day: string }>
  ).map((row) => row.day);
}

describe("coverage only from a completed full sweep (wave 4 review)", () => {
  it("a single-file scan marks no day covered; the next full sweep does", async () => {
    writeFixture();
    const job = makeJob(spies());
    await job.scanFile(file("-synthetic-beta", "sess-c.jsonl"));
    expect(queryTokenActivity(store.db, WIDE).totals).toEqual(C1);
    // One session's tokens must not read as the whole day's.
    expect(coveredDays()).toEqual([]);

    const outcome = await job.sweep();
    expect(outcome.completed).toBe(true);
    expect(coveredDays()).toContain(localDayOf(NOW.toISOString(), TZ));
    expect(coveredDays()).toContain("2026-09-20");
  });

  it("a sweep that could not read every file marks nothing covered", async () => {
    writeFixture();
    const io = spies();
    const denied = file("-synthetic-alpha", "sess-b.jsonl");
    const stat = vi.fn(async (path: string) => {
      if (path === denied) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      return io.stat(path);
    });
    const outcome = await makeJob({ ...io, stat }).sweep();
    expect(outcome).toMatchObject({ completed: true, failedFiles: 1 });
    expect(coveredDays()).toEqual([]);
  });
});

describe("persisted recognition verdict (wave 4 review, D-41, PR-11)", () => {
  function writeChangedFormat(): string {
    const records: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      records.push(
        assistantLine({
          messageId: `msg_f_${i}`,
          sessionId: "sess-f",
          version: "2.1.290",
          withUsage: i < 20,
        }),
      );
    }
    const path = file("-synthetic-format", "sess-f.jsonl");
    write(path, lines(...records));
    return path;
  }

  it("survives a restart, and holds cursors, usage and coverage while unavailable", async () => {
    const changed = writeChangedFormat();
    const good = file("-synthetic-good", "sess-g.jsonl");
    write(good, lines(assistantLine({ messageId: "msg_g1", sessionId: "sess-g", usage: C1 })));
    const first = makeJob(spies());
    const outcome = await first.sweep();
    expect(outcome.completed).toBe(false);
    expect(outcome.held).toBe(true);
    // The chunk that tripped the verdict advanced nothing and counted nothing.
    expect(readCursor(store.db, changed)).toBeNull();
    expect(coveredDays()).toEqual([]);

    // A new job over the same store (a service restart) still knows.
    const io = spies();
    const restarted = makeJob(io);
    expect(restarted.recognition()).toEqual({ kind: "unavailable", version: "2.1.290" });
    expect(restarted.facts().verdict).toEqual({ kind: "unavailable", version: "2.1.290" });
    // Nothing is read while the verdict stands: the period cannot read complete.
    expect((await restarted.scanFile(good)).kind).toBe("held");
    expect((await restarted.sweep()).completed).toBe(false);
    expect(io.readChunk).not.toHaveBeenCalled();
    expect(coveredDays()).toEqual([]);
  });

  it("a parser version change resets cursors and coverage, and rescans from zero", async () => {
    writeFixture();
    const path = file("-synthetic-alpha", "sess-b.jsonl");
    await makeJob(spies()).sweep();
    expect(readCursor(store.db, path)?.offset).toBe(readFileSync(path).length);
    expect(coveredDays().length).toBeGreaterThan(0);

    // Simulate a store last scanned by an older parser.
    setCollectorSetting(store.db, TRANSCRIPT_PARSER_VERSION_SETTING, "0", NOW.toISOString());
    const io = spies();
    const job = makeJob(io);
    expect(job.facts().verdict).toEqual({ kind: "ok" });
    await job.sweep();
    expect(io.readChunk.mock.calls.filter(([p]) => p === path)[0]?.[1]).toBe(0);
    // Dedup keeps the rescan from counting twice.
    expect(queryTokenActivity(store.db, WIDE).totals).toEqual(EXPECTED_TOTALS);
    expect(coveredDays().length).toBeGreaterThan(0);
    expect(getCollectorSetting(store.db, TRANSCRIPT_PARSER_VERSION_SETTING)).toBe(
      String(TRANSCRIPT_PARSER_VERSION),
    );
  });
});

describe("tokens from days analysis was off are not counted (D-47, wave 4 review)", () => {
  it("skips records timestamped inside a switch-off interval, and counts the backfill before the first enable", async () => {
    appendToggleLog(store.db, "2026-09-18T00:00:00.000Z", true);
    appendToggleLog(store.db, "2026-09-19T10:00:00.000Z", false);
    appendToggleLog(store.db, "2026-09-19T14:00:00.000Z", true);
    const at = (messageId: string, timestamp: string, input: number) =>
      assistantLine({
        messageId,
        sessionId: "sess-off",
        timestamp,
        usage: { input, output: 0, cacheWrite: 0, cacheRead: 0 },
      });
    const path = file("-synthetic-off", "sess-off.jsonl");
    write(
      path,
      lines(
        at("m-backfill", "2026-09-17T12:00:00.000Z", 1),
        at("m-before-off", "2026-09-19T09:59:59.000Z", 10),
        at("m-while-off", "2026-09-19T12:00:00.000Z", 100),
        at("m-at-reenable", "2026-09-19T14:00:00.000Z", 1000),
      ),
    );
    await makeJob(spies()).scanFile(path);
    expect(queryTokenActivity(store.db, WIDE).totals.input).toBe(1011);
    // The cursor still passes the skipped record: it is excluded, not pending.
    expect(readCursor(store.db, path)?.offset).toBe(readFileSync(path).length);
  });
});
