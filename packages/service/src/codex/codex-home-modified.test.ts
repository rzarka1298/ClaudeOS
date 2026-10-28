import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFakeCodexHome,
  type FakeCodexHome,
  recordingFs,
} from "../test-support/fake-codex-home.js";
import {
  createCodexHomePort,
  MAX_ROLLOUT_LIST,
  MAX_ROLLOUT_STATS,
  ROLLOUT_STAT_CHUNK,
} from "./codex-home.js";

let home: FakeCodexHome | undefined;
let outside: string | undefined;

afterEach(() => {
  home?.cleanup();
  home = undefined;
  if (outside !== undefined) rmSync(outside, { recursive: true, force: true });
  outside = undefined;
});

describe("05.1-post: listModifiedRolloutFiles stays inside the sessions folder", () => {
  it("never enumerates a symlinked day folder that points outside sessions", async () => {
    home = createFakeCodexHome();
    outside = mkdtempSync(join(tmpdir(), "ccc-outside-"));
    writeFileSync(join(outside, "rollout-2026-07-01T09-00-00-zzzz.jsonl"), "x\n");
    mkdirSync(join(home.root, "sessions", "2026", "07"), { recursive: true });
    symlinkSync(outside, join(home.root, "sessions", "2026", "07", "01"));
    const rec = recordingFs();
    const port = createCodexHomePort({ root: home.root, fs: rec.fs });
    const listed = await port.listModifiedRolloutFiles({
      from: Date.parse("2026-09-09T12:00:00Z"),
      to: Date.parse("2026-10-10T12:00:00Z"),
    });
    expect(listed).toEqual([]);
    const outsideReal = outside;
    expect(
      rec.calls.some((call) => call.path.startsWith(outsideReal) && call.op !== "realpath"),
    ).toBe(false);
  });
});

describe("05.1-sec NEW-02: listNewestRolloutFiles limit and containment", () => {
  const range = {
    from: Date.parse("2026-10-06T00:00:00Z"),
    to: Date.parse("2026-10-06T12:00:00Z"),
  };

  it("never enumerates a symlinked day folder that points outside sessions", () => {
    home = createFakeCodexHome();
    outside = mkdtempSync(join(tmpdir(), "ccc-outside-"));
    writeFileSync(join(outside, "rollout-2026-10-06T09-00-00-zzzz.jsonl"), "x\n");
    mkdirSync(join(home.root, "sessions", "2026", "10"), { recursive: true });
    symlinkSync(outside, join(home.root, "sessions", "2026", "10", "06"));
    const rec = recordingFs();
    const port = createCodexHomePort({ root: home.root, fs: rec.fs });
    expect(port.listNewestRolloutFiles(range, 50)).toEqual([]);
    const outsideReal = outside;
    expect(
      rec.calls.some((call) => call.path.startsWith(outsideReal) && call.op !== "realpath"),
    ).toBe(false);
  });

  it("treats a NaN, negative, fractional or infinite limit as the default cap, never above it", () => {
    home = createFakeCodexHome();
    const dir = join(home.root, "sessions", "2026", "10", "06");
    mkdirSync(dir, { recursive: true });
    const total = MAX_ROLLOUT_LIST + 20;
    for (let i = 0; i < total; i += 1) {
      writeFileSync(
        join(dir, `rollout-2026-10-06T10-00-00-${String(i).padStart(5, "0")}.jsonl`),
        "",
      );
    }
    const port = createCodexHomePort({ root: home.root });
    for (const limit of [
      Number.NaN,
      -3,
      0.5,
      Number.POSITIVE_INFINITY,
      Number.MAX_VALUE,
      MAX_ROLLOUT_LIST * 10,
    ]) {
      const listed = port.listNewestRolloutFiles(range, limit);
      expect(listed.length, String(limit)).toBeGreaterThan(0);
      expect(listed.length, String(limit)).toBeLessThanOrEqual(MAX_ROLLOUT_LIST);
    }
    expect(port.listNewestRolloutFiles(range, 7)).toHaveLength(7);
  });
});

