import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { keepAwakeCommands, spawnWdio } from "./wdio-spawn.js";

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed: string[] = [];
  constructor(readonly pid: number) {
    super();
  }
  kill(signal?: NodeJS.Signals): boolean {
    this.killed.push(signal ?? "SIGTERM");
    return true;
  }
}

describe("keepAwakeCommands (FIX8: a sleeping display kills the live Obsidian)", () => {
  it("on macOS wakes the display once and holds it (and the system) awake for as long as wdio runs", () => {
    expect(keepAwakeCommands(4321, "darwin")).toEqual([
      { file: "/usr/bin/caffeinate", args: ["-u", "-t", "3"] },
      { file: "/usr/bin/caffeinate", args: ["-d", "-i", "-w", "4321"] },
    ]);
  });

  it("does nothing on any other platform, or without a pid", () => {
    expect(keepAwakeCommands(4321, "linux")).toEqual([]);
    expect(keepAwakeCommands(undefined, "darwin")).toEqual([]);
  });
});

describe("spawnWdio keeps the display awake while wdio runs (FIX8)", () => {
  function run(platform: NodeJS.Platform, failCaffeinate = false) {
    const spawned: Array<{ file: string; args: readonly string[]; child: FakeChild }> = [];
    let nextPid = 100;
    const spawnFn = ((file: string, args: readonly string[]) => {
      const child = new FakeChild(nextPid++);
      spawned.push({ file, args, child });
      if (failCaffeinate && file.endsWith("caffeinate")) {
        queueMicrotask(() => child.emit("error", new Error("spawn ENOENT")));
      }
      if (file === process.execPath) {
        setTimeout(() => child.emit("exit", 0, null), 5);
      }
      return child;
    }) as never;
    const result = spawnWdio({
      sandbox: { registerChild: async () => undefined },
      configPath: "/x/wdio.conf.ts",
      cwd: "/x",
      wdioEnv: {},
      inherited: {},
      spawnFn,
      locate: () => "/x/wdio.js",
      platform,
    });
    return { spawned, result };
  }

  it("holds the display for the wdio child's pid and releases the holder when wdio exits", async () => {
    const { spawned, result } = run("darwin");
    await expect(result).resolves.toEqual({ exitCode: 0, signal: null });
    const holders = spawned.filter((entry) => entry.file === "/usr/bin/caffeinate");
    const wdio = spawned.find((entry) => entry.file === process.execPath);
    expect(holders.map((entry) => entry.args)).toEqual([
      ["-u", "-t", "3"],
      ["-d", "-i", "-w", String(wdio?.child.pid)],
    ]);
    // The holder is stopped through its handle once wdio is done.
    expect(holders[1]?.child.killed).toEqual(["SIGTERM"]);
  });

  it("a caffeinate that cannot start never fails the run", async () => {
    const { result } = run("darwin", true);
    await expect(result).resolves.toEqual({ exitCode: 0, signal: null });
  });

  it("spawns no holder off macOS", async () => {
    const { spawned, result } = run("linux");
    await result;
    expect(spawned.filter((entry) => entry.file.endsWith("caffeinate"))).toEqual([]);
  });
});
