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

describe("tui mode requests", () => {
  function tuiWorld(): World & { promptFile: string } {
    const w = world();
    mkdirSync(join(w.state, "prompts"), { recursive: true });
    const promptFile = join(w.state, "prompts", `${RUN}.md`);
    writeFileSync(promptFile, `Review it.\n\ncodex-bridge run ${RUN}\n`);
    return { ...w, promptFile };
  }

  it("accepts a tui request with a role and a prompt file in the bridge state dir", () => {
    const w = tuiWorld();
    const v = core.validateRequest(
      w.request({ mode: "tui", role: "review", promptFile: w.promptFile }),
      { stateDir: w.state, now: NOW },
    );
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.request).toMatchObject({ mode: "tui", role: "review", promptFile: w.promptFile });
    expect(core.terminalOptions(v.request, "/h/.local/bin/codex-bridge").shellArgs).toEqual([
      "tui",
      RUN,
    ]);
  });

  it("defaults to follow mode", () => {
    const w = world();
    const v = core.validateRequest(w.request(), { stateDir: w.state, now: NOW });
    expect(v.ok && v.request.mode).toBe("follow");
  });

  it.each([
    ["an unknown mode", { mode: "shell" }],
    ["tui without a role", { mode: "tui", role: undefined }],
    ["tui with an unknown role", { mode: "tui", role: "danger" }],
    ["tui without a prompt file", { mode: "tui", role: "task", promptFile: null }],
    [
      "tui with a prompt file outside prompts/",
      { mode: "tui", role: "task", promptFile: "/etc/hosts" },
    ],
  ])("rejects %s", (_label, over) => {
    const w = tuiWorld();
    const v = core.validateRequest(w.request({ promptFile: w.promptFile, ...over }), {
      stateDir: w.state,
      now: NOW,
    });
    expect(v.ok).toBe(false);
  });
});

describe("codexHome", () => {
  it("carries an existing absolute Codex home and rejects anything else", () => {
    const w = world();
    const home = tmp("ccc-codex-home-");
    const ok = core.validateRequest(w.request({ codexHome: home }), {
      stateDir: w.state,
      now: NOW,
    });
    expect(ok.ok && ok.request.codexHome).toBe(home);
    for (const bad of ["relative", "/nonexistent/codex-home", 7]) {
      expect(
        core.validateRequest(w.request({ codexHome: bad }), { stateDir: w.state, now: NOW }).ok,
      ).toBe(false);
    }
  });
});

