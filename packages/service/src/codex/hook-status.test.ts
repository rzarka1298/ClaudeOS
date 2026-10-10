import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexHookStatusSchema } from "@ccc/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildHookMirror,
  HOOK_DECOYS,
  HOOK_MINUTE,
  HOOK_NOW,
  hookRecord,
  iso,
} from "../test-support/codex-hook-kit.js";
import { createCodexHookPipeline, HOOK_EVENT_IDS_CAP, HOOK_THREADS_CAP } from "./hook-pipeline.js";
import {
  createHookStatusProvider,
  type HookStatusFs,
  type HookStatusProvider,
} from "./hook-status.js";

let runtimeDir: string;
beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), "ccc-hst-"));
});
afterEach(() => {
  try {
    chmodSync(join(runtimeDir, "codex-hooks"), 0o700);
  } catch {
    // absent in most tests
  }
  rmSync(runtimeDir, { recursive: true, force: true });
});

const hooksDir = (): string => join(runtimeDir, "codex-hooks");
const entryPath = (): string => join(hooksDir(), "codex-hook", "entry.js");
const markerPath = (): string => join(hooksDir(), "package.json");

/** The installer's layout: the entry as a regular file, the marker written last. */
function install(markerMtimeMs: number = HOOK_NOW - 60 * HOOK_MINUTE): void {
  mkdirSync(join(hooksDir(), "codex-hook"), { recursive: true });
  writeFileSync(entryPath(), "// synthetic entry\n");
  writeFileSync(markerPath(), '{"type":"module"}\n');
  utimesSync(markerPath(), markerMtimeMs / 1000, markerMtimeMs / 1000);
}

interface Built {
  readonly clock: { now: number };
  readonly pipeline: ReturnType<typeof createCodexHookPipeline>;
  readonly provider: HookStatusProvider;
  readonly changes: { count: number };
  readonly statusChanges: ReturnType<typeof vi.fn>;
}

function build(
  over: { serviceStartedAt?: number; fs?: HookStatusFs } = {},
  pipelineOver: { onStatusChange?: () => void } = {},
): Built {
  const clock = { now: HOOK_NOW };
  const changes = { count: 0 };
  const statusChanges = vi.fn();
  const pipeline = createCodexHookPipeline({
    now: () => clock.now,
    mirrorControl: {
      knows: () => true,
      invalidate: () => undefined,
      pollNow: async () => undefined,
    },
    subscribers: () => 0,
    onStatusChange: pipelineOver.onStatusChange ?? statusChanges,
  });
  const provider = createHookStatusProvider({
    runtimeDir,
    serviceStartedAt: over.serviceStartedAt ?? HOOK_NOW - 10 * HOOK_MINUTE,
    pipeline,
    onChange: () => {
      changes.count += 1;
    },
    ...(over.fs === undefined ? {} : { fs: over.fs }),
  });
  return { clock, pipeline, provider, changes, statusChanges };
}

describe("Test 1 (tracer): status follows the installer layout and the events received", () => {
  it("is not-installed, then installed-no-events, then installed with the receipt time", async () => {
    const b = build();
    expect(b.provider.status()).toEqual({
      state: "not-installed",
      lastEventAt: null,
      installedSince: null,
    });
    // Marker older than the service start: the service start is the reference.
    install(HOOK_NOW - 60 * HOOK_MINUTE);
    expect(b.provider.status()).toEqual({
      state: "installed-no-events",
      lastEventAt: null,
      installedSince: iso(HOOK_NOW - 10 * HOOK_MINUTE),
    });
    await b.pipeline.ingest(hookRecord(), "socket");
    expect(b.provider.status()).toEqual({
      state: "installed",
      lastEventAt: iso(HOOK_NOW),
      installedSince: iso(HOOK_NOW - 10 * HOOK_MINUTE),
    });
  });

  it("uses the marker's modification time when the install is newer than the service start", async () => {
    install(HOOK_NOW - 5 * HOOK_MINUTE);
    const b = build();
    expect(b.provider.status().installedSince).toBe(iso(HOOK_NOW - 5 * HOOK_MINUTE));
  });

  it("reads an event from before a re-install as no events since", async () => {
    const b = build({ serviceStartedAt: HOOK_NOW - 90 * HOOK_MINUTE });
    b.clock.now = HOOK_NOW - 80 * HOOK_MINUTE;
    await b.pipeline.ingest(hookRecord({ observedAt: iso(HOOK_NOW - 80 * HOOK_MINUTE) }), "socket");
    install(HOOK_NOW - 5 * HOOK_MINUTE);
    expect(b.provider.status().state).toBe("installed-no-events");
  });
});

