import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFakeCodexHome,
  type FakeCodexHome,
  recordingFs,
} from "../test-support/fake-codex-home.js";
import { createCodexHomePort, MAX_ROLLOUT_LIST } from "./codex-home.js";

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
