import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClaudePipeline, IngestOutcome } from "./pipeline.js";
import { type SpoolPoller, startSpoolPoller } from "./spool-poller.js";

interface Ingested {
  readonly record: unknown;
  readonly via: "socket" | "spool";
}

let dir: string;
let spoolDir: string;
let spoolPath: string;
let statusLinePath: string;
let dropPath: string;
let ingested: Ingested[];
let logLines: Record<string, unknown>[];
let poller: SpoolPoller | undefined;

const fakePipeline: Pick<ClaudePipeline, "ingest"> = {
  ingest: async (record, via): Promise<IngestOutcome> => {
    ingested.push({ record, via });
    return "applied";
  },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccc-poll-"));
  spoolDir = join(dir, "spool");
  mkdirSync(spoolDir, { recursive: true });
  spoolPath = join(spoolDir, "hooks.ndjson");
  statusLinePath = join(spoolDir, "statusline.latest.json");
  dropPath = join(spoolDir, "hooks.dropped");
  ingested = [];
  logLines = [];
});

afterEach(async () => {
  await poller?.stop();
  poller = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function start(
  intervalMs = 60_000,
  extra: Partial<Parameters<typeof startSpoolPoller>[0]> = {},
): SpoolPoller {
  const logger = pino(
    { level: "debug" },
    { write: (line: string) => logLines.push(JSON.parse(line) as Record<string, unknown>) },
  );
  poller = startSpoolPoller({
    spoolPath,
    statusLinePath,
    dropPath,
    pipeline: fakePipeline,
    logger,
    intervalMs,
    ...extra,
  });
  return poller;
}

function line(n: number): string {
  return `${JSON.stringify({ n, eventId: randomUUID() })}\n`;
}

function numbers(): unknown[] {
  return ingested.map((entry) => (entry.record as { n?: unknown }).n);
}

function spoolFiles(): string[] {
  return readdirSync(spoolDir).sort();
}

describe("rename-then-read (Test 1, PR-12)", () => {
  it("renames the spool at one tick and reads the renamed file at the next", async () => {
    const p = start();
    appendFileSync(spoolPath, line(1));
    await p.tick();
    expect(numbers()).toEqual([]);
    const renamed = spoolFiles();
    expect(renamed).toHaveLength(1);
    expect(renamed[0]).toMatch(/^hooks\.ndjson\.draining-\d+/);
    expect(existsSync(spoolPath)).toBe(false);

    appendFileSync(spoolPath, line(2));
    await p.tick();
    expect(numbers()).toEqual([1]);
    await p.tick();
    expect(numbers()).toEqual([1, 2]);
    expect(spoolFiles()).toEqual([]);
  });

  it("loses no line across 200 appends interleaved with ticks", async () => {
    const p = start();
    for (let n = 0; n < 200; n += 1) {
      appendFileSync(spoolPath, line(n));
      if (n % 7 === 3) await p.tick();
    }
    await p.tick();
    await p.tick();
    expect(numbers()).toEqual(Array.from({ length: 200 }, (_, n) => n));
    expect(ingested.every((entry) => entry.via === "spool")).toBe(true);
    expect(spoolFiles()).toEqual([]);
  });

  it("polls on its own interval and stops cleanly", async () => {
    const p = start(20);
    appendFileSync(spoolPath, line(7));
    const deadline = Date.now() + 2000;
    while (numbers().length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(numbers()).toEqual([7]);
    await p.stop();
    appendFileSync(spoolPath, line(8));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(numbers()).toEqual([7]);
  });
});

describe("parsing a drained file (Test 2)", () => {
  it("logs and skips an unparsable line, discards and counts a final trailing fragment, and deletes the file", async () => {
    const p = start();
    // The old drain "retained a trailing partial record" by writing it back.
    // A renamed file has no writer left, so its fragment is final (PATTERNS
    // correction 6): it is discarded and counted, never re-queued.
    writeFileSync(spoolPath, `${line(1)}not-json\n${line(3)}{"n":4,"partial`);
    await p.drainNow();
    expect(numbers()).toEqual([1, 3]);
    expect(p.stats().fragmentsDiscarded).toBe(1);
    expect(p.stats().unparsableLines).toBe(1);
    const warn = logLines.find((entry) => entry.msg === "spool record failed to parse; skipped");
    expect(warn).toMatchObject({ line: 2 });
    expect(JSON.stringify(logLines)).not.toContain("partial");
    expect(spoolFiles()).toEqual([]);
  });

  it("treats an absent spool file as no records, not an error, and a second drain finds nothing", async () => {
    const p = start();
    await expect(p.drainNow()).resolves.toBe(0);
    appendFileSync(spoolPath, line(1));
    await expect(p.drainNow()).resolves.toBe(1);
    await expect(p.drainNow()).resolves.toBe(0);
  });
});

describe("hook and status-line routing (Test 3)", () => {
  it("drainNow renames and reads in one pass, including files a crashed run left draining", async () => {
    writeFileSync(`${spoolPath}.draining-1000-0`, line(1));
    appendFileSync(spoolPath, line(2));
    const p = start();
    await expect(p.drainNow()).resolves.toBe(2);
    expect(numbers()).toEqual([1, 2]);
    expect(spoolFiles()).toEqual([]);
  });

  it("hands the latest status-line snapshot to the sink and deletes the file", async () => {
    const p = start();
    const snapshots: unknown[] = [];
    p.setStatusLineSink((snapshot) => snapshots.push(snapshot));
    writeFileSync(statusLinePath, JSON.stringify({ session_id: "s1", tick: 9 }));
    await p.tick();
    expect(snapshots).toEqual([{ session_id: "s1", tick: 9 }]);
    expect(numbers()).toEqual([]);
    expect(spoolFiles()).toEqual([]);
  });

  it("holds the latest snapshot until a sink is registered, counting only superseded ones", async () => {
    const p = start();
    writeFileSync(statusLinePath, JSON.stringify({ session_id: "s1", tick: 1 }));
    await p.drainNow();
    writeFileSync(statusLinePath, JSON.stringify({ session_id: "s1", tick: 2 }));
    await p.tick();
    expect(p.stats().statusLineDropped).toBe(1);
    expect(spoolFiles()).toEqual([]);

    const snapshots: unknown[] = [];
    p.setStatusLineSink((snapshot) => snapshots.push(snapshot));
    await p.tick();
    expect(snapshots).toEqual([{ session_id: "s1", tick: 2 }]);
    // Delivered once: the next tick hands nothing over again.
    await p.tick();
    expect(snapshots).toHaveLength(1);
  });

  it("logs, skips and deletes an unparsable status-line file", async () => {
    const p = start();
    const snapshots: unknown[] = [];
    p.setStatusLineSink((snapshot) => snapshots.push(snapshot));
    writeFileSync(statusLinePath, "{not json");
    await p.tick();
    expect(snapshots).toEqual([]);
    expect(
      logLines.some((entry) => entry.msg === "status-line spool failed to parse; skipped"),
    ).toBe(true);
    expect(spoolFiles()).toEqual([]);
  });

  it("reports the drop count as the byte size of hooks.dropped", () => {
    const p = start();
    expect(p.dropCount()).toBe(0);
    writeFileSync(dropPath, "xxx");
    expect(p.dropCount()).toBe(3);
  });
});

/** A pipeline whose ingest of record `n === blockOn` waits until released. */
function gatedPipeline(blockOn: number) {
  let release: () => void = () => undefined;
  let reached: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const arrived = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const pipeline: Pick<ClaudePipeline, "ingest"> = {
    ingest: async (record, via): Promise<IngestOutcome> => {
      if ((record as { n?: unknown }).n === blockOn) {
        reached();
        await gate;
      }
      ingested.push({ record, via });
      return "applied";
    },
  };
  return { pipeline, release: () => release(), arrived };
}

describe("write-ahead durability (wave 3 review)", () => {
  it("keeps a taken file on disk until every one of its lines has been ingested", async () => {
    const gated = gatedPipeline(2);
    const p = start(60_000, { pipeline: gated.pipeline });
    appendFileSync(spoolPath, line(1) + line(2) + line(3));
    const draining = p.drainNow();
    await gated.arrived;
    expect(spoolFiles()).toHaveLength(1);
    gated.release();
    await expect(draining).resolves.toBe(3);
    expect(numbers()).toEqual([1, 2, 3]);
    expect(spoolFiles()).toEqual([]);
  });

  it("keeps the file for the next tick when an ingest fails, and replays it then", async () => {
    let failOnce = true;
    const pipeline: Pick<ClaudePipeline, "ingest"> = {
      ingest: async (record, via): Promise<IngestOutcome> => {
        if ((record as { n?: unknown }).n === 2 && failOnce) {
          failOnce = false;
          throw new Error("store unavailable");
        }
        ingested.push({ record, via });
        return "applied";
      },
    };
    const p = start(60_000, { pipeline });
    appendFileSync(spoolPath, line(1) + line(2) + line(3));
    await p.drainNow();
    expect(numbers()).toEqual([1]);
    expect(spoolFiles()).toHaveLength(1);
    await p.tick();
    // Line 1 arrives twice; the pipeline's eventId guard makes the replay a no-op.
    expect(numbers()).toEqual([1, 1, 2, 3]);
    expect(spoolFiles()).toEqual([]);
  });

  it("stop() resolves only after the in-flight tick has finished its file", async () => {
    const gated = gatedPipeline(1);
    const p = start(60_000, { pipeline: gated.pipeline });
    writeFileSync(`${spoolPath}.draining-1000-0`, line(1) + line(2));
    const ticking = p.tick();
    await gated.arrived;
    let stopped = false;
    const stopping = p.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopped).toBe(false);
    gated.release();
    await stopping;
    await ticking;
    expect(numbers()).toEqual([1, 2]);
    expect(spoolFiles()).toEqual([]);
  });

  it("startup drain lets a writer that opened the spool before the rename finish its append", async () => {
    appendFileSync(spoolPath, line(1));
    // A hook that opened hooks.ndjson (O_APPEND) just before the rename and
    // writes just after it: its line lands in the renamed inode.
    const fd = openSync(spoolPath, "a");
    const p = start(60_000, {
      settle: async () => {
        writeSync(fd, line(2));
        closeSync(fd);
      },
    });
    await expect(p.drainNow()).resolves.toBe(2);
    expect(numbers()).toEqual([1, 2]);
    expect(spoolFiles()).toEqual([]);
  });
});
