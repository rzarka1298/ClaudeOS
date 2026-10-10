// scripts/codex/test-support/bridge-window-simulator.cjs — a test-only model of an
// Antigravity window's extension: the CURRENT one (0.2.0: heartbeat with protocol,
// claims agent requests), an OUTDATED one (0.1.0: heartbeat without protocol, deletes
// any request mode it does not know) and a CLOSED window (no heartbeat, claims nothing).
// Adapter plans prove their behaviour against all three. Pure temp-dir tests.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadBridgeCore, loadWindowSimulator } from "./codex-bridge-core.js";

const core = loadBridgeCore();
const { createWindowSimulator } = loadWindowSimulator();
const T0 = Date.parse("2026-10-06T12:00:05.000Z");
const CREATED = "2026-10-06T12:00:00.000Z";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function tmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function world() {
  const state = tmp("ccc-sim-state-");
  const project = tmp("ccc-sim-project-");
  const bin = tmp("ccc-sim-bin-");
  core.ensureDirs(state);
  const exe = join(bin, "claude");
  writeFileSync(exe, "#!/bin/sh\n", { mode: 0o755 });
  const log = join(project, ".planning", "codex", "live", "20261006T120000000Z-review.log");
  mkdirSync(join(project, ".planning", "codex", "live"), { recursive: true });
  writeFileSync(log, "");
  const agentRequest = (runId: string, over: Record<string, unknown> = {}) => ({
    runId,
    kind: "agent",
    mode: "agent",
    agent: "claude",
    projectRoot: project,
    cwd: project,
    argv: [exe],
    env: {},
    sessionId: null,
    liveLog: null,
    pid: null,
    createdAt: CREATED,
    protocol: 2,
    ...over,
  });
  const followRequest = (runId: string) => ({
    runId,
    kind: "review",
    projectRoot: project,
    cwd: project,
    sessionId: null,
    liveLog: log,
    pid: 1,
    createdAt: CREATED,
  });
  const sim = (mode: "current" | "outdated" | "closed", folders = [project], key?: string) =>
    createWindowSimulator({ stateDir: state, folders, mode, now: T0, ...(key ? { key } : {}) });
  return { state, project, agentRequest, followRequest, sim };
}

const queued = (state: string) => readdirSync(join(state, "requests")).sort();
const claimedFiles = (state: string) => readdirSync(join(state, "claimed")).sort();

describe("current window", () => {
  it("writes a heartbeat with protocol 2 and the agent capability, and claims a valid agent request", () => {
    const w = world();
    const sim = w.sim("current");
    core.writeRequest(w.state, w.agentRequest("20261006T120000123Z"));
    const got = sim.tick();
    const hb = core.coveringHeartbeat(w.state, w.project, T0);
    expect(hb?.protocol).toBe(2);
    expect(hb?.capabilities).toContain("agent");
    expect(got).toHaveLength(1);
    expect(got[0]?.request.runId).toBe("20261006T120000123Z");
    expect(got[0]?.terminal).toEqual({
      name: "Claude Code",
      shellPath: "/simulated/home/.local/bin/codex-bridge",
      shellArgs: ["agent", "20261006T120000123Z"],
      cwd: w.project,
      isTransient: true,
    });
    expect(queued(w.state)).toEqual([]);
    expect(claimedFiles(w.state)).toEqual(["20261006T120000123Z.json"]);
  });

  it("also claims follow requests", () => {
    const w = world();
    core.writeRequest(w.state, w.followRequest("20261006T120000124Z"));
    const got = w.sim("current").tick();
    expect(got.map((c) => c.terminal.shellArgs)).toEqual([["follow", "20261006T120000124Z"]]);
  });

  it("leaves requests queued when the launcher is not installed, like the real extension", () => {
    const w = world();
    core.writeRequest(w.state, w.agentRequest("20261006T120000125Z"));
    const sim = createWindowSimulator({
      stateDir: w.state,
      folders: [w.project],
      mode: "current",
      now: T0,
      launcherInstalled: false,
    });
    expect(sim.tick()).toEqual([]);
    expect(queued(w.state)).toEqual(["20261006T120000125Z.json"]);
  });

  it("discards a hostile agent request and records why, without argv or env", () => {
    const w = world();
    core.writeRequest(
      w.state,
      w.agentRequest("20261006T120000126Z", { argv: [join(w.state, "x"), "--yolo"] }),
    );
    const sim = w.sim("current");
    expect(sim.tick()).toEqual([]);
    expect(queued(w.state)).toEqual([]);
    expect(sim.log.join("\n")).toMatch(/discarded 20261006T120000126Z\.json/);
    expect(sim.log.join("\n")).not.toMatch(/yolo/);
  });

  it("close() removes the heartbeat and the window stops claiming", () => {
    const w = world();
    const sim = w.sim("current");
    sim.heartbeat();
    expect(core.windowCovers(w.state, w.project, T0)).toBe(true);
    sim.close();
    expect(core.windowCovers(w.state, w.project, T0)).toBe(false);
    core.writeRequest(w.state, w.agentRequest("20261006T120000127Z"));
    expect(sim.tick()).toEqual([]);
    expect(queued(w.state)).toEqual(["20261006T120000127Z.json"]);
  });
});

