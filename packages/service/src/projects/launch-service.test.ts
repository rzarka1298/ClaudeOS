import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  LaunchGuard,
  LaunchGuardInput,
  LaunchResult,
  ProjectGitState,
  ProjectId,
  ProjectLookup,
  TerminalLauncher,
  TerminalLaunchInput,
} from "@ccc/domain";
import { newRunId } from "@ccc/domain";
import {
  applyMigrations,
  getProject,
  insertProject,
  type OperationalStore,
  openStore,
  saveLauncherConfig,
  setGithubUrlOverride,
} from "@ccc/operational-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSpawner, type FakeSpawner } from "../test-support/fake-spawner.js";
import {
  ALLOW_ALL_GUARD,
  createLaunchService,
  type LaunchCollector,
  type LaunchLogFields,
  type LaunchServiceDeps,
} from "./launch-service.js";
import { createStoreProjectLookup } from "./project-lookup.js";
import { ensureScriptDir } from "./script-dir.js";

let base: string;
let store: OperationalStore;
let projectDir: string;
let projectId: ProjectId;
let spawner: FakeSpawner;
let logged: LaunchLogFields[];
let refreshCalls: ProjectId[];
let registryChanges: number;
let gitStates: Map<ProjectId, ProjectGitState>;

function collector(overrides: Partial<LaunchCollector> = {}): LaunchCollector {
  return {
    refresh(id) {
      refreshCalls.push(id);
    },
    onRegistryChanged() {
      registryChanges += 1;
    },
    gitState: (id) => gitStates.get(id) ?? null,
    ...overrides,
  };
}

function service(overrides: Partial<LaunchServiceDeps> = {}) {
  return createLaunchService({
    store,
    spawner,
    lookup: createStoreProjectLookup(store),
    collector: collector(),
    logger: {
      info(fields) {
        logged.push(fields);
      },
      warn(fields) {
        logged.push(fields);
      },
    },
    ...overrides,
  });
}

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "ccc-launch-svc-")));
  store = openStore(join(base, "operational.db"));
  applyMigrations(store.db);
  projectDir = join(base, "example-project");
  mkdirSync(projectDir);
  projectId = insertProject(store.db, { path: projectDir, displayName: "Example" }).record
    .projectId;
  spawner = createFakeSpawner();
  logged = [];
  refreshCalls = [];
  registryChanges = 0;
  gitStates = new Map();
});

afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

describe("the launch guard (D-49)", () => {
  it("the default guard allows every launch", async () => {
    await expect(ALLOW_ALL_GUARD.check({ projectId, action: "finder" })).resolves.toEqual({
      ok: true,
    });
    await expect(service().launch({ projectId, action: "finder" })).resolves.toEqual({ ok: true });
    expect(spawner.calls).toHaveLength(1);
  });

  it("a refusing guard short-circuits with its kind and nothing is spawned", async () => {
    const seen: LaunchGuardInput[] = [];
    const guard: LaunchGuard = {
      check(input) {
        seen.push(input);
        return Promise.resolve({ ok: false, error: "spawn-failed" });
      },
    };
    await expect(service({ guard }).launch({ projectId, action: "finder" })).resolves.toEqual({
      ok: false,
      error: "spawn-failed",
    });
    expect(seen).toEqual([{ projectId, action: "finder" }]);
    expect(spawner.calls).toHaveLength(0);
    expect(getProject(store.db, projectId)?.lastOpenedAt).toBeNull();
  });
});

describe("a guard conflict is an answer, not a failure (05-17)", () => {
  it("logs at info with a conflict message, never warn 'launch failed'", async () => {
    const calls: Array<{ level: string; msg: string; kind: string }> = [];
    const guard: LaunchGuard = {
      check: () =>
        Promise.resolve({ ok: false, conflict: { projectName: "Example", conflicts: [] } }),
    };
    const logger = {
      info: (f: LaunchLogFields, msg: string) => calls.push({ level: "info", msg, kind: f.kind }),
      warn: (f: LaunchLogFields, msg: string) => calls.push({ level: "warn", msg, kind: f.kind }),
    };
    saveLauncherConfig(store.db, "claude-code", {
      executablePath: "/usr/bin/true",
      args: [],
      terminal: { kind: "terminal-app" },
    });
    await service({ guard, logger, scriptDir: ensureScriptDir(join(base, "runtime")) }).launch({
      projectId,
      action: "claude-code",
    });
    expect(calls).toEqual([{ level: "info", msg: "launch conflict", kind: "conflict" }]);
  });
});

