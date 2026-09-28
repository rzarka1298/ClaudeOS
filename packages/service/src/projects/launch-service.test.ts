import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    const lookup: ProjectLookup = { resolve: () => ({ error: "project-moved" }) };
    await expect(service({ lookup }).launch({ projectId, action: "finder" })).resolves.toEqual({
      ok: false,
      error: "project-moved",
    });
    expect(spawner.calls).toHaveLength(0);
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
    expect(inputs).toEqual([{ cwd: projectDir, argv: ["/usr/bin/true", "--add-dir", projectDir] }]);
    expect(spawner.calls).toHaveLength(0);
    expect(getProject(store.db, projectId)?.lastOpenedAt).not.toBeNull();
  });

  it("refuses a stored template carrying a permission-bypass flag, launching nothing", async () => {
    saveLauncherConfig(store.db, "claude-code", {
      executablePath: "/usr/bin/true",
      args: ["--permission-mode", "bypassPermissions"],
      terminal: { kind: "terminal-app" },
    });
    const { inputs, launcher } = terminalSpy();
    await expect(
      service({ terminalLauncher: launcher }).launch({ projectId, action: "claude-code" }),
    ).resolves.toEqual({ ok: false, error: "spawn-failed" });
    expect(inputs).toHaveLength(0);
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
