import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { LaunchResult, ProjectId } from "@ccc/domain";
import {
  applyMigrations,
  insertProject,
  type OperationalStore,
  openStore,
  saveLauncherConfig,
} from "@ccc/operational-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPhase4Bridge } from "../claude/phase4-bridge.js";
import {
  type BridgeFixture,
  createBridgeFixture,
  type WindowSimulator,
} from "../test-support/bridge-fixtures.js";
import { createFakeSpawner, type FakeSpawner } from "../test-support/fake-spawner.js";
import { ANTIGRAVITY_IDE_BUNDLE_ID, createAntigravityDeps } from "./antigravity-terminal.js";
import { createLaunchService, type LaunchServiceDeps } from "./launch-service.js";
import { testLaunch } from "./launcher-test-launch.js";
import { createStoreProjectLookup } from "./project-lookup.js";
import { ensureScriptDir } from "./script-dir.js";

/**
 * The three call sites (plan 05.1-13, D-07, D-12): Claude start (launch service), Phase 5 resume
 * and branch (the Phase 4 bridge) and the launcher Test step reach the Antigravity terminal
 * through the one `selectTerminalLauncher` port. Every test runs against a temporary HOME holding
 * a fake bridge and the plan 05.1-04 window simulator; the call sites build their own adapter deps
 * from `process.env` and the home directory, so the tests point those at the temporary HOME.
 */

const RESUME_SESSION = "0b8e6c1a-1d2f-4c3b-9a5e-7f6d5c4b3a21";

let fx: BridgeFixture;
let store: OperationalStore;
let spawner: FakeSpawner;
let projectId: ProjectId;
let scriptDir: string;
let sim: WindowSimulator | null;
let ticker: ReturnType<typeof setInterval> | null;

beforeEach(() => {
  fx = createBridgeFixture();
  fx.installLauncher();
  fx.installMarker();
  vi.stubEnv("HOME", fx.home);
  vi.stubEnv("XDG_STATE_HOME", "");
  store = openStore(join(fx.base, "operational.db"));
  applyMigrations(store.db);
  spawner = createFakeSpawner();
  const runtimeDir = join(fx.base, "rt");
  mkdirSync(runtimeDir, { mode: 0o700 });
  scriptDir = ensureScriptDir(runtimeDir);
  projectId = insertProject(store.db, { path: fx.projectDir, displayName: "Example" }).record
    .projectId;
  saveLauncherConfig(store.db, "antigravity", { bundleId: ANTIGRAVITY_IDE_BUNDLE_ID });
  sim = null;
  ticker = null;
});

afterEach(() => {
  if (ticker !== null) clearInterval(ticker);
  vi.unstubAllEnvs();
  store.close();
  fx.cleanup();
});

function saveClaudeCode(terminal: unknown): void {
  saveLauncherConfig(store.db, "claude-code", {
    executablePath: fx.claudePath,
    args: [],
    terminal,
  });
}

/** A current window on the project; `claiming` makes it poll like the extension does. */
function openWindow(claiming: boolean): void {
  sim = fx.simulator("current");
  sim.heartbeat();
  if (claiming) {
    const window = sim;
    ticker = setInterval(() => {
      try {
        window.tick();
      } catch {
        // The fixture was cleaned up while a tick was due.
      }
    }, 15);
  }
}

function service(overrides: Partial<LaunchServiceDeps> = {}) {
  return createLaunchService({
    store,
    spawner,
    lookup: createStoreProjectLookup(store),
    collector: { refresh() {}, onRegistryChanged() {}, gitState: () => null },
    logger: { info() {}, warn() {} },
    scriptDir,
    ...overrides,
  });
}

function claimedRequests(): Array<Record<string, unknown>> {
  return fx
    .claimedFiles()
    .map((name) => JSON.parse(readFileSync(join(fx.claimedDir, name), "utf8")));
}