describe("an uncertain terminal hand-off stays non-terminal (Codex 05-codex-1)", () => {
  async function settledAs(result: LaunchResult): Promise<string[]> {
    const outcomes: string[] = [];
    const guard: LaunchGuard = {
      check: () => Promise.resolve({ ok: true, runId: newRunId() }),
      settle: (_runId, outcome) => {
        outcomes.push(outcome);
        return Promise.resolve();
      },
    };
    saveLauncherConfig(store.db, "claude-code", {
      executablePath: "/usr/bin/true",
      args: [],
      terminal: { kind: "terminal-app" },
    });
    const launcher: TerminalLauncher = { launch: () => Promise.resolve(result) };
    await service({ guard, terminalLauncher: launcher }).launch({
      projectId,
      action: "claude-code",
    });
    return outcomes;
  }

  it("settles an unclassified spawn failure as stale, never failed", async () => {
    expect(await settledAs({ ok: false, error: "spawn-failed" })).toEqual(["timeout"]);
  });

  it("still settles a definite refusal as failed", async () => {
    expect(await settledAs({ ok: false, error: "automation-denied" })).toEqual(["failed"]);
  });
});

describe("after a successful launch (D-42, D-11)", () => {
  it("touches last_opened_at, tells the collector, and queues a refresh", async () => {
    await expect(service().launch({ projectId, action: "finder" })).resolves.toEqual({ ok: true });
    expect(getProject(store.db, projectId)?.lastOpenedAt).not.toBeNull();
    expect(registryChanges).toBe(1);
    expect(refreshCalls).toEqual([projectId]);
  });

  it("never waits on the refresh: a refresh that never resolves does not delay the result", async () => {
    const neverResolves = collector({ refresh: () => new Promise<never>(() => {}) });
    const started = performance.now();
    const result = await service({ collector: neverResolves }).launch({
      projectId,
      action: "finder",
    });
    expect(result).toEqual({ ok: true });
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("a failed spawn touches nothing and queues no refresh", async () => {
    spawner.mode = { kind: "fail", outcome: { exitCode: 1 } };
    const result = await service().launch({ projectId, action: "finder" });
    expect(result.ok).toBe(false);
    expect(getProject(store.db, projectId)?.lastOpenedAt).toBeNull();
    expect(refreshCalls).toEqual([]);
  });
});

describe("project resolution goes through the lookup (D-06)", () => {
  it("a lookup failure is returned as the launch error, with no spawn", async () => {
    const lookup: ProjectLookup = { resolve: () => Promise.resolve({ error: "project-moved" }) };
    await expect(service({ lookup }).launch({ projectId, action: "finder" })).resolves.toEqual({
      ok: false,
      error: "project-moved",
    });
    expect(spawner.calls).toHaveLength(0);
  });

  it("a lookup stalled on the filesystem is cut off by the cap as timeout, spawning nothing", async () => {
    const lookup: ProjectLookup = { resolve: () => new Promise<never>(() => {}) };
    const started = performance.now();
    await expect(
      service({ lookup, capMs: 50 }).launch({ projectId, action: "finder" }),
    ).resolves.toEqual({ ok: false, error: "timeout" });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(spawner.calls).toHaveLength(0);
  });

  it("uses no synchronous filesystem call on the launch path", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "launch-service.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/\b(access|stat|realpath|readFile|exists)Sync\b/);
  });

  it("logs only { projectId, action, kind }", async () => {
    await service().launch({ projectId, action: "finder" });
    expect(logged).toEqual([{ projectId, action: "finder", kind: "ok" }]);
  });
});

function repoWithRemote(host: string, path: string): ProjectGitState {
  return {
    kind: "repo",
    branch: "main",
    detached: false,
    dirty: false,
    commits: [],
    remote: { host, path },
  };
}

describe("Antigravity opens the project by bundle ID (PROJ-05, D-19)", () => {
  it("spawns open -b <configured bundle ID> <project path>", async () => {
    saveLauncherConfig(store.db, "antigravity", { bundleId: "com.google.antigravity" });
    await expect(service().launch({ projectId, action: "antigravity" })).resolves.toEqual({
      ok: true,
    });
    expect(spawner.calls.map((c) => c.argv)).toEqual([
      ["/usr/bin/open", "-b", "com.google.antigravity", projectDir],
    ]);
  });

  it("answers launcher-not-configured with no saved configuration, and spawns nothing", async () => {
    await expect(service().launch({ projectId, action: "antigravity" })).resolves.toEqual({
      ok: false,
      error: "launcher-not-configured",
    });
    expect(spawner.calls).toHaveLength(0);
  });

  it("reads a stored configuration that fails the domain schema as not configured", async () => {
    saveLauncherConfig(store.db, "antigravity", { bundleId: "not a bundle id; rm -rf" });
    await expect(service().launch({ projectId, action: "antigravity" })).resolves.toEqual({
      ok: false,
      error: "launcher-not-configured",
    });
    expect(spawner.calls).toHaveLength(0);
  });

  it("maps open(1)'s unknown-bundle failure to app-not-found", async () => {
    saveLauncherConfig(store.db, "antigravity", { bundleId: "com.google.antigravity" });
    spawner.mode = { kind: "fail", outcome: { exitCode: 1, stderrClass: "bundle-not-found" } };
    await expect(service().launch({ projectId, action: "antigravity" })).resolves.toEqual({
      ok: false,
      error: "app-not-found",
    });
  });
});

describe("Claude Desktop is brought forward by bundle ID, with no project (PROJ-09)", () => {
  it("spawns open -b <configured bundle ID> and never looks up a project", async () => {
    saveLauncherConfig(store.db, "claude-desktop", { bundleId: "com.anthropic.claudefordesktop" });
    const resolve = vi.fn();
    const result = await service({ lookup: { resolve } }).launch({ action: "claude-desktop" });
    expect(result).toEqual({ ok: true });
    expect(resolve).not.toHaveBeenCalled();
    expect(spawner.calls.map((c) => c.argv)).toEqual([
      ["/usr/bin/open", "-b", "com.anthropic.claudefordesktop"],
    ]);
    expect(refreshCalls).toEqual([]);
  });

  it("answers launcher-not-configured with no saved configuration", async () => {
    await expect(service().launch({ action: "claude-desktop" })).resolves.toEqual({
      ok: false,
      error: "launcher-not-configured",
    });
    expect(spawner.calls).toHaveLength(0);
  });
});

describe("GitHub opens a URL rebuilt from validated parts (PROJ-08, D-13)", () => {
  it("uses the owner's override", async () => {
    setGithubUrlOverride(store.db, projectId, "https://github.com/owner/repo");
    await expect(service().launch({ projectId, action: "github" })).resolves.toEqual({ ok: true });
    expect(spawner.calls.map((c) => c.argv)).toEqual([
      ["/usr/bin/open", "https://github.com/owner/repo"],
    ]);
  });

  it("falls back to the collector's last-good github.com remote", async () => {
    gitStates.set(projectId, repoWithRemote("github.com", "owner/repo"));
    await expect(service().launch({ projectId, action: "github" })).resolves.toEqual({ ok: true });
    expect(spawner.calls.map((c) => c.argv)).toEqual([
      ["/usr/bin/open", "https://github.com/owner/repo"],
    ]);
  });

  it("answers no-github-remote for a non-GitHub remote and no override, and spawns nothing", async () => {
    gitStates.set(projectId, repoWithRemote("gitlab.com", "owner/repo"));
    await expect(service().launch({ projectId, action: "github" })).resolves.toEqual({
      ok: false,
      error: "no-github-remote",
    });
    expect(spawner.calls).toHaveLength(0);
  });

  it("answers no-github-remote before git has been read", async () => {
    await expect(service().launch({ projectId, action: "github" })).resolves.toEqual({
      ok: false,
      error: "no-github-remote",
    });
  });

  it("answers project-missing for an unknown ProjectId", async () => {
    await expect(
      service().launch({ projectId: "0000000000123456789abcdef" as ProjectId, action: "github" }),
    ).resolves.toEqual({ ok: false, error: "project-missing" });
  });
});

describe("Claude Code waits for its terminal launcher (plan 04-09)", () => {
  it("answers launcher-not-configured while no terminal launcher is injected", async () => {
    saveLauncherConfig(store.db, "claude-code", {
      executablePath: "/usr/bin/true",
      args: [],
      terminal: { kind: "terminal-app" },
    });
    await expect(service().launch({ projectId, action: "claude-code" })).resolves.toEqual({
      ok: false,
      error: "launcher-not-configured",
    });
    expect(spawner.calls).toHaveLength(0);
  });
});

describe("Claude Code with an injected terminal launcher (the 04-09 seam)", () => {
  function terminalSpy(result: LaunchResult = { ok: true }) {
    const inputs: TerminalLaunchInput[] = [];
    const launcher: TerminalLauncher = {
      launch(input) {
        inputs.push(input);
        return Promise.resolve(result);
      },
    };
    return { inputs, launcher };
  }

  it("hands the rendered argv and the project folder to the terminal launcher", async () => {
    saveLauncherConfig(store.db, "claude-code", {
      executablePath: "/usr/bin/true",
      args: ["--add-dir", "{projectPath}"],
      terminal: { kind: "terminal-app" },
    });
    const { inputs, launcher } = terminalSpy();
    await expect(
      service({ terminalLauncher: launcher }).launch({ projectId, action: "claude-code" }),
    ).resolves.toEqual({ ok: true });
    expect(inputs).toEqual([
      {
        cwd: projectDir,
        argv: ["/usr/bin/true", "--add-dir", projectDir],
        signal: expect.any(AbortSignal),
      },
    ]);
    expect(inputs[0]?.signal.aborted).toBe(false);
    expect(spawner.calls).toHaveLength(0);
    expect(getProject(store.db, projectId)?.lastOpenedAt).not.toBeNull();
  });

  it("reads a stored template that fails validation as not configured, launching nothing", async () => {
    saveLauncherConfig(store.db, "claude-code", {
      executablePath: "/usr/bin/true",
      args: ["--permission-mode", "bypassPermissions"],
      terminal: { kind: "terminal-app" },
    });
    const { inputs, launcher } = terminalSpy();
    await expect(
      service({ terminalLauncher: launcher }).launch({ projectId, action: "claude-code" }),
    ).resolves.toEqual({ ok: false, error: "launcher-not-configured" });
    expect(inputs).toHaveLength(0);
  });

  it("a stored executable that is no longer executable is not configured either", async () => {
    saveLauncherConfig(store.db, "claude-code", {
      executablePath: join(base, "no-such-claude"),
      args: [],
      terminal: { kind: "terminal-app" },
    });
    const { inputs, launcher } = terminalSpy();
    await expect(
      service({ terminalLauncher: launcher }).launch({ projectId, action: "claude-code" }),
    ).resolves.toEqual({ ok: false, error: "launcher-not-configured" });
    expect(inputs).toHaveLength(0);
  });

  it("aborts the hand-off's signal when the cap fires, so it cannot open after timeout is reported", async () => {
    saveLauncherConfig(store.db, "claude-code", {
      executablePath: "/usr/bin/true",
      args: [],
      terminal: { kind: "terminal-app" },
    });
    const inputs: TerminalLaunchInput[] = [];
    const launcher: TerminalLauncher = {
      launch(input) {
        inputs.push(input);
        return new Promise<never>(() => {});
      },
    };
    await expect(
      service({ terminalLauncher: launcher, capMs: 50 }).launch({
        projectId,
        action: "claude-code",
      }),
    ).resolves.toEqual({ ok: false, error: "timeout" });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.signal.aborted).toBe(true);
  });

  it("passes the terminal launcher's own failure kind through", async () => {
    saveLauncherConfig(store.db, "claude-code", {
      executablePath: "/usr/bin/true",
      args: [],
      terminal: { kind: "terminal-app" },
    });
    const { launcher } = terminalSpy({ ok: false, error: "automation-denied" });
    await expect(
      service({ terminalLauncher: launcher }).launch({ projectId, action: "claude-code" }),
    ).resolves.toEqual({ ok: false, error: "automation-denied" });
    expect(getProject(store.db, projectId)?.lastOpenedAt).toBeNull();
  });
});

