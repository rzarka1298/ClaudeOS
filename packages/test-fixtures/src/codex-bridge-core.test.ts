// scripts/codex/antigravity-extension/bridge-core.js — the codex-bridge request
// protocol the Antigravity extension runs on. Pure functions over a temp state
// dir; the vscode glue (extension.js) stays a thin shell around these.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadBridgeCore } from "./codex-bridge-core.js";

const core = loadBridgeCore();
const SESSION = "11111111-2222-3333-4444-555555555555";
const RUN = "20260930T120000000Z";
const NOW = Date.parse("2026-09-30T12:00:05.000Z");

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function tmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

interface World {
  state: string;
  project: string;
  liveLog: string;
  request(over?: Record<string, unknown>): Record<string, unknown>;
  queue(over?: Record<string, unknown>): string;
}

function world(): World {
  const state = tmp("ccc-bridge-state-");
  const project = tmp("ccc-bridge-project-");
  core.ensureDirs(state);
  const live = join(project, ".planning", "codex", "live");
  mkdirSync(live, { recursive: true });
  const liveLog = join(live, `${RUN}-review.log`);
  writeFileSync(liveLog, "");
  const request = (over: Record<string, unknown> = {}) => ({
    runId: RUN,
    kind: "review",
    projectRoot: project,
    cwd: project,
    sessionId: SESSION,
    liveLog,
    pid: 123,
    createdAt: "2026-09-30T12:00:00.000Z",
    ...over,
  });
  return {
    state,
    project,
    liveLog,
    request,
    queue(over = {}) {
      const r = request(over);
      const name = `${String(r.runId)}.json`;
      writeFileSync(join(state, "requests", name), JSON.stringify(r));
      return name;
    },
  };
}

describe("bridgeStateDir / bridgeCommand", () => {
  it("defaults to ~/.local/state/codex-bridge and honours an absolute XDG_STATE_HOME", () => {
    expect(core.bridgeStateDir({}, "/h")).toBe("/h/.local/state/codex-bridge");
    expect(core.bridgeStateDir({ XDG_STATE_HOME: "/x" }, "/h")).toBe("/x/codex-bridge");
    expect(core.bridgeStateDir({ XDG_STATE_HOME: "rel" }, "/h")).toBe(
      "/h/.local/state/codex-bridge",
    );
    expect(core.bridgeCommand("/h")).toBe("/h/.local/bin/codex-bridge");
  });
});

describe("validateRequest", () => {
  it("accepts a well-formed request and returns real paths", () => {
    const w = world();
    const v = core.validateRequest(w.request(), { stateDir: w.state, now: NOW });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.request).toMatchObject({ runId: RUN, projectRoot: w.project });
  });

  it("accepts a null session id and a live log inside the bridge state dir", () => {
    const w = world();
    const log = join(w.state, "projects", "p", "live", "x-task.log");
    mkdirSync(join(w.state, "projects", "p", "live"), { recursive: true });
    writeFileSync(log, "");
    const v = core.validateRequest(w.request({ sessionId: null, liveLog: log, kind: "task" }), {
      stateDir: w.state,
      now: NOW,
    });
    expect(v.ok).toBe(true);
  });

  it.each([
    ["a path-like run id", { runId: "../../etc/passwd" }],
    ["a run id with shell metacharacters", { runId: "20260930T120000000Z; rm -rf ~" }],
    ["an unknown kind", { kind: "exec" }],
    ["a relative project root", { projectRoot: "relative/dir" }],
    ["a missing project root", { projectRoot: "/nonexistent/project" }],
    ["a missing cwd", { cwd: "/nonexistent/cwd" }],
    ["a non-UUID session id", { sessionId: "abc; codex --yolo" }],
    ["a non-.log live log", { liveLog: "/etc/hosts" }],
    ["a non-integer pid", { pid: "1" }],
    ["a bad createdAt", { createdAt: "yesterday" }],
    ["a createdAt in the future", { createdAt: "2026-09-30T13:00:00.000Z" }],
  ])("rejects %s", (_label, over) => {
    const w = world();
    expect(core.validateRequest(w.request(over), { stateDir: w.state, now: NOW }).ok).toBe(false);
  });

  it("rejects a live log outside the allowed dirs, including through a symlink", () => {
    const w = world();
    const outside = join(tmp("ccc-bridge-out-"), "x.log");
    writeFileSync(outside, "");
    expect(
      core.validateRequest(w.request({ liveLog: outside }), { stateDir: w.state, now: NOW }).ok,
    ).toBe(false);
    const link = join(w.state, "sneaky.log");
    symlinkSync(outside, link);
    expect(
      core.validateRequest(w.request({ liveLog: link }), { stateDir: w.state, now: NOW }).ok,
    ).toBe(false);
  });

  it("marks requests older than the TTL as expired", () => {
    const w = world();
    const v = core.validateRequest(w.request(), {
      stateDir: w.state,
      now: NOW + core.TTL_MS,
    });
    expect(v).toMatchObject({ ok: false, expired: true });
  });
});

describe("matchScore", () => {
  it("scores exact 2, containing 1, unrelated 0", () => {
    const w = world();
    const parent = join(w.project, "..");
    expect(core.matchScore([w.project], w.project)).toBe(2);
    expect(core.matchScore([parent], w.project)).toBe(1);
    expect(core.matchScore([tmp("ccc-other-")], w.project)).toBe(0);
    expect(core.matchScore([join(w.project, ".planning")], w.project)).toBe(0);
  });

  it("follows symlinks to the real folder", () => {
    const w = world();
    const link = join(tmp("ccc-link-"), "proj");
    symlinkSync(w.project, link);
    expect(core.matchScore([link], w.project)).toBe(2);
  });
});