describe("Test 2: only regular files count; an unreadable directory is unknown", () => {
  it("treats a symlinked marker or entry as not installed", () => {
    install();
    rmSync(markerPath());
    symlinkSync(entryPath(), markerPath());
    expect(build().provider.status().state).toBe("not-installed");
    rmSync(markerPath());
    writeFileSync(markerPath(), "{}");
    rmSync(entryPath());
    symlinkSync(markerPath(), entryPath());
    expect(build().provider.status().state).toBe("not-installed");
  });

  it("treats a directory in place of the file as not installed", () => {
    install();
    rmSync(markerPath());
    mkdirSync(markerPath());
    expect(build().provider.status().state).toBe("not-installed");
    rmSync(markerPath(), { recursive: true });
    writeFileSync(markerPath(), "{}");
    rmSync(entryPath());
    mkdirSync(entryPath());
    expect(build().provider.status().state).toBe("not-installed");
  });

  it("needs both the entry and the marker (the marker is written last)", () => {
    install();
    rmSync(markerPath());
    expect(build().provider.status().state).toBe("not-installed");
  });

  it("reports unknown on a permission error from a real unreadable directory", () => {
    if (process.getuid?.() === 0) return;
    install();
    chmodSync(hooksDir(), 0o000);
    expect(build().provider.status()).toEqual({
      state: "unknown",
      lastEventAt: null,
      installedSince: null,
    });
  });

  it("reports unknown on a non-not-found error, never throws, and reports not-installed on not-found", () => {
    const failing = (code: string): HookStatusFs => ({
      lstat: () => {
        throw Object.assign(new Error("fs failure"), { code });
      },
    });
    expect(build({ fs: failing("EACCES") }).provider.status().state).toBe("unknown");
    expect(build({ fs: failing("EIO") }).provider.status().state).toBe("unknown");
    expect(build({ fs: failing("ENOENT") }).provider.status().state).toBe("not-installed");
    expect(build({ fs: failing("ENOTDIR") }).provider.status().state).toBe("not-installed");
    const weird: HookStatusFs = {
      lstat: () => {
        throw "not an error object";
      },
    };
    expect(build({ fs: weird }).provider.status().state).toBe("unknown");
  });
});

describe("Test 3: only the installer's two paths are looked at", () => {
  it("lstats exactly the entry and the marker, and names no Codex home, configuration or credential", async () => {
    install();
    const calls: string[] = [];
    const recording: HookStatusFs = {
      lstat: (path) => {
        calls.push(path);
        return {
          isFile: () => true,
          isSymbolicLink: () => false,
          mtimeMs: HOOK_NOW - 60 * HOOK_MINUTE,
        };
      },
    };
    const b = build({ fs: recording });
    await b.pipeline.ingest(hookRecord(), "socket");
    b.provider.status();
    b.provider.rescan();
    expect(calls.length).toBeGreaterThan(0);
    for (const path of calls) expect([entryPath(), markerPath()]).toContain(path);
    const forbidden = [
      ["auth", "json"].join("."),
      ["config", "toml"].join("."),
      ["hooks", "json"].join("."),
      ".codex",
    ];
    for (const name of forbidden) expect(calls.join("\n")).not.toContain(name);
  });
});

describe("Test 4: the change callback fires on real transitions only", () => {
  it("fires the pipeline callback once, on the first valid record, never for a duplicate or invalid one", async () => {
    install();
    const b = build();
    expect(b.statusChanges).not.toHaveBeenCalled();
    await b.pipeline.ingest(hookRecord({ prompt: HOOK_DECOYS.prompt }), "socket");
    expect(b.statusChanges).not.toHaveBeenCalled();
    const record = hookRecord();
    await b.pipeline.ingest(record, "socket");
    await b.pipeline.ingest(record, "spool");
    await b.pipeline.ingest(hookRecord({ session_id: "thread-b" }), "socket");
    expect(b.statusChanges).toHaveBeenCalledTimes(1);
    expect(b.statusChanges).toHaveBeenCalledWith();
  });

  it("calls onChange when a rescan sees the installed copy appear, disappear or become unreadable", () => {
    const b = build();
    b.provider.rescan();
    expect(b.changes.count).toBe(0);
    install();
    b.provider.rescan();
    expect(b.changes.count).toBe(1);
    b.provider.rescan();
    expect(b.changes.count).toBe(1);
    rmSync(markerPath());
    b.provider.rescan();
    expect(b.changes.count).toBe(2);
  });

  it("does not call onChange for an event arriving (the pipeline callback owns that transition)", async () => {
    install();
    const b = build();
    await b.pipeline.ingest(hookRecord(), "socket");
    b.provider.rescan();
    expect(b.changes.count).toBe(0);
  });

  it("survives a throwing onChange", () => {
    const provider = createHookStatusProvider({
      runtimeDir,
      serviceStartedAt: HOOK_NOW,
      pipeline: { lastEventAt: () => null },
      onChange: () => {
        throw new Error("sink failed");
      },
    });
    install();
    expect(() => provider.rescan()).not.toThrow();
  });
});