describe("Claude Code start through the launch service", () => {
  it("reaches the Antigravity adapter: one agent request for claude, the adapter's result is the launch result", async () => {
    saveClaudeCode({ kind: "antigravity-terminal" });
    openWindow(true);
    await expect(service().launch({ action: "claude-code", projectId })).resolves.toEqual({
      ok: true,
    });
    const requests = claimedRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      kind: "agent",
      agent: "claude",
      argv: [fx.claudePath],
      projectRoot: fx.projectDir,
      cwd: fx.projectDir,
    });
    expect(spawner.calls).toHaveLength(0);
  });

  it("keeps the in-flight dedupe: a second identical launch joins the first (one request)", async () => {
    saveClaudeCode({ kind: "antigravity-terminal" });
    openWindow(true);
    const launcher = service();
    const [first, second] = await Promise.all([
      launcher.launch({ action: "claude-code", projectId }),
      launcher.launch({ action: "claude-code", projectId }),
    ]);
    expect(first).toEqual({ ok: true });
    expect(second).toBe(first);
    expect(claimedRequests()).toHaveLength(1);
  });

  it("keeps the concurrent-write guard: a conflict answers before any request exists", async () => {
    saveClaudeCode({ kind: "antigravity-terminal" });
    openWindow(true);
    const launcher = service({
      guard: {
        check: () =>
          Promise.resolve({ ok: false, conflict: { projectName: "Example", conflicts: [] } }),
      },
    });
    const result = await launcher.launch({ action: "claude-code", projectId });
    expect(result).toMatchObject({ ok: false, conflict: { projectName: "Example" } });
    expect(fx.requestFiles()).toEqual([]);
    expect(fx.claimedFiles()).toEqual([]);
  });

  it("keeps the cap: with a window that never claims, the adapter's own typed error wins and no request is left", async () => {
    saveClaudeCode({ kind: "antigravity-terminal" });
    openWindow(false);
    const result = await service({ capMs: 700 }).launch({ action: "claude-code", projectId });
    expect(result).toEqual({ ok: false, error: "window-not-ready" });
    expect(fx.requestFiles()).toEqual([]);
    expect(fx.claimedFiles()).toEqual([]);
  });

  it("answers bridge-not-installed from the adapter, not launcher-not-configured, when the launcher file is missing", async () => {
    saveClaudeCode({ kind: "antigravity-terminal" });
    rmSync(fx.launcherPath);
    const result = await service().launch({ action: "claude-code", projectId });
    expect(result).toEqual({ ok: false, error: "bridge-not-installed" });
  });

  it("a saved Terminal.app choice behaves exactly as before and never touches the bridge", async () => {
    saveClaudeCode({ kind: "terminal-app" });
    openWindow(true);
    await expect(service().launch({ action: "claude-code", projectId })).resolves.toEqual({
      ok: true,
    });
    expect(spawner.calls).toHaveLength(1);
    expect(spawner.calls[0]?.argv.slice(0, 3)).toEqual([
      "/usr/bin/open",
      "-b",
      "com.apple.Terminal",
    ]);
    expect(fx.requestFiles()).toEqual([]);
    expect(fx.claimedFiles()).toEqual([]);
  });
});

describe("Phase 5 resume and branch through the Phase 4 bridge", () => {
  function bridge(capMs?: number) {
    const unused = (): never => {
      throw new Error("not reached");
    };
    return createPhase4Bridge({
      store,
      spawner,
      scriptDir,
      lookup: {
        resolve: () => Promise.resolve({ path: fx.projectDir, displayName: "Example" }),
      } as never,
      guard: { check: unused, worktreeRootOf: unused } as never,
      listWorktrees: () => Promise.resolve([]),
      installedClaudeBin: () => null,
      pipeline: { apply: unused } as never,
      mintRunId: unused,
      now: () => new Date(),
      ...(capMs === undefined ? {} : { capMs }),
    });
  }

  const resumeRequest = () => ({
    cwd: fx.projectDir,
    argv: [fx.claudePath, "--resume", RESUME_SESSION],
    env: { CCC_RUN_ID: "run-resume-1", CCC_LAUNCH_SOURCE: "dashboard" },
  });

  it("opens a tab through the same adapter for the same stored configuration", async () => {
    saveClaudeCode({ kind: "antigravity-terminal" });
    openWindow(true);
    await expect(bridge().terminalLauncher.launch(resumeRequest())).resolves.toEqual({ ok: true });
    expect(claimedRequests()).toHaveLength(1);
    expect(claimedRequests()[0]).toMatchObject({
      agent: "claude",
      argv: [fx.claudePath, "--resume", RESUME_SESSION],
      env: { CCC_RUN_ID: "run-resume-1", CCC_LAUNCH_SOURCE: "dashboard" },
    });
  });

  it("maps the bridge's typed errors to spawn-failed, the Phase 5 launch-port vocabulary (it cannot carry them)", async () => {
    saveClaudeCode({ kind: "antigravity-terminal" });
    // bridge-outdated: the installed 0.1.0 extension covers the project.
    const old = fx.simulator("outdated");
    old.heartbeat();
    await expect(bridge().terminalLauncher.launch(resumeRequest())).resolves.toEqual({
      ok: false,
      reason: "spawn-failed",
    });
    expect(fx.requestFiles()).toEqual([]);
    old.close();
    // window-not-ready: a current window that never claims.
    openWindow(false);
    await expect(bridge(700).terminalLauncher.launch(resumeRequest())).resolves.toEqual({
      ok: false,
      reason: "spawn-failed",
    });
    expect(fx.requestFiles()).toEqual([]);
    // bridge-not-installed.
    rmSync(fx.launcherPath);
    await expect(bridge().terminalLauncher.launch(resumeRequest())).resolves.toEqual({
      ok: false,
      reason: "spawn-failed",
    });
  });

  it("a saved Terminal.app choice still goes to Terminal.app", async () => {
    saveClaudeCode({ kind: "terminal-app" });
    await expect(bridge().terminalLauncher.launch(resumeRequest())).resolves.toEqual({ ok: true });
    expect(spawner.calls[0]?.argv.slice(0, 3)).toEqual([
      "/usr/bin/open",
      "-b",
      "com.apple.Terminal",
    ]);
    expect(fx.requestFiles()).toEqual([]);
  });
});

