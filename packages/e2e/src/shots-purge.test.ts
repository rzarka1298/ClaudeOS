import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRunPorts } from "./cli.js";
import { purgeStaleShotDirs, SHOTS_PREFIX } from "./screenshots.js";

/** Wave 3 WR-03 and Codex finding 4: a later run must not destroy a pending-look folder. */

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "ccc-shots-purge-"));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function shotsFolder(runId: string, ageMs: number): string {
  const dir = join(base, `${SHOTS_PREFIX}${runId}`);
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(dir, "look-pending.json"), "{}");
  const when = new Date(Date.now() - ageMs);
  utimesSync(dir, when, when);
  return dir;
}

const HOUR = 60 * 60 * 1000;

describe("purgeStaleShotDirs with an age bound (WR-03)", () => {
  it("keeps a folder newer than the bound and removes an older one", () => {
    const recent = shotsFolder("aaaaaaaa", HOUR);
    const old = shotsFolder("bbbbbbbb", 30 * 24 * HOUR);
    const removed = purgeStaleShotDirs({ base, keepRunIds: [], maxAgeMs: 7 * 24 * HOUR });
    expect(removed).toEqual([`${SHOTS_PREFIX}bbbbbbbb`]);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(old)).toBe(false);
  });

  it("without a bound it still removes every folder not kept", () => {
    const recent = shotsFolder("aaaaaaaa", HOUR);
    purgeStaleShotDirs({ base, keepRunIds: [] });
    expect(existsSync(recent)).toBe(false);
  });
});

describe("the real purge port keeps a recent pending-look folder (WR-03)", () => {
  it("does not delete the previous run's images and look-pending.json", () => {
    const previous = shotsFolder("aaaaaaaa", HOUR);
    createRunPorts().purgeShots(base);
    expect(existsSync(join(previous, "look-pending.json"))).toBe(true);
  });

  it("deletes a folder older than the bound", () => {
    const stale = shotsFolder("bbbbbbbb", 30 * 24 * HOUR);
    createRunPorts().purgeShots(base);
    expect(existsSync(stale)).toBe(false);
  });
});