describe("Claude Code through the script directory and selectTerminalLauncher (plan 04-09)", () => {
  let scriptDir: string;

  beforeEach(() => {
    scriptDir = ensureScriptDir(join(base, "runtime"));
  });

  it("answers launcher-not-configured with no stored config, spawning nothing", async () => {
    await expect(
      service({ scriptDir }).launch({ projectId, action: "claude-code" }),
    ).resolves.toEqual({ ok: false, error: "launcher-not-configured" });
    expect(spawner.calls).toHaveLength(0);
    expect(readdirSync(scriptDir)).toEqual([]);
  });

  it("refuses a stored config carrying the forbidden flag, writing and spawning nothing (D-22)", async () => {
    saveLauncherConfig(store.db, "claude-code", {
      executablePath: "/usr/bin/true",
      args: ["--dangerously-skip-permissions"],
      terminal: { kind: "terminal-app" },
    });
    await expect(
      service({ scriptDir }).launch({ projectId, action: "claude-code" }),
    ).resolves.toEqual({ ok: false, error: "launcher-not-configured" });
    expect(spawner.calls).toHaveLength(0);
    expect(readdirSync(scriptDir)).toEqual([]);
  });

  it("hands Terminal a script from the directory and touches last_opened_at on success", async () => {
    saveLauncherConfig(store.db, "claude-code", {
      executablePath: "/usr/bin/true",
      args: ["{projectPath}"],
      terminal: { kind: "terminal-app" },
    });
    await expect(
      service({ scriptDir }).launch({ projectId, action: "claude-code" }),
    ).resolves.toEqual({ ok: true });
    expect(spawner.calls).toHaveLength(1);
    const argv = spawner.calls[0]?.argv ?? [];
    expect(argv.slice(0, 3)).toEqual(["/usr/bin/open", "-b", "com.apple.Terminal"]);
    expect(dirname(argv[3] ?? "")).toBe(scriptDir);
    const body = readFileSync(argv[3] ?? "", "utf8");
    expect(body).toContain(`'/usr/bin/true' '${projectDir}'`);
    expect(getProject(store.db, projectId)?.lastOpenedAt).not.toBeNull();
  });

  it("routes a stored custom terminal through the custom template adapter (D-23)", async () => {
    saveLauncherConfig(store.db, "claude-code", {
      executablePath: "/usr/bin/true",
      args: ["{projectPath}"],
      terminal: {
        kind: "custom",
        preset: "wezterm",
        argv: [
          "/usr/bin/open",
          "-na",
          "WezTerm",
          "--args",
          "start",
          "--cwd",
          "{projectPath}",
          "--",
          "{script}",
        ],
      },
    });
    await expect(
      service({ scriptDir }).launch({ projectId, action: "claude-code" }),
    ).resolves.toEqual({ ok: true });
    expect(spawner.calls).toHaveLength(1);
    const argv = spawner.calls[0]?.argv ?? [];
    expect(argv.slice(0, 7)).toEqual([
      "/usr/bin/open",
      "-na",
      "WezTerm",
      "--args",
      "start",
      "--cwd",
      projectDir,
    ]);
    expect(argv[7]).toBe("--");
    expect(dirname(argv[8] ?? "")).toBe(scriptDir);
    expect(readFileSync(argv[8] ?? "", "utf8")).toContain(`'/usr/bin/true' '${projectDir}'`);
    expect(getProject(store.db, projectId)?.lastOpenedAt).not.toBeNull();
  });

  it("a stored custom terminal carrying a bypass form launches nothing (D-22)", async () => {
    saveLauncherConfig(store.db, "claude-code", {
      executablePath: "/usr/bin/true",
      args: [],
      terminal: {
        kind: "custom",
        preset: "blank",
        argv: [
          "/usr/bin/open",
          "-na",
          "WezTerm",
          "--args",
          "--permission-mode=bypassPermissions",
          "{script}",
        ],
      },
    });
    await expect(
      service({ scriptDir }).launch({ projectId, action: "claude-code" }),
    ).resolves.toEqual({ ok: false, error: "launcher-not-configured" });
    expect(spawner.calls).toHaveLength(0);
    expect(readdirSync(scriptDir)).toEqual([]);
    expect(getProject(store.db, projectId)?.lastOpenedAt).toBeNull();
  });

  it("an explicitly injected terminal launcher still wins over the script directory", async () => {
    saveLauncherConfig(store.db, "claude-code", {
      executablePath: "/usr/bin/true",
      args: [],
      terminal: { kind: "terminal-app" },
    });
    const inputs: TerminalLaunchInput[] = [];
    const terminalLauncher: TerminalLauncher = {
      launch(input) {
        inputs.push(input);
        return Promise.resolve({ ok: true });
      },
    };
    await expect(
      service({ scriptDir, terminalLauncher }).launch({ projectId, action: "claude-code" }),
    ).resolves.toEqual({ ok: true });
    expect(inputs).toHaveLength(1);
    expect(spawner.calls).toHaveLength(0);
  });
});

