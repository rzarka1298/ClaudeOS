import { statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertNoForbiddenAccess,
  assertNoMarkerLeak,
  assertOnlySidecarChanges,
  createFakeCodexHome,
  diffSnapshots,
  exerciseCodexHomePort,
  exerciseCodexStoreReader,
  type FakeCodexHome,
  type FakeThread,
  NEVER_SELECT_DECOYS,
  recordingFs,
  recordingOpener,
  SQLITE_SIDECARS,
} from "../test-support/fake-codex-home.js";
import { type CodexHomePort, createCodexHomePort } from "./codex-home.js";
import { createCodexStoreReader } from "./store-reader.js";

/**
 * The CODEX-09 credential canary, port level (plan 05.1-14 task 1). The
 * fake CODEX_HOME holds a decoy credential file, a decoy config file and
 * lookalike names. The assertion is on file-system ACCESS (a recording
 * wrapper around the injected operations), so a swallowed error still counts
 * as a failure, and on every output channel: return values, thrown messages
 * and log calls.
 */

let home: FakeCodexHome | undefined;

afterEach(() => {
  home?.cleanup();
  home = undefined;
  vi.restoreAllMocks();
});

function makeHome(): FakeCodexHome {
  home = createFakeCodexHome({
    rollouts: [
      {
        day: "2026-10-06",
        name: "rollout-2026-10-06T10-00-00-aaaa.jsonl",
        content: "line-one\nline-two\n",
      },
    ],
    archivedRollouts: [{ day: "2026-10-06", name: "rollout-x.jsonl", content: "archived\n" }],
    sessionIndex: '{"id":"synthetic-1"}\n',
    hooksJson: "{}",
    version: '{"latest_version":"0.0.0"}',
    withDecoys: true,
  });
  return home;
}

describe("Test 6: the port-level credential canary", () => {
  it("records no decoy access and leaks no marker through any port method", () => {
    const fake = makeHome();
    const rec = recordingFs();
    const port = createCodexHomePort({ root: fake.root, fs: rec.fs });

    const logSpies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined),
    );
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const exercise = exerciseCodexHomePort(port, fake);

    // Access: the helper throws on a decoy, a lookalike or anything off the allowlist.
    expect(rec.calls.length).toBeGreaterThan(0);
    expect(() => assertNoForbiddenAccess(rec.calls, fake)).not.toThrow();

    // Output: no return value and no thrown message carries the marker or a decoy name.
    const joined = exercise.outputs.join("\n");
    expect(joined).not.toContain(fake.decoys.marker);
    expect(joined).not.toContain(fake.decoys.credentialName);
    expect(joined).not.toContain(fake.decoys.configName);

    // Logs: nothing was written to a log channel carrying the marker.
    const logged = [
      ...logSpies.flatMap((spy) => spy.mock.calls),
      ...stdout.mock.calls,
      ...stderr.mock.calls,
    ]
      .map((call) => String(call[0]))
      .join("\n");
    expect(logged).not.toContain(fake.decoys.marker);
  });

  it("reads each decoy name zero times, however it is requested", () => {
    const fake = makeHome();
    const rec = recordingFs();
    const port = createCodexHomePort({ root: fake.root, fs: rec.fs });
    exerciseCodexHomePort(port, fake);
    const names = [
      fake.decoys.credentialName,
      fake.decoys.configName,
      ...fake.decoys.lookalikeNames,
    ];
    for (const call of rec.calls) {
      for (const name of names) expect(call.path.endsWith(name)).toBe(false);
    }
  });
});

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const MINUTE = 60_000;

function recentThreads(): FakeThread[] {
  return Array.from({ length: 8 }, (_, index) => ({
    id: `thread-${index}`,
    updatedAtMs: NOW - (index + 1) * MINUTE,
    title: `SYNTHETIC-TITLE-${index}`,
  }));
}

function makeFullHome(withDatabase = true): FakeCodexHome {
  const threads = recentThreads();
  home = createFakeCodexHome({
    rollouts: threads.map((thread) => ({
      day: "2026-10-06",
      name: `rollout-${thread.id}.jsonl`,
      content: "{}\n",
      mtimeMs: thread.updatedAtMs,
    })),
    archivedRollouts: [{ day: "2026-10-06", name: "rollout-x.jsonl", content: "archived\n" }],
    sessionIndex: '{"id":"synthetic-1"}\n',
    hooksJson: "{}",
    version: '{"latest_version":"0.0.0"}',
    withDecoys: true,
    ...(withDatabase ? { database: { ddl: "current" as const, threads } } : {}),
  });
  return home;
}

interface FullRun {
  readonly calls: ReturnType<typeof recordingFs>["calls"];
  readonly outputs: string[];
}

/** Runs the port and the store reader together over one recording file system. */
function runEverything(
  fake: FakeCodexHome,
  portOverride?: (real: CodexHomePort) => CodexHomePort,
): FullRun {
  const rec = recordingFs();
  const realPort = createCodexHomePort({ root: fake.root, fs: rec.fs });
  const port = portOverride === undefined ? realPort : portOverride(realPort);
  const reader = createCodexStoreReader({
    port,
    openDatabase: recordingOpener(rec.calls),
    now: () => NOW,
  });
  const outputs = [
    ...exerciseCodexHomePort(port, fake).outputs,
    ...exerciseCodexStoreReader(reader, NOW).outputs,
  ];
  return { calls: rec.calls, outputs };
}