describe("the launcher Test step", () => {
  const run = (): Promise<LaunchResult> =>
    testLaunch("claude-code", { store, spawner, scriptDir, homeDir: fx.projectDir, capMs: 700 });

  it("reaches the adapter with the saved claude and the version flag at the managed folder; the agent flag allowlist does not carry the version flag, so the adapter refuses and writes nothing", async () => {
    saveClaudeCode({ kind: "antigravity-terminal" });
    openWindow(true);
    // Not launcher-not-configured (which an absent adapter would give): the adapter itself ran and
    // its validator refused the argv. Carried forward to plan 05.1-21 (Test step for Codex).
    await expect(run()).resolves.toEqual({ ok: false, error: "spawn-failed" });
    expect(fx.requestFiles()).toEqual([]);
    expect(fx.claimedFiles()).toEqual([]);
    expect(spawner.calls).toHaveLength(0);
  });

  it("a saved Terminal.app choice runs the Test as before", async () => {
    saveClaudeCode({ kind: "terminal-app" });
    await expect(run()).resolves.toEqual({ ok: true });
    expect(spawner.calls[0]?.argv.slice(0, 3)).toEqual([
      "/usr/bin/open",
      "-b",
      "com.apple.Terminal",
    ]);
  });
});

describe("createAntigravityDeps", () => {
  it("builds the deps from the saved launcher rows on each call, the given environment and home", () => {
    const deps = createAntigravityDeps({ store, spawner, env: {}, home: fx.home });
    expect(deps.savedBundleId()).toBe(ANTIGRAVITY_IDE_BUNDLE_ID);
    expect(deps.savedExecutables()).toEqual({});
    saveClaudeCode({ kind: "antigravity-terminal" });
    saveLauncherConfig(store.db, "codex", { executablePath: fx.codexPath, args: [] });
    expect(deps.savedExecutables()).toEqual({ claude: fx.claudePath, codex: fx.codexPath });
    // A later save takes effect without rebuilding the deps.
    saveLauncherConfig(store.db, "antigravity", { bundleId: "com.google.antigravity" });
    expect(deps.savedBundleId()).toBe("com.google.antigravity");
    expect(deps.readStatus().dir).toBe(fx.stateDir);
    expect(deps.spawner).toBe(spawner);
  });

  it("reads no bundle when the row is missing or does not parse", () => {
    const empty = openStore(join(fx.base, "empty.db"));
    try {
      applyMigrations(empty.db);
      const deps = createAntigravityDeps({ store: empty, spawner, env: {}, home: fx.home });
      expect(deps.savedBundleId()).toBeNull();
      saveLauncherConfig(empty.db, "antigravity", { nonsense: true });
      expect(deps.savedBundleId()).toBeNull();
    } finally {
      empty.close();
    }
  });

  it("every call site gets the same strictly increasing minter, so two call sites cannot collide", () => {
    const a = createAntigravityDeps({ store, spawner });
    const b = createAntigravityDeps({ store, spawner });
    expect(a.mintRunId).toBe(b.mintRunId);
    const ids = [a.mintRunId(), b.mintRunId(), a.mintRunId(), b.mintRunId()];
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(4);
  });

  it("falls back to the process environment and home directory", () => {
    const deps = createAntigravityDeps({ store, spawner });
    expect(deps.readStatus().dir).toBe(fx.stateDir);
  });
});