describe("outdated window (extension 0.1.0)", () => {
  it("writes a heartbeat with only folders and updatedAt", () => {
    const w = world();
    const sim = w.sim("outdated", [w.project], "old");
    sim.heartbeat();
    const hb = JSON.parse(readFileSync(join(w.state, "windows", "old.json"), "utf8"));
    expect(Object.keys(hb).sort()).toEqual(["folders", "updatedAt"]);
    expect(core.coveringHeartbeat(w.state, w.project, T0)).toMatchObject({
      protocol: null,
      capabilities: null,
    });
  });

  it("discards an agent request exactly as 0.1.0 does: gone from requests, nothing claimed", () => {
    const w = world();
    const sim = w.sim("outdated");
    core.writeRequest(w.state, w.agentRequest("20261006T120000130Z"));
    expect(sim.tick()).toEqual([]);
    expect(queued(w.state)).toEqual([]);
    expect(claimedFiles(w.state)).toEqual([]);
    expect(sim.log.join("\n")).toMatch(/discarded 20261006T120000130Z\.json: bad kind/);
  });

  it("discards a mode-agent request whose kind is old, as 'bad mode'", () => {
    const w = world();
    const sim = w.sim("outdated");
    core.writeRequest(w.state, {
      ...w.followRequest("20261006T120000131Z"),
      mode: "agent",
    });
    expect(sim.tick()).toEqual([]);
    expect(queued(w.state)).toEqual([]);
    expect(sim.log.join("\n")).toMatch(/discarded 20261006T120000131Z\.json: bad mode/);
  });

  it("still claims a follow request", () => {
    const w = world();
    core.writeRequest(w.state, w.followRequest("20261006T120000132Z"));
    const got = w.sim("outdated").tick();
    expect(got.map((c) => c.terminal.shellArgs)).toEqual([["follow", "20261006T120000132Z"]]);
    expect(claimedFiles(w.state)).toEqual(["20261006T120000132Z.json"]);
  });

  it("deletes even another project's agent request, because 0.1.0 validates before it matches a folder", () => {
    const w = world();
    const other = tmp("ccc-sim-other-");
    const sim = w.sim("outdated", [other]);
    core.writeRequest(w.state, w.agentRequest("20261006T120000133Z"));
    expect(sim.tick()).toEqual([]);
    expect(queued(w.state)).toEqual([]);
  });
});

describe("closed window", () => {
  it("writes no heartbeat and claims nothing; the request stays queued", () => {
    const w = world();
    const sim = w.sim("closed");
    sim.heartbeat();
    core.writeRequest(w.state, w.agentRequest("20261006T120000140Z"));
    expect(sim.tick()).toEqual([]);
    expect(
      existsSync(join(w.state, "windows")) ? readdirSync(join(w.state, "windows")) : [],
    ).toEqual([]);
    expect(queued(w.state)).toEqual(["20261006T120000140Z.json"]);
  });
});