describe("spawn outcomes map to D-26 kinds (PROJ-12)", () => {
  it("maps a timed-out spawn to timeout", async () => {
    spawner.mode = { kind: "fail", outcome: { exitCode: null, timedOut: true } };
    await expect(service().launch({ projectId, action: "finder" })).resolves.toEqual({
      ok: false,
      error: "timeout",
    });
  });

  it("maps open -R's missing-path failure to project-missing", async () => {
    spawner.mode = { kind: "fail", outcome: { exitCode: 1, stderrClass: "path-missing" } };
    await expect(service().launch({ projectId, action: "finder" })).resolves.toEqual({
      ok: false,
      error: "project-missing",
    });
  });

  it("maps a spawn errno to spawn-failed", async () => {
    spawner.mode = { kind: "fail", outcome: { exitCode: null, errno: "ENOENT" } };
    await expect(service().launch({ projectId, action: "finder" })).resolves.toEqual({
      ok: false,
      error: "spawn-failed",
    });
  });

  it("the logger only ever receives { projectId, action, kind }, and no value contains a slash (D-46)", async () => {
    saveLauncherConfig(store.db, "antigravity", { bundleId: "com.google.antigravity" });
    setGithubUrlOverride(store.db, projectId, "https://github.com/owner/repo");
    await service().launch({ projectId, action: "finder" });
    await service().launch({ projectId, action: "antigravity" });
    await service().launch({ projectId, action: "github" });
    spawner.mode = { kind: "fail", outcome: { exitCode: 1, stderrClass: "path-missing" } };
    await service().launch({ projectId, action: "finder" });
    await service().launch({ action: "claude-desktop" });
    expect(logged).toHaveLength(5);
    for (const fields of logged) {
      expect(Object.keys(fields).sort()).toEqual(["action", "kind", "projectId"]);
      for (const value of Object.values(fields)) {
        expect(String(value)).not.toContain("/");
      }
    }
    expect(logged.map((f) => f.kind)).toEqual([
      "ok",
      "ok",
      "ok",
      "project-missing",
      "launcher-not-configured",
    ]);
  });
});

