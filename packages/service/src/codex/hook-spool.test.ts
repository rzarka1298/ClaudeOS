import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IngestOutcome } from "../claude/pipeline.js";
import { startSpoolPoller } from "../claude/spool-poller.js";
import {
  buildHookMirror,
  HOOK_MINUTE,
  HOOK_NOW,
  type HookMirrorKit,
  hookRecord,
  iso,
} from "../test-support/codex-hook-kit.js";
import { createHookOverlay } from "./hook-overlay.js";
import {
  type CodexHookPipeline,
  createCodexHookPipeline,
  mirrorControlFor,
} from "./hook-pipeline.js";
import {
  CODEX_HOOK_DROP_FILE_NAME,
  CODEX_HOOK_SPOOL_FILE_NAME,
  type CodexHookSpool,
  startCodexHookSpool,
} from "./hook-spool.js";

let runtimeDir: string;
let spoolDir: string;
let kit: HookMirrorKit | undefined;
let spool: CodexHookSpool | undefined;
let claudeLines: unknown[];

const silent = pino({ level: "silent" });
const NO_SETTLE = async (): Promise<void> => undefined;

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), "ccc-hs-"));
  spoolDir = join(runtimeDir, "spool");
  mkdirSync(spoolDir, { recursive: true });
  claudeLines = [];
});
afterEach(async () => {
  await spool?.stop();
  spool = undefined;
  kit?.home.cleanup();
  kit = undefined;
  rmSync(runtimeDir, { recursive: true, force: true });
});

const codexSpool = (): string => join(spoolDir, "codex-hooks.ndjson");
const line = (record: unknown): string => `${JSON.stringify(record)}\n`;
const files = (): string[] => readdirSync(spoolDir).sort();

interface Rig {
  readonly kit: HookMirrorKit;
  readonly pipeline: CodexHookPipeline;
}

function rig(): Rig {
  const built = buildHookMirror([
    { id: "thread-a", agoMs: 10 * HOOK_MINUTE, lifecycle: [["task_started", 10 * HOOK_MINUTE]] },
  ]);
  kit = built;
  const pipeline = createCodexHookPipeline({
    now: () => built.clock.now,
    mirrorControl: mirrorControlFor(built.mirror),
    subscribers: () => built.subscribers.count,
  });
  built.mirror.addOverlay(
    createHookOverlay({ pipeline, now: () => built.clock.now, inactivityMs: 30 * HOOK_MINUTE }),
  );
  return { kit: built, pipeline };
}

function state(r: Rig, id = "thread-a"): string | undefined {
  const snapshot = r.kit.mirror.snapshot();
  if (snapshot === null || snapshot.kind !== "available") throw new Error("expected available");
  return snapshot.sessions.find((entry) => entry.threadId === id)?.state;
}

function start(
  pipeline: Pick<CodexHookPipeline, "ingest" | "attachDropCount">,
  extra: { settle?: () => Promise<void> } = {},
): CodexHookSpool {
  spool = startCodexHookSpool({
    runtimeDir,
    pipeline,
    logger: silent,
    intervalMs: 60_000,
    settle: extra.settle ?? NO_SETTLE,
  });
  return spool;
}

