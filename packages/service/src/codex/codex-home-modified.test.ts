import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFakeCodexHome,
  type FakeCodexHome,
  recordingFs,
} from "../test-support/fake-codex-home.js";
import { createCodexHomePort, MAX_ROLLOUT_STATS } from "./codex-home.js";

let home: FakeCodexHome | undefined;
let outside: string | undefined;

afterEach(() => {
  home?.cleanup();
  home = undefined;
  if (outside !== undefined) rmSync(outside, { recursive: true, force: true });
  outside = undefined;
});

describe("05.1-post: listModifiedRolloutFiles stays inside the sessions folder", () => {
  it("never enumerates a symlinked day folder that points outside sessions", () => {
    home = createFakeCodexHome();
    outside = mkdtempSync(join(tmpdir(), "ccc-outside-"));
    writeFileSync(join(outside, "rollout-2026-07-01T09-00-00-zzzz.jsonl"), "x\n");
    mkdirSync(join(home.root, "sessions", "2026", "07"), { recursive: true });
    symlinkSync(outside, join(home.root, "sessions", "2026", "07", "01"));
    const rec = recordingFs();
    const port = createCodexHomePort({ root: home.root, fs: rec.fs });
    const listed = port.listModifiedRolloutFiles({
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

describe("05.2-gap: listModifiedRolloutFiles bounds its synchronous stat work", () => {
  it("stops statting once the stat budget is spent, however many old files a day holds", () => {
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
    const listed = port.listModifiedRolloutFiles({
      from: Date.parse("2026-09-09T12:00:00Z"),
      to: Date.parse("2026-10-10T12:00:00Z"),
    });
    expect(listed).toEqual([]);
    expect(rolloutStats).toBeLessThanOrEqual(MAX_ROLLOUT_STATS);
  });
});