describe("scanRequests", () => {
  it("claims a request for the window that has the project open, exactly once", () => {
    const w = world();
    w.queue();
    const first = core.scanRequests({ stateDir: w.state, folders: [w.project], now: NOW });
    const second = core.scanRequests({ stateDir: w.state, folders: [w.project], now: NOW });
    expect(first.map((r) => r.runId)).toEqual([RUN]);
    expect(second).toEqual([]);
    expect(existsSync(join(w.state, "claimed", `${RUN}.json`))).toBe(true);
    expect(readdirSync(join(w.state, "requests"))).toEqual([]);
  });

  it("leaves another project's request alone", () => {
    const w = world();
    w.queue();
    expect(
      core.scanRequests({ stateDir: w.state, folders: [tmp("ccc-other-")], now: NOW }),
    ).toEqual([]);
    expect(readdirSync(join(w.state, "requests"))).toEqual([`${RUN}.json`]);
  });

  it("a window that only contains the project waits so an exact window can win", () => {
    const w = world();
    w.queue();
    const parent = realpathSync(join(w.project, ".."));
    const early = core.scanRequests({
      stateDir: w.state,
      folders: [parent],
      now: Date.parse("2026-09-30T12:00:00.500Z"),
    });
    expect(early).toEqual([]);
    const later = core.scanRequests({ stateDir: w.state, folders: [parent], now: NOW });
    expect(later.map((r) => r.runId)).toEqual([RUN]);
  });

  it("discards expired, invalid, misnamed and unreadable requests", () => {
    const w = world();
    w.queue({ runId: "20260930T110000000Z", createdAt: "2026-09-30T11:00:00.000Z" });
    w.queue({ runId: "20260930T120000001Z", sessionId: "not-a-uuid" });
    writeFileSync(
      join(w.state, "requests", "20260930T120000002Z.json"),
      JSON.stringify(w.request()),
    );
    writeFileSync(join(w.state, "requests", "20260930T120000003Z.json"), "{not json");
    const log: string[] = [];
    const got = core.scanRequests({
      stateDir: w.state,
      folders: [w.project],
      now: NOW,
      log: (m) => log.push(m),
    });
    expect(got).toEqual([]);
    expect(readdirSync(join(w.state, "requests"))).toEqual([]);
    expect(log).toHaveLength(4);
  });

  it("ignores in-flight temp files", () => {
    const w = world();
    writeFileSync(join(w.state, "requests", `.${RUN}.json.1.tmp`), "{}");
    expect(core.scanRequests({ stateDir: w.state, folders: [w.project], now: NOW })).toEqual([]);
    expect(readdirSync(join(w.state, "requests"))).toHaveLength(1);
  });
});

describe("terminalOptions", () => {
  it("runs only the fixed helper with argv, never a shell string", () => {
    const w = world();
    const v = core.validateRequest(w.request(), { stateDir: w.state, now: NOW });
    if (!v.ok) throw new Error(v.reason);
    expect(core.terminalOptions(v.request, "/h/.local/bin/codex-bridge")).toEqual({
      name: "Codex · review · 120000",
      shellPath: "/h/.local/bin/codex-bridge",
      shellArgs: ["follow", RUN],
      cwd: w.project,
      isTransient: true,
    });
  });
});

describe("heartbeats and claimed requests", () => {
  it("windowCovers sees only fresh heartbeats for the project", () => {
    const w = world();
    expect(core.windowCovers(w.state, w.project, NOW)).toBe(false);
    core.writeHeartbeat(w.state, "1", [w.project], NOW);
    expect(core.windowCovers(w.state, w.project, NOW + 1000)).toBe(true);
    expect(core.windowCovers(w.state, w.project, NOW + core.HEARTBEAT_FRESH_MS + 1)).toBe(false);
    core.removeHeartbeat(w.state, "1");
    expect(core.windowCovers(w.state, w.project, NOW)).toBe(false);
  });

  it("writeRequest never overwrites an existing request", () => {
    const w = world();
    expect(core.writeRequest(w.state, w.request())).toBe(join(w.state, "requests", `${RUN}.json`));
    expect(core.writeRequest(w.state, w.request())).toBeNull();
  });

  it("readClaimed re-validates without the TTL and rejects bad run ids", () => {
    const w = world();
    w.queue();
    core.scanRequests({ stateDir: w.state, folders: [w.project], now: NOW });
    expect(core.readClaimed(w.state, RUN).ok).toBe(true);
    expect(core.readClaimed(w.state, "../x").ok).toBe(false);
    expect(core.readClaimed(w.state, "20260930T120000009Z").ok).toBe(false);
  });

  it("pruneClaimed removes claimed requests older than a day", () => {
    const w = world();
    w.queue();
    core.scanRequests({ stateDir: w.state, folders: [w.project], now: NOW });
    core.pruneClaimed(w.state, Date.now());
    expect(readdirSync(join(w.state, "claimed"))).toHaveLength(1);
    core.pruneClaimed(w.state, Date.now() + 25 * 60 * 60 * 1000);
    expect(readdirSync(join(w.state, "claimed"))).toHaveLength(0);
  });
});