describe("Test 0: the wire names equal the hook's own", () => {
  it("matches the constants plan 05.1-16 ships in the hook limits", () => {
    const source = readFileSync(
      new URL("../../../collectors/src/codex-hook/limits.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain(`CODEX_SPOOL_FILE_NAME = "${CODEX_HOOK_SPOOL_FILE_NAME}"`);
    expect(source).toContain(`CODEX_SPOOL_DROP_FILE_NAME = "${CODEX_HOOK_DROP_FILE_NAME}"`);
    expect(CODEX_HOOK_SPOOL_FILE_NAME).toBe("codex-hooks.ndjson");
    expect(CODEX_HOOK_DROP_FILE_NAME).toBe("codex-hooks.dropped");
  });
});

describe("Test 1: the startup drain", () => {
  it("ingests three lines (a write-ahead SessionEnd among them), counts the garbage and deletes the file", async () => {
    const r = rig();
    await r.kit.mirror.pollNow();
    expect(state(r)).toBe("running");
    writeFileSync(
      codexSpool(),
      [
        line(
          hookRecord({
            hook_event_name: "UserPromptSubmit",
            observedAt: iso(HOOK_NOW - 3 * HOOK_MINUTE),
          }),
        ),
        line(hookRecord({ hook_event_name: "Stop", observedAt: iso(HOOK_NOW - 2 * HOOK_MINUTE) })),
        "{this is not json\n",
        line(
          hookRecord({ hook_event_name: "SessionEnd", observedAt: iso(HOOK_NOW - HOOK_MINUTE) }),
        ),
      ].join(""),
    );
    const poller = start(r.pipeline);
    expect(await poller.drainNow()).toBe(3);
    expect(poller.stats().unparsableLines).toBe(1);
    expect(files()).toEqual([]);
    expect(state(r)).toBe("completed");
    expect(r.pipeline.stats().applied).toBe(3);
  });
});

describe("Test 2: replay is idempotent and ordered by event time", () => {
  it("applies a record delivered by the socket and again by the spool once", async () => {
    const r = rig();
    await r.kit.mirror.pollNow();
    const record = hookRecord({ hook_event_name: "Stop" });
    expect(await r.pipeline.ingest(record, "socket")).toBe("applied");
    writeFileSync(codexSpool(), line(record));
    await start(r.pipeline).drainNow();
    expect(r.pipeline.stats()).toMatchObject({ applied: 1, duplicate: 1 });
    expect(state(r)).toBe("completed");
  });

  it("keeps a file whose ingest failed mid-way and replays it without double-applying", async () => {
    const r = rig();
    await r.kit.mirror.pollNow();
    const first = hookRecord({
      hook_event_name: "UserPromptSubmit",
      observedAt: iso(HOOK_NOW - 2 * HOOK_MINUTE),
    });
    const second = hookRecord({
      hook_event_name: "SessionEnd",
      observedAt: iso(HOOK_NOW - HOOK_MINUTE),
    });
    writeFileSync(codexSpool(), line(first) + line(second));
    let crash = true;
    const flaky = {
      attachDropCount: r.pipeline.attachDropCount,
      ingest: async (input: unknown, via: "socket" | "spool"): Promise<IngestOutcome> => {
        if (crash && (input as { eventId?: string }).eventId === second.eventId) {
          crash = false;
          throw new Error("store failed");
        }
        return r.pipeline.ingest(input, via);
      },
    };
    const poller = start(flaky);
    await poller.drainNow();
    expect(files().some((name) => name.startsWith("codex-hooks.ndjson.draining-"))).toBe(true);
    expect(r.pipeline.stats().applied).toBe(1);
    await poller.tick();
    expect(files()).toEqual([]);
    expect(r.pipeline.stats()).toMatchObject({ applied: 2, duplicate: 1 });
    expect(state(r)).toBe("stale");
  });

  it("treats a spooled older Stop as a no-op after a newer socket UserPromptSubmit, whatever its event id", async () => {
    const r = rig();
    await r.kit.mirror.pollNow();
    await r.pipeline.ingest(
      hookRecord({ hook_event_name: "UserPromptSubmit", observedAt: iso(HOOK_NOW) }),
      "socket",
    );
    expect(state(r)).toBe("running");
    writeFileSync(
      codexSpool(),
      line(hookRecord({ hook_event_name: "Stop", observedAt: iso(HOOK_NOW - HOOK_MINUTE) })),
    );
    await start(r.pipeline).drainNow();
    expect(state(r)).toBe("running");
    expect(r.pipeline.latestFor("thread-a")?.event).toBe("UserPromptSubmit");
    expect(r.pipeline.stats().ignoredOlder).toBe(1);
  });
});

describe("Test 3: the reused rename-then-read algorithm", () => {
  it("renames at one tick, reads the renamed file at the next, and discards a trailing fragment", async () => {
    const seen: unknown[] = [];
    const pipeline = {
      attachDropCount: () => undefined,
      ingest: async (input: unknown): Promise<IngestOutcome> => {
        seen.push((input as { n?: number }).n);
        return "applied";
      },
    };
    const poller = start(pipeline);
    appendFileSync(codexSpool(), line({ n: 1 }));
    await poller.tick();
    expect(seen).toEqual([]);
    const renamed = files();
    expect(renamed).toHaveLength(1);
    expect(renamed[0]).toMatch(/^codex-hooks\.ndjson\.draining-\d+/);
    expect(existsSync(codexSpool())).toBe(false);

    appendFileSync(codexSpool(), `${line({ n: 2 })}{"n":3`);
    await poller.tick();
    expect(seen).toEqual([1]);
    await poller.tick();
    expect(seen).toEqual([1, 2]);
    expect(poller.stats().fragmentsDiscarded).toBe(1);
    expect(files()).toEqual([]);
  });
});

describe("Test 4: Claude's spool and Codex's never read each other's files", () => {
  it("drains each only its own lines and leaves the other's drop counter and status line alone", async () => {
    const r = rig();
    const claudeIngest = async (input: unknown): Promise<IngestOutcome> => {
      claudeLines.push(input);
      return "applied";
    };
    const claude = startSpoolPoller({
      spoolPath: join(spoolDir, "hooks.ndjson"),
      statusLinePath: join(spoolDir, "statusline.latest.json"),
      dropPath: join(spoolDir, "hooks.dropped"),
      pipeline: { ingest: claudeIngest },
      logger: silent,
      intervalMs: 60_000,
      settle: NO_SETTLE,
    });
    try {
      const claudeRecord = { eventId: randomUUID(), marker: "claude-only" };
      writeFileSync(join(spoolDir, "hooks.ndjson"), line(claudeRecord));
      writeFileSync(join(spoolDir, "hooks.dropped"), "xxxxx");
      writeFileSync(join(spoolDir, "statusline.latest.json"), JSON.stringify({ marker: "sl" }));
      writeFileSync(codexSpool(), line(hookRecord({ hook_event_name: "Stop" })));
      writeFileSync(join(spoolDir, "codex-hooks.dropped"), "xxx");

      const poller = start(r.pipeline);
      expect(await poller.drainNow()).toBe(1);
      // The Claude statusline snapshot and drop counter are untouched by the Codex poller.
      expect(readFileSync(join(spoolDir, "statusline.latest.json"), "utf8")).toContain('"sl"');
      expect(statSync(join(spoolDir, "hooks.dropped")).size).toBe(5);
      expect(claudeLines).toEqual([]);
      expect(r.pipeline.stats().applied).toBe(1);

      expect(await claude.drainNow()).toBe(1);
      expect(claudeLines).toEqual([claudeRecord]);
      expect(r.pipeline.stats().applied).toBe(1);
      expect(claude.dropCount()).toBe(5);
      expect(poller.dropCount()).toBe(3);
      // The Codex poller never created a status line snapshot of its own.
      expect(files().filter((name) => name.includes("statusline"))).toEqual([]);
    } finally {
      await claude.stop();
    }
  });
});

describe("Test 5: the drop counter", () => {
  it("surfaces the hook's drop file size through dropCount and the pipeline stats", async () => {
    const r = rig();
    const poller = start(r.pipeline);
    expect(poller.dropCount()).toBe(0);
    expect(r.pipeline.stats().dropped).toBe(0);
    writeFileSync(join(spoolDir, "codex-hooks.dropped"), "xxxx");
    expect(poller.dropCount()).toBe(4);
    expect(r.pipeline.stats().dropped).toBe(4);
  });
});

describe("Test 6: stop and the runtime-directory-only contract", () => {
  it("clears the interval and resolves only after an in-flight drain", async () => {
    const r = rig();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    writeFileSync(codexSpool(), line(hookRecord()));
    const poller = start(r.pipeline, { settle: () => gate });
    const draining = poller.drainNow();
    let stopped = false;
    const stopping = poller.stop().then(() => {
      stopped = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(stopped).toBe(false);
    release();
    await draining;
    await stopping;
    expect(stopped).toBe(true);
  });

  it("builds every path under <runtimeDir>/spool; a path inside a record is shape-invalid and touches nothing", async () => {
    const r = rig();
    const outside = join(runtimeDir, "outside.txt");
    writeFileSync(codexSpool(), line(hookRecord({ spoolPath: outside, path: outside })));
    const poller = start(r.pipeline);
    await poller.drainNow();
    expect(r.pipeline.stats().invalid).toBe(1);
    expect(existsSync(outside)).toBe(false);
    expect(readdirSync(runtimeDir)).toEqual(["spool"]);
  });
});