describe("agent mode requests (protocol 2)", () => {
  const AGENT_RUN = "20261006T120000123Z";
  const AGENT_NOW = Date.parse("2026-10-06T12:00:05.000Z");

  function agentWorld(agent: "claude" | "codex" = "claude") {
    const state = tmp("ccc-bridge-state-");
    const project = tmp("ccc-bridge-project-");
    const bin = tmp("ccc-bridge-bin-");
    core.ensureDirs(state);
    const exe = join(bin, agent);
    writeFileSync(exe, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const request = (over: Record<string, unknown> = {}) => ({
      runId: AGENT_RUN,
      kind: "agent",
      mode: "agent",
      agent,
      projectRoot: project,
      cwd: project,
      argv: [exe, "--permission-mode", "plan"],
      env: { CCC_RUN_ID: "x" },
      sessionId: null,
      liveLog: null,
      pid: null,
      createdAt: "2026-10-06T12:00:00.000Z",
      protocol: 2,
      ...over,
    });
    return { state, project, bin, exe, request };
  }

  it("tracer: writeRequest, a window claim, readClaimed and a shell-free terminal", () => {
    const w = agentWorld();
    const file = core.writeRequest(w.state, w.request());
    expect(file).toBe(join(w.state, "requests", `${AGENT_RUN}.json`));

    const claimed = core.scanRequests({
      stateDir: w.state,
      folders: [w.project],
      now: AGENT_NOW,
    });
    expect(claimed.map((r) => r.runId)).toEqual([AGENT_RUN]);
    expect(readdirSync(join(w.state, "requests"))).toEqual([]);

    const read = core.readClaimed(w.state, AGENT_RUN);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.request).toMatchObject({
      runId: AGENT_RUN,
      kind: "agent",
      mode: "agent",
      agent: "claude",
      projectRoot: w.project,
      cwd: w.project,
      argv: [w.exe, "--permission-mode", "plan"],
      env: { CCC_RUN_ID: "x" },
      protocol: 2,
    });
    expect(core.terminalOptions(read.request, "/h/.local/bin/codex-bridge")).toEqual({
      name: "Claude Code",
      shellPath: "/h/.local/bin/codex-bridge",
      shellArgs: ["agent", AGENT_RUN],
      cwd: w.project,
      isTransient: true,
    });
  });

  it("names a codex tab Codex and still passes only the two fixed arguments", () => {
    const w = agentWorld("codex");
    const v = core.validateRequest(w.request({ argv: [w.exe] }), {
      stateDir: w.state,
      now: AGENT_NOW,
    });
    if (!v.ok) throw new Error(v.reason);
    const t = core.terminalOptions(v.request, "/h/.local/bin/codex-bridge");
    expect(t.name).toBe("Codex");
    expect(t.shellArgs).toEqual(["agent", AGENT_RUN]);
    expect(Object.keys(t).sort()).toEqual(["cwd", "isTransient", "name", "shellArgs", "shellPath"]);
  });

  it("accepts an absent cwd (defaults to the project root) and an absent liveLog, sessionId and pid", () => {
    const w = agentWorld();
    const r = w.request();
    const { cwd: _c, liveLog: _l, sessionId: _s, pid: _p, ...bare } = r;
    const v = core.validateRequest(bare, { stateDir: w.state, now: AGENT_NOW });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.request.cwd).toBe(w.project);
  });

  it.each([
    ["an unknown extra top-level key", { extra: 1 }],
    ["a role key", { role: "review" }],
    ["a promptFile key", { promptFile: null }],
    ["a codexHome key", { codexHome: null }],
    ["a liveLog", { liveLog: "/tmp/x.log" }],
    ["a non-null sessionId", { sessionId: SESSION }],
    ["a non-null pid", { pid: 5 }],
    ["protocol 1", { protocol: 1 }],
    ["protocol 3", { protocol: 3 }],
    ["a string protocol", { protocol: "2" }],
    ["a missing protocol", { protocol: undefined }],
    ["kind agent with mode follow", { mode: "follow" }],
    ["kind agent with mode tui", { mode: "tui" }],
    ["kind agent with a missing mode", { mode: undefined }],
    ["mode agent with kind review", { kind: "review" }],
    ["mode agent with kind task", { kind: "task" }],
    ["a bad run id", { runId: "../../x" }],
    ["an unknown agent", { agent: "bash" }],
    ["a relative project root", { projectRoot: "relative" }],
    ["a missing cwd directory", { cwd: "/nonexistent/cwd" }],
    ["a createdAt in the future", { createdAt: "2026-10-06T13:00:00.000Z" }],
    ["a bad createdAt", { createdAt: "yesterday" }],
    ["a bypass flag", { argv: ["__EXE__", "--dangerously-skip-permissions"] }],
    ["a bad env key", { env: { PATH: "/usr/bin" } }],
    ["a control character in argv", { argv: ["__EXE__", "a\nb"] }],
    ["a relative argv0", { argv: ["claude"] }],
    ["an argv0 that does not exist", { argv: ["/nonexistent/dir/claude"] }],
  ])("refuses %s", (_label, over) => {
    const w = agentWorld();
    const patched = JSON.parse(JSON.stringify(over).replaceAll("__EXE__", w.exe));
    const request = { ...w.request(), ...patched };
    for (const k of Object.keys(over)) {
      if ((over as Record<string, unknown>)[k] === undefined) delete (request as never)[k];
    }
    const v = core.validateRequest(request, { stateDir: w.state, now: AGENT_NOW });
    expect(v.ok).toBe(false);
  });

  it("refuses an argv0 that is a directory or not executable", () => {
    const w = agentWorld();
    const plain = join(w.bin, "claude-plain");
    mkdirSync(join(w.bin, "d"));
    const dir = join(w.bin, "d", "claude");
    mkdirSync(dir);
    writeFileSync(plain, "x", { mode: 0o644 });
    for (const argv of [[dir], [plain]]) {
      expect(
        core.validateRequest(w.request({ argv }), { stateDir: w.state, now: AGENT_NOW }).ok,
      ).toBe(false);
    }
  });

  it("scanRequests discards a hostile agent request with a reason and leaves a good one", () => {
    const w = agentWorld();
    core.writeRequest(w.state, w.request({ argv: [w.exe, "--yolo"] }));
    const log: string[] = [];
    const got = core.scanRequests({
      stateDir: w.state,
      folders: [w.project],
      now: AGENT_NOW,
      log: (m) => log.push(m),
    });
    expect(got).toEqual([]);
    expect(readdirSync(join(w.state, "requests"))).toEqual([]);
    expect(log).toHaveLength(1);
    expect(log[0]).toContain("banned-flag");
    expect(log[0]).not.toContain("yolo");
  });

  it("leaves follow and tui behaviour alone: a follow request may still carry unknown keys", () => {
    const w = world();
    const v = core.validateRequest(w.request({ extra: "kept-ignored", protocol: 1 }), {
      stateDir: w.state,
      now: NOW,
    });
    expect(v.ok).toBe(true);
    expect(core.MODES).toEqual(["follow", "tui", "agent"]);
    expect(core.KINDS).toEqual(["review", "task", "resume", "agent"]);
  });
});

describe("protocol constants", () => {
  it("exports the values the TypeScript mirror is parity-tested against", () => {
    expect(core.PROTOCOL_VERSION).toBe(2);
    expect(core.CAPABILITIES).toEqual(["follow", "tui", "agent"]);
    expect(core.AGENTS).toEqual(["claude", "codex"]);
    expect(core.ROLES).toEqual(["review", "plan", "task", "chore"]);
    expect(core.FUTURE_SKEW_MS).toBe(60_000);
    expect(core.CONTAIN_DELAY_MS).toBe(2000);
    expect(core.CLAIMED_KEEP_MS).toBe(24 * 60 * 60 * 1000);
    expect(core.TTL_MS).toBe(10 * 60 * 1000);
    expect(core.HEARTBEAT_FRESH_MS).toBe(90 * 1000);
    expect(core.REQUEST_FILE_RE.test(`${RUN}.json`)).toBe(true);
    expect(core.REQUEST_FILE_RE.test(`.${RUN}.json`)).toBe(false);
    expect([
      core.AGENT_ARGV_MAX,
      core.AGENT_ELEMENT_MAX,
      core.AGENT_ENV_MAX,
      core.AGENT_ENV_VALUE_MAX,
    ]).toEqual([32, 4096, 16, 1024]);
    expect(core.AGENT_ENV_KEY_RE.test("CCC_RUN_ID")).toBe(true);
    expect(core.AGENT_ENV_KEY_RE.test("CCC_run")).toBe(false);
  });
});
