// scripts/codex/antigravity-extension/bridge-core.js — the codex-bridge request
// protocol the Antigravity extension runs on. Pure functions over a temp state
// dir; the vscode glue (extension.js) stays a thin shell around these.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadBridgeCore } from "./codex-bridge-core.js";
import { REPO_ROOT } from "./gate-repo.js";

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

  describe("path containment (bridge review F-03)", () => {
    const verdict = (w: ReturnType<typeof agentWorld>, over: Record<string, unknown>) =>
      core.validateRequest(w.request(over), { stateDir: w.state, now: AGENT_NOW });

    it("refuses a cwd outside the project root and accepts one inside it", () => {
      const w = agentWorld();
      const outside = tmp("ccc-bridge-outside-");
      expect(verdict(w, { cwd: outside }).ok).toBe(false);
      expect(verdict(w, { cwd: "/" }).ok).toBe(false);
      const inner = join(w.project, "sub");
      mkdirSync(inner);
      expect(verdict(w, { cwd: inner }).ok).toBe(true);
      const link = join(w.project, "escape");
      symlinkSync(outside, link);
      expect(verdict(w, { cwd: link }).ok).toBe(false);
    });

    it.each([
      ["codex", "-C"],
      ["codex", "--cd"],
      ["codex", "--add-dir"],
      ["claude", "--add-dir"],
    ] as const)("%s %s must stay inside the project root", (agent, flag) => {
      const w = agentWorld(agent);
      const outside = tmp("ccc-bridge-outside-");
      const inner = join(w.project, "sub");
      mkdirSync(inner);
      const link = join(w.project, "escape");
      symlinkSync(outside, link);
      const argv = (...rest: string[]) => [w.exe, ...rest];
      expect(verdict(w, { argv: argv(flag, inner) }).ok).toBe(true);
      expect(verdict(w, { argv: argv(flag, "sub") }).ok).toBe(true);
      expect(verdict(w, { argv: argv(flag, outside) }).ok).toBe(false);
      expect(verdict(w, { argv: argv(flag, "/") }).ok).toBe(false);
      expect(verdict(w, { argv: argv(flag, "..") }).ok).toBe(false);
      expect(verdict(w, { argv: argv(flag, "../..") }).ok).toBe(false);
      expect(verdict(w, { argv: argv(flag, link) }).ok).toBe(false);
      expect(verdict(w, { argv: argv(`${flag}=${outside}`) }).ok).toBe(false);
      expect(verdict(w, { argv: argv(flag) }).ok).toBe(false);
      if (agent === "claude") {
        expect(verdict(w, { argv: argv(flag, inner, outside) }).ok).toBe(false);
        expect(verdict(w, { argv: argv(flag, inner, "sub") }).ok).toBe(true);
      }
      if (flag === "-C") expect(verdict(w, { argv: argv(`-C${outside}`) }).ok).toBe(false);
    });

    // Review finding: Codex resolves --add-dir against the --cd/-C directory, not the request cwd.
    describe("codex --add-dir resolves against the effective --cd directory", () => {
      it.each(["--cd", "-C"])("%s sub --add-dir shared checks <project>/sub/shared", (cdFlag) => {
        const w = agentWorld("codex");
        const outside = tmp("ccc-bridge-outside-");
        const sub = join(w.project, "sub");
        mkdirSync(sub);
        const argv = (...rest: string[]) => [w.exe, ...rest];
        // legitimate: <project>/sub/src exists, <project>/src does not
        mkdirSync(join(sub, "src"));
        expect(verdict(w, { argv: argv(cdFlag, "sub", "--add-dir", "src") }).ok).toBe(true);
        // --add-dir before --cd resolves the same way (Codex parses all flags first)
        expect(verdict(w, { argv: argv("--add-dir", "src", cdFlag, "sub") }).ok).toBe(true);
        // a sibling that exists only at the request cwd is NOT what Codex will use
        mkdirSync(join(w.project, "rootonly"));
        expect(verdict(w, { argv: argv(cdFlag, "sub", "--add-dir", "rootonly") }).ok).toBe(false);
        // symlink under the --cd directory escaping the project root
        symlinkSync(outside, join(sub, "shared"));
        expect(verdict(w, { argv: argv(cdFlag, "sub", "--add-dir", "shared") }).ok).toBe(false);
        expect(verdict(w, { argv: argv("--add-dir", "shared", cdFlag, "sub") }).ok).toBe(false);
        // dot-dot out of the --cd directory but still inside the root is fine, out of root is not
        expect(verdict(w, { argv: argv(cdFlag, "sub", "--add-dir", "..") }).ok).toBe(true);
        expect(verdict(w, { argv: argv(cdFlag, "sub", "--add-dir", "../..") }).ok).toBe(false);
      });

      it("the last --cd wins and a relative --cd is relative to the request cwd", () => {
        const w = agentWorld("codex");
        mkdirSync(join(w.project, "a", "x"), { recursive: true });
        mkdirSync(join(w.project, "b", "y"), { recursive: true });
        const argv = (...rest: string[]) => [w.exe, ...rest];
        expect(verdict(w, { argv: argv("--cd", "a", "--cd", "b", "--add-dir", "y") }).ok).toBe(
          true,
        );
        expect(verdict(w, { argv: argv("--cd", "a", "--cd", "b", "--add-dir", "x") }).ok).toBe(
          false,
        );
      });
    });
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

  it("flag allowlist: every flag-allowlist corpus case is refused by BOTH validateAgentShape and validateRequest (review: --exec=...)", () => {
    const corpus = JSON.parse(
      readFileSync(join(REPO_ROOT, "scripts", "codex", "hostile-corpus.json"), "utf8"),
    ) as {
      cases: Array<{ id: string; category: string; agent: "claude" | "codex"; argv: string[] }>;
    };
    const cases = corpus.cases.filter((c) => c.category === "flag-allowlist");
    expect(cases.length).toBeGreaterThanOrEqual(30);
    for (const c of cases) {
      const w = agentWorld(c.agent);
      const argv = [w.exe, ...c.argv.slice(1)];
      const shape = core.validateAgentShape({ agent: c.agent, argv, env: {} });
      expect(shape.ok, `${c.id} shape`).toBe(false);
      const full = core.validateRequest(w.request({ argv }), { stateDir: w.state, now: AGENT_NOW });
      expect(full.ok, `${c.id} request`).toBe(false);
    }
  });

  it("existing-launch-path flags: the --version, --worktree and --fork-session corpus cases get their verdict and reason from BOTH validateAgentShape and validateRequest", () => {
    const corpus = JSON.parse(
      readFileSync(join(REPO_ROOT, "scripts", "codex", "hostile-corpus.json"), "utf8"),
    ) as {
      cases: Array<{
        id: string;
        agent: "claude" | "codex";
        argv: string[];
        expect: "accept" | "reject";
        reason?: string;
      }>;
    };
    const cases = corpus.cases.filter((c) => /version|worktree|fork-session/.test(c.id));
    expect(cases.filter((c) => c.expect === "accept").length).toBeGreaterThanOrEqual(6);
    expect(cases.filter((c) => c.expect === "reject").length).toBeGreaterThanOrEqual(25);
    for (const c of cases) {
      const w = agentWorld(c.agent);
      const argv = [w.exe, ...c.argv.slice(1)];
      const shape = core.validateAgentShape({ agent: c.agent, argv, env: {} });
      const full = core.validateRequest(w.request({ argv }), { stateDir: w.state, now: AGENT_NOW });
      expect(shape.ok, `${c.id} shape`).toBe(c.expect === "accept");
      expect(full.ok, `${c.id} request`).toBe(c.expect === "accept");
      if (c.expect === "reject" && !shape.ok) expect(shape.reason, `${c.id} reason`).toBe(c.reason);
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

describe("heartbeat protocol advertisement", () => {
  it("writes protocol 2 and the capabilities beside folders and updatedAt", () => {
    const w = world();
    core.writeHeartbeat(w.state, "7", [w.project], NOW);
    const hb = JSON.parse(readFileSync(join(w.state, "windows", "7.json"), "utf8"));
    expect(hb).toEqual({
      folders: [w.project],
      updatedAt: new Date(NOW).toISOString(),
      protocol: 2,
      capabilities: ["follow", "tui", "agent"],
    });
  });

  it("reads a heartbeat of the old shape as protocol null and capabilities null", () => {
    const w = world();
    writeFileSync(
      join(w.state, "windows", "old.json"),
      JSON.stringify({ folders: [w.project], updatedAt: new Date(NOW).toISOString() }),
    );
    expect(core.coveringHeartbeat(w.state, w.project, NOW + 1000)).toEqual({
      folders: [w.project],
      updatedAt: new Date(NOW).toISOString(),
      protocol: null,
      capabilities: null,
    });
    expect(core.windowCovers(w.state, w.project, NOW + 1000)).toBe(true);
  });

  it("returns the fresh covering heartbeat with protocol and capabilities, or null", () => {
    const w = world();
    expect(core.coveringHeartbeat(w.state, w.project, NOW)).toBeNull();
    core.writeHeartbeat(w.state, "1", [w.project], NOW);
    const hb = core.coveringHeartbeat(w.state, w.project, NOW + 1000);
    expect(hb).toMatchObject({ protocol: 2, capabilities: ["follow", "tui", "agent"] });
    expect(
      core.coveringHeartbeat(w.state, w.project, NOW + core.HEARTBEAT_FRESH_MS + 1),
    ).toBeNull();
    expect(core.coveringHeartbeat(w.state, tmp("ccc-other-"), NOW + 1000)).toBeNull();
  });

  it("windowCovers answers exactly as before for the same inputs", () => {
    const w = world();
    const other = tmp("ccc-other-");
    writeFileSync(join(w.state, "windows", ".hidden.json"), "{}");
    writeFileSync(join(w.state, "windows", "junk.json"), "{not json");
    writeFileSync(join(w.state, "windows", "note.txt"), "x");
    writeFileSync(join(w.state, "windows", "nofolders.json"), JSON.stringify({ updatedAt: "x" }));
    core.writeHeartbeat(w.state, "1", [w.project], NOW);
    for (const root of [w.project, other]) {
      expect(core.windowCovers(w.state, root, NOW + 1000)).toBe(
        core.coveringHeartbeat(w.state, root, NOW + 1000) !== null,
      );
    }
    expect(core.windowCovers(w.state, w.project, NOW + 1000)).toBe(true);
    expect(core.windowCovers(w.state, other, NOW + 1000)).toBe(false);
  });

  it("coveringHeartbeats lists every fresh covering window so an outdated one is not hidden", () => {
    const w = world();
    writeFileSync(
      join(w.state, "windows", "a-old.json"),
      JSON.stringify({ folders: [w.project], updatedAt: new Date(NOW).toISOString() }),
    );
    core.writeHeartbeat(w.state, "b-new", [w.project], NOW);
    const all = core.coveringHeartbeats(w.state, w.project, NOW + 1000);
    expect(all.map((h) => h.protocol)).toEqual([null, 2]);
  });
});

describe("protocol marker", () => {
  it("writes protocol.json atomically with mode 0600 and reads it back", () => {
    const w = world();
    core.writeProtocolMarker(w.state, "abc123def456");
    const file = join(w.state, "protocol.json");
    expect(core.PROTOCOL_MARKER_FILE).toBe("protocol.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      protocol: 2,
      capabilities: ["follow", "tui", "agent"],
      kit: "abc123def456",
    });
    expect(core.readProtocolMarker(w.state)).toEqual({
      protocol: 2,
      capabilities: ["follow", "tui", "agent"],
      kit: "abc123def456",
    });
    expect(readdirSync(w.state).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("reads null for a missing or malformed marker", () => {
    const w = world();
    expect(core.readProtocolMarker(w.state)).toBeNull();
    const file = join(w.state, "protocol.json");
    for (const bad of [
      "{not json",
      "[]",
      JSON.stringify({ protocol: "2", capabilities: [], kit: "x" }),
      JSON.stringify({ protocol: 2, capabilities: "agent", kit: "x" }),
      JSON.stringify({ protocol: 2, capabilities: [1], kit: "x" }),
      JSON.stringify({ protocol: 2, capabilities: [], kit: 5 }),
      JSON.stringify({ protocol: 2, capabilities: [] }),
    ]) {
      writeFileSync(file, bad);
      expect(core.readProtocolMarker(w.state), bad).toBeNull();
    }
  });
});

describe("projectStateCandidates", () => {
  const sha10 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 10);

  it("lists the in-repo directory and the user-level project directory, in that order", () => {
    const main = "/Users/USERNAME/code/my-app";
    expect(core.projectStateCandidates(main, "/s/codex-bridge")).toEqual([
      "/Users/USERNAME/code/my-app/.planning/codex",
      `/s/codex-bridge/projects/my-app-${sha10(main)}`,
    ]);
  });

  it("replaces unsafe characters with an underscore, cuts to 40 characters, and falls back to project", () => {
    expect(core.projectDirName("/a/My Project!")).toBe(`My_Project_-${sha10("/a/My Project!")}`);
    const long = `/a/${"x".repeat(60)}`;
    expect(core.projectDirName(long)).toBe(`${"x".repeat(40)}-${sha10(long)}`);
    expect(core.projectDirName("/")).toBe(`project-${sha10("/")}`);
    expect(core.projectDirName("/a/ünï.v1_2-3")).toBe(`_n_.v1_2-3-${sha10("/a/ünï.v1_2-3")}`);
  });

  it("STATE_PROBES lists the ten probe paths every wrapper run may write", () => {
    expect(core.STATE_PROBES).toEqual(
      [
        "reports/x-review.json",
        "reports/x-review.md",
        "reports/x-task.json",
        "sessions/x.json",
        "live/x-task.log",
        "live/x-task.jsonl",
        "live/current.log",
        "live/.current.1.tmp",
        "pending-resume.json",
        "x.json.1.tmp",
      ].map((p) => `.planning/codex/${p}`),
    );
  });

  it("is the wrapper's only definition: the wrapper keeps no copy of the probes or of the name and hash expressions (plan 05.1-10)", () => {
    const source = readFileSync(join(REPO_ROOT, "scripts", "codex", "codex.mjs"), "utf8");
    expect(source).not.toMatch(/const STATE_PROBES = \[/);
    expect(source).not.toContain('.replace(/[^A-Za-z0-9._-]/g, "_")');
    expect(source).not.toContain('createHash("sha256")');
    expect(source).toContain("bridge.projectStateCandidates(main, BRIDGE_STATE)");
  });
});
