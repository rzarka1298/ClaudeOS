import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ProjectId } from "@ccc/domain";
import { openInApp } from "@ccc/launchers";
import {
  applyMigrations,
  insertProject,
  type OperationalStore,
  openStore,
  saveLauncherConfig,
} from "@ccc/operational-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BridgeFixture,
  createBridgeFixture,
  type WindowSimulator,
} from "../test-support/bridge-fixtures.js";
import { createFakeSpawner, type FakeSpawner } from "../test-support/fake-spawner.js";
import { ANTIGRAVITY_IDE_BUNDLE_ID } from "./antigravity-terminal.js";
import { createLaunchService, type LaunchServiceDeps } from "./launch-service.js";
import { createStoreProjectLookup } from "./project-lookup.js";
import { ensureScriptDir } from "./script-dir.js";
import type { Spawner } from "./spawner.js";

/**
 * The pair through the REAL Antigravity adapter over the window simulator and a temporary bridge
 * directory (plan 05.1-20, D-07, D-10, R-10, CODEX-02/03): the service, the adapter and the typed
 * bridge errors agree. The service builds its adapter deps from the process environment and the
 * home directory, so every test points HOME and XDG_STATE_HOME at the temporary fixture and never
 * reaches the owner's real bridge, Antigravity, `claude` or `codex`.
 */

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
  saveLauncherConfig(store.db, "claude-code", {
    executablePath: fx.claudePath,
    args: [],
    terminal: { kind: "antigravity-terminal" },
  });
  saveLauncherConfig(store.db, "codex", { executablePath: fx.codexPath, args: [] });
  sim = null;
  ticker = null;
});

afterEach(() => {
  if (ticker !== null) clearInterval(ticker);
  vi.unstubAllEnvs();
  store.close();
  fx.cleanup();
});

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

/** The claimed requests ordered by their run id (which is the order they were queued). */
function claimed(): Array<{ runId: string; agent: string; argv: string[] }> {
  return fx
    .claimedFiles()
    .sort()
    .map((name) => JSON.parse(readFileSync(join(fx.claimedDir, name), "utf8")));
}

describe("a warm window", () => {
  it("queues two requests with strictly increasing run ids, Claude first, both claimed, and answers both opened", async () => {
    openWindow(true);
    const result = await service().launchPair({ projectId });
    expect(result).toEqual({ claude: { status: "opened" }, codex: { status: "opened" } });
    const requests = claimed();
    expect(requests.map((r) => r.agent)).toEqual(["claude", "codex"]);
    const [first, second] = requests;
    expect((first?.runId ?? "") < (second?.runId ?? "")).toBe(true);
    expect(first?.argv).toEqual([fx.claudePath]);
    expect(second?.argv).toEqual([fx.codexPath]);
    expect(fx.requestFiles()).toEqual([]);
    // No terminal process was spawned and the IDE was not asked to open.
    expect(spawner.calls).toHaveLength(0);
  });

  it("keeps Claude first across repeated pairs (run ids come from the process-wide minter)", async () => {
    openWindow(true);
    const launcher = service();
    for (let round = 0; round < 5; round += 1) {
      await expect(launcher.launchPair({ projectId })).resolves.toEqual({
        claude: { status: "opened" },
        codex: { status: "opened" },
      });
    }
    const agents = claimed().map((r) => r.agent);
    expect(agents).toEqual(Array.from({ length: 5 }, () => ["claude", "codex"]).flat());
  });

  it("with the Codex row absent, Claude opens, Codex is setup and exactly one request was written", async () => {
    store.db.prepare("delete from launcher_config where launcher_id = 'codex'").run();
    openWindow(true);
    const result = await service().launchPair({ projectId });
    expect(result).toEqual({ claude: { status: "opened" }, codex: { status: "setup" } });
    expect(claimed().map((r) => r.agent)).toEqual(["claude"]);
  });

  it("refuses a Codex argv outside the per-agent allowlist as setup, with one request (Claude's) written", async () => {
    saveLauncherConfig(store.db, "codex", { executablePath: fx.codexPath, args: ["exec"] });
    openWindow(true);
    const result = await service().launchPair({ projectId });
    expect(result).toEqual({ claude: { status: "opened" }, codex: { status: "setup" } });
    expect(claimed().map((r) => r.agent)).toEqual(["claude"]);
  });

  it("the helper's pin file names the saved executable of each agent, written before the first request", async () => {
    openWindow(true);
    await service().launchPair({ projectId });
    const pins = JSON.parse(readFileSync(join(fx.stateDir, "agent-pins.json"), "utf8"));
    expect(pins).toEqual({ schemaVersion: 1, claude: fx.claudePath, codex: fx.codexPath });
  });
});

describe("the typed bridge errors reach both halves, never a bare timeout", () => {
  it("an outdated bridge answers bridge-outdated for both and queues nothing", async () => {
    const old = fx.simulator("outdated");
    old.heartbeat();
    const result = await service().launchPair({ projectId });
    expect(result).toEqual({
      claude: { status: "error", error: "bridge-outdated" },
      codex: { status: "error", error: "bridge-outdated" },
    });
    expect(fx.requestFiles()).toEqual([]);
    expect(fx.claimedFiles()).toEqual([]);
  });

  it("an absent bridge answers bridge-not-installed for both", async () => {
    rmSync(fx.launcherPath);
    const result = await service().launchPair({ projectId });
    expect(result).toEqual({
      claude: { status: "error", error: "bridge-not-installed" },
      codex: { status: "error", error: "bridge-not-installed" },
    });
    expect(fx.requestFiles()).toEqual([]);
  });
});

describe("a cold start", () => {
  it("opens the IDE on the project once for both halves, then both are claimed", async () => {
    const opener: Spawner = {
      run(argv, opts) {
        // The window appears as soon as the IDE has been asked to open.
        openWindow(true);
        return spawner.run(argv, opts);
      },
      detach: (argv, opts) => spawner.detach(argv, opts),
    };
    const result = await service({ spawner: opener }).launchPair({ projectId });
    expect(result).toEqual({ claude: { status: "opened" }, codex: { status: "opened" } });
    expect(spawner.calls).toHaveLength(1);
    expect(spawner.calls[0]?.argv).toEqual(openInApp(ANTIGRAVITY_IDE_BUNDLE_ID, fx.projectDir));
    expect(claimed().map((r) => r.agent)).toEqual(["claude", "codex"]);
  });

  it("with no window and none starting, both halves answer window-not-ready at the adapter deadline, both requests withdrawn, before the cap", async () => {
    const capMs = 900;
    const started = performance.now();
    const result = await service({ capMs }).launchPair({ projectId });
    const elapsed = performance.now() - started;
    expect(result).toEqual({
      claude: { status: "error", error: "window-not-ready" },
      codex: { status: "error", error: "window-not-ready" },
    });
    expect(elapsed).toBeLessThan(capMs);
    expect(fx.requestFiles()).toEqual([]);
    expect(fx.claimedFiles()).toEqual([]);
    expect(spawner.calls).toHaveLength(1);
    // A window that comes up late finds nothing to claim: no stray tab can open.
    const late = fx.simulator("current");
    expect(late.tick()).toEqual([]);
  });
});