describe("05.2-gap: listModifiedRolloutFiles bounds its synchronous stat work", () => {
  it("stops statting once the stat budget is spent, however many old files a day holds", async () => {
    home = createFakeCodexHome();
    const day = join(home.root, "sessions", "2026", "07", "01");
    mkdirSync(day, { recursive: true });
    const real = recordingFs().fs;
    let rolloutStats = 0;
    const synthetic = Array.from({ length: MAX_ROLLOUT_STATS + 500 }, (_, i) => ({
      name: `rollout-2026-07-01T09-00-00-${String(i).padStart(6, "0")}.jsonl`,
      isFile: true,
    }));
    const fs = {
      ...real,
      readDir: (path: string) => (path === day ? synthetic : real.readDir(path)),
      stat: (path: string) => {
        if (path.startsWith(day) && path.endsWith(".jsonl")) {
          rolloutStats += 1;
          return { isFile: true, size: 1, mtimeMs: 0 };
        }
        return real.stat(path);
      },
    };
    const port = createCodexHomePort({ root: home.root, fs });
    const listed = await port.listModifiedRolloutFiles({
      from: Date.parse("2026-09-09T12:00:00Z"),
      to: Date.parse("2026-10-10T12:00:00Z"),
    });
    expect(listed).toEqual([]);
    expect(rolloutStats).toBeLessThanOrEqual(MAX_ROLLOUT_STATS);
  });
});

describe("09-11 D-15: listModifiedRolloutFiles yields to the event loop between bounded chunks", () => {
  const range = {
    from: Date.parse("2026-09-09T12:00:00Z"),
    to: Date.parse("2026-10-10T12:00:00Z"),
  };
  const rolloutName = (i: number): string =>
    `rollout-2026-07-01T09-00-00-${String(i).padStart(6, "0")}.jsonl`;

  it("lists 10,000 old files in order, identical to the unchunked walk, and yields at least 40 times", async () => {
    home = createFakeCodexHome();
    // 40 day folders (Jul 1..31, Aug 1..9), 250 rollouts each; every 7th file is recent enough to list.
    const days: string[][] = [];
    for (let d = 0; d < 40; d += 1) {
      const date = new Date(Date.UTC(2026, 6, 1 + d));
      const parts = [
        String(date.getUTCFullYear()),
        String(date.getUTCMonth() + 1).padStart(2, "0"),
        String(date.getUTCDate()).padStart(2, "0"),
      ];
      mkdirSync(join(home.root, "sessions", ...parts), { recursive: true });
      days.push(parts);
    }
    const real = recordingFs().fs;
    const dayDir = (parts: readonly string[]): string => join(home?.root ?? "", "sessions", ...parts);
    const namesFor = (): string[] => Array.from({ length: 250 }, (_, i) => rolloutName(i));
    const recent = (name: string): boolean => Number(name.slice(-12, -6)) % 7 === 0;
    const fs = {
      ...real,
      readDir: (path: string) =>
        days.some((parts) => dayDir(parts) === path)
          ? namesFor().map((name) => ({ name, isFile: true }))
          : real.readDir(path),
      stat: (path: string) =>
        path.endsWith(".jsonl") && path.includes(join("sessions", "2026"))
          ? {
              isFile: true,
              size: 1,
              mtimeMs: recent(path.slice(path.lastIndexOf("/") + 1)) ? range.from + 1 : 0,
            }
          : real.stat(path),
    };
    // The previous synchronous algorithm, restated: newest folder first, names descending, mtime filter.
    const expected: string[] = [];
    for (const parts of [...days].reverse()) {
      for (const name of namesFor().sort().reverse()) {
        if (recent(name)) expected.push(join(dayDir(parts), name));
      }
    }
    let yields = 0;
    const port = createCodexHomePort({
      root: home.root,
      fs,
      yieldNow: () => {
        yields += 1;
        return Promise.resolve();
      },
    });
    const listed = await port.listModifiedRolloutFiles(range);
    expect(expected.length).toBeGreaterThan(0);
    expect(listed.map((ref) => ref.path)).toEqual(expected);
    expect(yields).toBeGreaterThanOrEqual(MAX_ROLLOUT_STATS / ROLLOUT_STAT_CHUNK);
  });

  it("yields inside a single large folder, once per stat chunk", async () => {
    home = createFakeCodexHome();
    const day = join(home.root, "sessions", "2026", "07", "01");
    mkdirSync(day, { recursive: true });
    const real = recordingFs().fs;
    const names = Array.from({ length: ROLLOUT_STAT_CHUNK * 4 }, (_, i) => rolloutName(i));
    const fs = {
      ...real,
      readDir: (path: string) =>
        path === day ? names.map((name) => ({ name, isFile: true })) : real.readDir(path),
      stat: (path: string) =>
        path.endsWith(".jsonl") ? { isFile: true, size: 1, mtimeMs: 0 } : real.stat(path),
    };
    let yields = 0;
    const port = createCodexHomePort({
      root: home.root,
      fs,
      yieldNow: () => {
        yields += 1;
        return Promise.resolve();
      },
    });
    await port.listModifiedRolloutFiles(range);
    // Four full stat chunks plus the folder boundary.
    expect(yields).toBeGreaterThanOrEqual(5);
  });
});