describe("Test 5: the status object", () => {
  it("parses with the strict domain schema and carries no path, cwd, model or session id", async () => {
    install();
    const b = build();
    await b.pipeline.ingest(
      hookRecord({ cwd: HOOK_DECOYS.cwd, model: HOOK_DECOYS.model, session_id: "thread-decoy" }),
      "socket",
    );
    const status = b.provider.status();
    expect(CodexHookStatusSchema.parse(status)).toEqual(status);
    expect(Object.keys(status).sort()).toEqual(["installedSince", "lastEventAt", "state"]);
    const text = JSON.stringify(status);
    for (const value of [runtimeDir, HOOK_DECOYS.cwd, HOOK_DECOYS.model, "thread-decoy"]) {
      expect(text).not.toContain(value);
    }
    expect(status.lastEventAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(status.installedSince).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });
});

describe("Test 6: boundedness audit", () => {
  it("stays at its caps after 10,000 distinct events across 5,000 threads", async () => {
    const b = build();
    for (let n = 0; n < 10_000; n += 1) {
      await b.pipeline.ingest(
        hookRecord({ session_id: `thread-${n % 5000}`, observedAt: iso(HOOK_NOW - 1000 + n) }),
        "spool",
      );
    }
    expect(b.pipeline.sizes()).toEqual({ eventIds: HOOK_EVENT_IDS_CAP, threads: HOOK_THREADS_CAP });
    expect(b.pipeline.stats().evicted).toBeGreaterThan(0);
    for (const threadId of ["thread-9", "thread-4999", "thread-4600"]) {
      const fact = b.pipeline.latestFor(threadId);
      if (fact !== undefined) {
        expect(Object.keys(fact).sort()).toEqual([
          "activityAt",
          "event",
          "receivedAt",
          "threadId",
          "turnId",
        ]);
      }
    }
  });
});

describe("Test 7: privacy audit", () => {
  it("keeps every decoy out of logs, published events, status and retained facts", async () => {
    install();
    const kit = buildHookMirror([
      { id: "thread-a", agoMs: 10 * HOOK_MINUTE, lifecycle: [["task_started", 10 * HOOK_MINUTE]] },
    ]);
    try {
      const logged: string[] = [];
      const pipeline = createCodexHookPipeline({
        now: () => kit.clock.now,
        mirrorControl: {
          knows: () => true,
          invalidate: () => kit.mirror.invalidate(),
          pollNow: () => kit.mirror.pollNow(),
        },
        subscribers: () => 1,
        logger: { warn: (fields, message) => logged.push(JSON.stringify({ fields, message })) },
      });
      const provider = createHookStatusProvider({
        runtimeDir,
        serviceStartedAt: HOOK_NOW - HOOK_MINUTE,
        pipeline,
      });
      await kit.mirror.pollNow();
      // Smuggled content is shape-invalid; allowed-but-unneeded fields are accepted and dropped.
      await pipeline.ingest(
        hookRecord({
          prompt: HOOK_DECOYS.prompt,
          last_assistant_message: HOOK_DECOYS.message,
          transcript_path: HOOK_DECOYS.transcript,
        }),
        "socket",
      );
      await pipeline.ingest(
        hookRecord({ cwd: HOOK_DECOYS.cwd, model: HOOK_DECOYS.model, hook_event_name: "Stop" }),
        "socket",
      );
      const everything = JSON.stringify({
        logged,
        published: kit.published,
        snapshot: kit.mirror.snapshot(),
        status: provider.status(),
        fact: pipeline.latestFor("thread-a"),
        stats: pipeline.stats(),
      });
      for (const value of Object.values(HOOK_DECOYS)) expect(everything).not.toContain(value);
      expect(everything).not.toContain("DECOY");
      expect(pipeline.latestFor("thread-a")?.event).toBe("Stop");
    } finally {
      kit.home.cleanup();
    }
  });
});

describe("Test 8: source scan", () => {
  const SOURCES = [
    "hook-pipeline.ts",
    "hook-overlay.ts",
    "hook-routes.ts",
    "hook-spool.ts",
    "hook-status.ts",
  ];
  const read = (name: string): string =>
    readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

  it("imports no process, network or Codex-home port module", () => {
    const banned =
      /from "node:(child_process|net|http|https|http2|dgram|tls|dns|worker_threads|cluster)"/;
    for (const name of SOURCES) {
      const text = read(name);
      expect(text, name).not.toMatch(banned);
      expect(text, name).not.toMatch(/from "\.\/(codex-home|store-reader|rate-limits-client)\.js"/);
      expect(text, name).not.toMatch(/\b(fetch|spawn|execFile|exec)\(/);
    }
  });

  it("takes no signal and arms no timer of its own", () => {
    for (const name of SOURCES) {
      const text = read(name);
      expect(text, name).not.toMatch(/process\.(on|once|kill|exit)\(/);
      expect(text, name).not.toMatch(/\b(setInterval|setTimeout)\(/);
    }
  });

  it("names no Codex hook file, configuration file or credential file", () => {
    const forbidden = [
      ["hooks", "json"].join("."),
      ["config", "toml"].join("."),
      ["auth", "json"].join("."),
      ".codex",
    ];
    for (const name of SOURCES) {
      const text = read(name);
      for (const word of forbidden) expect(text, `${name}:${word}`).not.toContain(word);
    }
  });

  it("has a positive control: the scan sees a planted word", () => {
    expect(`${["auth", "json"].join(".")} planted`).toContain("auth.json");
    expect(readdirSync(new URL(".", import.meta.url)).some((f) => SOURCES.includes(f))).toBe(true);
  });
});
