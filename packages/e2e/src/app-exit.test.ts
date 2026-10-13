import { describe, expect, it } from "vitest";
import { waitForAppExit } from "./app-exit.js";

const APP = "/Applications/Obsidian.app/Contents/MacOS/Obsidian";
const ROOT = "/private/tmp/ccc-uat.abc123";

describe("waitForAppExit", () => {
  it("returns once no Obsidian process names the run root, polling the table", async () => {
    let calls = 0;
    const tables = [
      [{ pid: 10, start: "s", command: `${APP} --user-data-dir=${ROOT}/x` }],
      [{ pid: 10, start: "s", command: `${APP} --type=gpu ${ROOT}/x` }],
      [{ pid: 20, start: "s", command: "node worker" }],
    ];
    const waited = await waitForAppExit({
      readTable: async () => tables[Math.min(calls++, 2)] ?? [],
      appBinary: APP,
      runRoot: ROOT,
      sleep: async () => undefined,
      now: () => 0,
      timeoutMs: 10_000,
      intervalMs: 100,
    });
    expect(waited).toEqual({ exited: true, polls: 3 });
  });

  it("gives up at the bound and says so, never killing anything", async () => {
    let t = 0;
    const waited = await waitForAppExit({
      readTable: async () => [{ pid: 10, start: "s", command: `${APP} ${ROOT}` }],
      appBinary: APP,
      runRoot: ROOT,
      sleep: async () => {
        t += 1_000;
      },
      now: () => t,
      timeoutMs: 3_000,
      intervalMs: 1_000,
    });
    expect(waited.exited).toBe(false);
  });
});