describe("an identical launch already in flight is joined, not repeated (wave-3 review)", () => {
  it("a second identical request while one is in flight returns the same promise and spawns once", async () => {
    spawner.mode = { kind: "succeed", delayMs: 30 };
    const svc = service();
    const first = svc.launch({ projectId, action: "finder" });
    const second = svc.launch({ projectId, action: "finder" });
    expect(second).toBe(first);
    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(spawner.calls).toHaveLength(1);
    expect(refreshCalls).toEqual([projectId]);
  });

  it("a different action or project is not joined", async () => {
    spawner.mode = { kind: "succeed", delayMs: 30 };
    setGithubUrlOverride(store.db, projectId, "https://github.com/owner/repo");
    const svc = service();
    await Promise.all([
      svc.launch({ projectId, action: "finder" }),
      svc.launch({ projectId, action: "github" }),
    ]);
    expect(spawner.calls).toHaveLength(2);
  });

  it("once the first launch settles, the same request launches again", async () => {
    const svc = service();
    await svc.launch({ projectId, action: "finder" });
    await svc.launch({ projectId, action: "finder" });
    expect(spawner.calls).toHaveLength(2);
  });

  it("joins identical Claude Desktop requests, which carry no project", async () => {
    saveLauncherConfig(store.db, "claude-desktop", { bundleId: "com.anthropic.claudefordesktop" });
    spawner.mode = { kind: "succeed", delayMs: 30 };
    const svc = service();
    const first = svc.launch({ action: "claude-desktop" });
    expect(svc.launch({ action: "claude-desktop" })).toBe(first);
    await first;
    expect(spawner.calls).toHaveLength(1);
  });
});