describe("Test 1 (task 3): the canary over the store reader and the port together", () => {
  it("touches only allowlisted paths and leaks no decoy through any channel", () => {
    const fake = makeFullHome();
    const decoyPaths = [
      fake.decoys.credentialPath,
      fake.decoys.configPath,
      ...fake.decoys.lookalikeNames.map((name) => join(fake.root, name)),
    ];
    const longAgo = 1_000_000;
    const atimes = new Map<string, number>();
    for (const path of decoyPaths) {
      utimesSync(path, longAgo, statSync(path).mtimeMs / 1000);
      atimes.set(path, statSync(path).atimeMs);
    }

    const logSpies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined),
    );
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const run = runEverything(fake);

    expect(run.calls.some((call) => call.op === "openDatabase")).toBe(true);
    expect(() => assertNoForbiddenAccess(run.calls, fake)).not.toThrow();
    expect(() => assertNoMarkerLeak(run.outputs, fake)).not.toThrow();
    for (const decoy of NEVER_SELECT_DECOYS) {
      expect(run.outputs.join("\n")).not.toContain(decoy);
    }
    const logged = [
      ...logSpies.flatMap((spy) => spy.mock.calls),
      ...stdout.mock.calls,
      ...stderr.mock.calls,
    ]
      .map((call) => String(call[0]))
      .join("\n");
    expect(logged).not.toContain(fake.decoys.marker);

    // The decoys were not even read: their access times did not move.
    for (const path of decoyPaths) expect(statSync(path).atimeMs).toBe(atimes.get(path));
  });
});

describe("Test 2 (task 3): only SQLite sidecars may appear in the directory", () => {
  it("differs by the read-only sidecars at most, and no mtime of another file moves", () => {
    const fake = makeFullHome();
    const before = fake.snapshot();
    runEverything(fake);
    const diff = diffSnapshots(before, fake.snapshot());
    expect(() => assertOnlySidecarChanges(diff)).not.toThrow();
    for (const name of [...diff.added, ...diff.removed]) {
      expect(SQLITE_SIDECARS).toContain(name);
    }
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    // The documented residual (research R3): a read-only open of a closed WAL store makes both.
    expect(diff.added).toEqual([...SQLITE_SIDECARS].sort());
    expect(diff.added.every((name) => SQLITE_SIDECARS.includes(name))).toBe(true);
  });
});

describe("Test 3 (task 3): with no database nothing changes", () => {
  it("leaves the directory exactly as it was", () => {
    const fake = makeFullHome(false);
    const before = fake.snapshot();
    const run = runEverything(fake);
    expect(run.calls.some((call) => call.op === "openDatabase")).toBe(false);
    const diff = diffSnapshots(before, fake.snapshot());
    expect(diff).toEqual({ added: [], removed: [], changed: [] });
  });
});

describe("Test 5 (task 3): the canary has teeth (negative controls)", () => {
  it("fails when a port double reads the decoy credential file", () => {
    const fake = makeFullHome();
    const rec = recordingFs();
    const bad = (real: CodexHomePort): CodexHomePort => ({
      ...real,
      readNamed: (name, maxBytes) => {
        rec.fs.readBytes(fake.decoys.credentialPath, 0, 16);
        return real.readNamed(name, maxBytes);
      },
    });
    const run = runEverything(fake, bad);
    expect(() => assertNoForbiddenAccess([...run.calls, ...rec.calls], fake)).toThrow(/canary/);
  });

  it("fails when a decoy lookalike is stat-ed", () => {
    const fake = makeFullHome();
    const rec = recordingFs();
    const lookalike = join(fake.root, fake.decoys.lookalikeNames[0] ?? "");
    rec.fs.stat(lookalike);
    expect(() => assertNoForbiddenAccess(rec.calls, fake)).toThrow(/canary/);
  });

  it("fails when the reader is pointed at the credential file", () => {
    const fake = makeFullHome();
    const calls = recordingFs().calls;
    const reader = createCodexStoreReader({
      port: {
        stateDbPath: () => fake.decoys.credentialPath,
        statRollout: () => null,
      },
      openDatabase: recordingOpener(calls),
      now: () => NOW,
    });
    const result = reader.readThreads({ sinceMs: 0, limit: 5, includePromptDerived: false });
    expect(result.kind).toBe("unavailable");
    expect(() => assertNoForbiddenAccess(calls, fake)).toThrow(/canary/);
  });

  it("fails when a return value carries the marker", () => {
    const fake = makeFullHome();
    const leaked = [`oops ${fake.decoys.marker}`];
    expect(() => assertNoMarkerLeak(leaked, fake)).toThrow(/canary/);
    expect(() => assertNoMarkerLeak(["clean"], fake)).not.toThrow();
  });

  it("fails when a decoy file is modified or an unexpected file appears", () => {
    const fake = makeFullHome();
    const before = fake.snapshot();
    writeFileSync(fake.decoys.credentialPath, "tampered-with-a-longer-body\n");
    expect(() => assertOnlySidecarChanges(diffSnapshots(before, fake.snapshot()))).toThrow(
      /canary/,
    );

    const second = fake.snapshot();
    writeFileSync(join(fake.root, "stray.txt"), "x");
    expect(() => assertOnlySidecarChanges(diffSnapshots(second, fake.snapshot()))).toThrow(
      /canary/,
    );
  });

  it("accepts a sidecar-only change and an unchanged directory", () => {
    const fake = makeFullHome();
    const before = fake.snapshot();
    expect(() => assertOnlySidecarChanges(diffSnapshots(before, fake.snapshot()))).not.toThrow();
    writeFileSync(join(fake.root, SQLITE_SIDECARS[0] ?? ""), "");
    const diff = diffSnapshots(before, fake.snapshot());
    expect(diff.added).toEqual([SQLITE_SIDECARS[0]]);
    expect(() => assertOnlySidecarChanges(diff)).not.toThrow();
  });
});