describe("two windows", () => {
  it("exactly one of two windows on one folder claims a request", () => {
    const w = world();
    const a = w.sim("current", [w.project], "a");
    const b = w.sim("current", [w.project], "b");
    core.writeRequest(w.state, w.agentRequest("20261006T120000150Z"));
    const total = a.tick().length + b.tick().length;
    expect(total).toBe(1);
    expect(claimedFiles(w.state)).toEqual(["20261006T120000150Z.json"]);
  });

  it("a window that only contains the project waits the contain delay", () => {
    const w = world();
    const parent = realpathSync(join(w.project, ".."));
    const sim = createWindowSimulator({
      stateDir: w.state,
      folders: [parent],
      mode: "current",
      now: Date.parse("2026-10-06T12:00:00.500Z"),
    });
    core.writeRequest(w.state, w.agentRequest("20261006T120000151Z"));
    expect(sim.tick()).toEqual([]);
    expect(queued(w.state)).toEqual(["20261006T120000151Z.json"]);
    sim.setNow(Date.parse("2026-10-06T12:00:03.000Z"));
    expect(sim.tick().map((c) => c.request.runId)).toEqual(["20261006T120000151Z"]);
  });

  it("an exact-folder window wins over a containing window that polls first", () => {
    const w = world();
    const parent = realpathSync(join(w.project, ".."));
    const containing = createWindowSimulator({
      stateDir: w.state,
      folders: [parent],
      mode: "current",
      now: Date.parse("2026-10-06T12:00:00.500Z"),
      key: "contains",
    });
    const exact = createWindowSimulator({
      stateDir: w.state,
      folders: [w.project],
      mode: "current",
      now: Date.parse("2026-10-06T12:00:00.600Z"),
      key: "exact",
    });
    core.writeRequest(w.state, w.agentRequest("20261006T120000152Z"));
    expect(containing.tick()).toEqual([]);
    expect(exact.tick()).toHaveLength(1);
  });
});

describe("safety", () => {
  it("refuses a state directory outside the system temporary directory", () => {
    for (const stateDir of [
      "/Users/USERNAME/.local/state/codex-bridge",
      "/",
      "relative/dir",
      join(tmpdir(), "..", "escape"),
      tmpdir(),
    ]) {
      expect(
        () => createWindowSimulator({ stateDir, folders: [], mode: "current" }),
        stateDir,
      ).toThrow();
    }
  });

  it("refuses a symlink inside the temp dir that points outside it", () => {
    const outside = "/Users";
    const dir = tmp("ccc-sim-link-");
    const link = join(dir, "state");
    symlinkSync(outside, link);
    expect(() =>
      createWindowSimulator({ stateDir: join(link, "x"), folders: [], mode: "current" }),
    ).toThrow();
  });

  it("refuses an unknown mode", () => {
    const w = world();
    expect(() =>
      createWindowSimulator({ stateDir: w.state, folders: [], mode: "weird" as never }),
    ).toThrow();
  });
});

describe("test-fixtures dependency wiring", () => {
  it("resolves @ccc/collectors, @ccc/launchers and better-sqlite3", async () => {
    const collectors = await import("@ccc/collectors");
    const launchers = await import("@ccc/launchers");
    const sqlite = await import("better-sqlite3");
    expect(typeof collectors.compareVersions).toBe("function");
    // the bridge ban tokens must include the Phase 4 pair the launchers validator refuses
    for (const token of launchers.FORBIDDEN_PERMISSION_TOKENS) {
      expect(core.BANNED_TOKENS).toContain(token);
    }
    const Database = sqlite.default;
    const db = new Database(":memory:");
    expect(db.prepare("select 1 as one").get()).toEqual({ one: 1 });
    db.close();
  });
});
