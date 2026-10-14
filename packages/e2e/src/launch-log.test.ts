import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LAUNCH_EVENTS_LOG, readLaunchEvents, recordLaunchEvent } from "./launch-log.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const fresh = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "ccc-launch-log-"));
  dirs.push(dir);
  return join(dir, "wdio");
};

describe("the launch event log", () => {
  it("reads nothing when no event was recorded", () => {
    expect(readLaunchEvents(fresh())).toEqual([]);
  });

  it("records events into the wdio folder and reads back each kind once, in order", () => {
    const dir = fresh();
    recordLaunchEvent(dir, "app-exit-timeout", "the previous app was still running after 20 s");
    recordLaunchEvent(dir, "launch-retry", "relaunching once");
    recordLaunchEvent(dir, "app-exit-timeout", "again");
    expect(readLaunchEvents(dir)).toEqual(["app-exit-timeout", "launch-retry"]);
    expect(LAUNCH_EVENTS_LOG).toBe("launch-retries.log");
  });

  it("ignores lines that are not recorded events", () => {
    const dir = fresh();
    recordLaunchEvent(dir, "launch-retry", "x");
    expect(readLaunchEvents(dir)).toEqual(["launch-retry"]);
  });
});
