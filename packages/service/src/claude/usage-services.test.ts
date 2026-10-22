import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { newRunId } from "@ccc/domain";
import {
  applyMigrations,
  getCollectorSetting,
  listToggleLog,
  markDayCovered,
  type OperationalStore,
  openStore,
} from "@ccc/operational-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../events/event-bus.js";
import { createLogger } from "../logging.js";
import { createClaudePipeline, type SessionFactsProvider } from "./pipeline.js";
import {
  type AnalysisChange,
  startUsageServices,
  TRANSCRIPT_ANALYSIS_SETTING,
  type UsageServices,
  type UsageServicesDeps,
} from "./usage-services.js";

/**
 * Plan 05.1-28 (D-17, Pitfall 13): the three additive optional dependencies of the Phase 5 usage
 * services. Without them every Phase 5 behaviour is unchanged; with them the shared toggle and
 * the delete reach the Codex services, and a listener that throws never fails the Phase 5 call.
 */

const NULL_FACTS: SessionFactsProvider = {
  factsFor: async () => ({
    pidStartedAt: null,
    launchSource: null,
    projectId: null,
    worktreeRoot: null,
    transcriptPath: null,
  }),
};

let dir: string;
let store: OperationalStore;
let usage: UsageServices | undefined;

beforeEach(() => {
  mkdirSync(join(homedir(), ".ccc-test"), { recursive: true });
  dir = mkdtempSync(join(homedir(), ".ccc-test", "us-"));
  store = openStore(join(dir, "operational.db"));
  applyMigrations(store.db);
  usage = undefined;
});

afterEach(async () => {
  await usage?.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function start(extra: Partial<UsageServicesDeps> = {}): UsageServices {
  const bus = createEventBus();
  const logger = createLogger(join(dir, "logs", "service.log"));
  const pipeline = createClaudePipeline({
    db: store.db,
    bus,
    logger,
    now: () => new Date(),
    mintRunId: newRunId,
    facts: NULL_FACTS,
  });
  usage = startUsageServices({
    db: store.db,
    bus,
    pipeline,
    poller: { setStatusLineSink() {}, dropCount: () => 0 },
    logger,
    env: {},
    now: () => new Date(),
    runtimeDir: dir,
    claudeConfigDir: join(dir, "claude"),
    settingsFacts: () => ({ statusLine: "installed", cleanupPeriodDays: 30 }),
    ...extra,
  });
  return usage;
}

const coverageDays = (): number =>
  (store.db.prepare("SELECT COUNT(*) AS n FROM coverage_days").get() as { n: number }).n;

describe("the Phase 05.1 hooks of the usage services", () => {
  it("Phase 5 behaviour is unchanged with no listener: the toggle persists and logs, the delete empties the Claude tables", async () => {
    const services = start();
    await services.setTranscriptAnalysis(true);
    expect(getCollectorSetting(store.db, TRANSCRIPT_ANALYSIS_SETTING)).toBe("true");
    expect(listToggleLog(store.db).map((entry) => entry.enabled)).toEqual([true]);
    markDayCovered(store.db, "2026-10-01", new Date().toISOString());
    expect(coverageDays()).toBe(1);
    services.deleteUsage();
    await services.stop();
    expect(coverageDays()).toBe(0);
    expect(getCollectorSetting(store.db, TRANSCRIPT_ANALYSIS_SETTING)).toBe("true");
  });

  it("tells the listener after the toggle moves and after a delete, with what the toggle reads now", async () => {
    const changes: AnalysisChange[] = [];
    const services = start({ onAnalysisChanged: (change) => changes.push(change) });
    await services.setTranscriptAnalysis(true);
    await services.setTranscriptAnalysis(false);
    await services.setTranscriptAnalysis(true);
    services.deleteUsage();
    await services.stop();
    expect(changes).toEqual([
      { enabled: true, cause: "toggle" },
      { enabled: false, cause: "toggle" },
      { enabled: true, cause: "toggle" },
      { enabled: true, cause: "delete" },
    ]);
  });

  it("uses the injected delete function in place of the Phase 5 one", async () => {
    const seen: unknown[] = [];
    const services = start({ deleteAnalytics: (db) => seen.push(db) });
    markDayCovered(store.db, "2026-10-01", new Date().toISOString());
    services.deleteUsage();
    await services.stop();
    expect(seen).toEqual([store.db]);
    // The injected function replaced the default, so the Claude table was not touched here.
    expect(coverageDays()).toBe(1);
  });

  it("calls the integration-refresh listener after each refresh", async () => {
    let refreshes = 0;
    const services = start({ onIntegrationRefresh: () => (refreshes += 1) });
    await services.refreshIntegration();
    expect(refreshes).toBe(1);
  });

  it("a listener that throws never fails the Phase 5 toggle, delete or refresh", async () => {
    const services = start({
      onAnalysisChanged: () => {
        throw new Error("listener fault");
      },
      onIntegrationRefresh: () => {
        throw new Error("listener fault");
      },
    });
    await expect(services.setTranscriptAnalysis(true)).resolves.toEqual({ enabled: true });
    expect(() => services.deleteUsage()).not.toThrow();
    await expect(services.refreshIntegration()).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// refreshSettingsFacts (plan 08-04, research A 1.3): the health check's cheap
// re-read. Two bounded file reads, no `claude --version`; it publishes the
// integration status only when it changed.

describe("UsageServices.refreshSettingsFacts (plan 08-04)", () => {
  const FAKE_CLAUDE = "/opt/fake/claude";

  function writeSettings(value: unknown): void {
    mkdirSync(join(dir, "claude"), { recursive: true });
    writeFileSync(join(dir, "claude", "settings.json"), JSON.stringify(value));
  }

  function writeInstallRecord(value: unknown): void {
    mkdirSync(join(dir, "hooks"), { recursive: true });
    writeFileSync(join(dir, "hooks", "install.json"), JSON.stringify(value));
  }

  function fakeProber() {
    const execFile = vi.fn(async () => ({ stdout: "2.1.5 (Claude Code)\n" }));
    return {
      execFile,
      deps: {
        execFile,
        realpath: (path: string) => path,
        mtimeMs: () => 1,
        cache: new Map<string, string | null>(),
      },
    };
  }

  it("Test 1: sees an edited settings file at once and never starts the version prober", () => {
    writeSettings({});
    const prober = fakeProber();
    const services = start({ versionProbe: prober.deps });
    expect(services.integration().disableAllHooks).toBe(false);

    writeSettings({ disableAllHooks: true });
    // Without the refresh the cached facts still say false.
    expect(services.integration().disableAllHooks).toBe(false);

    const status = services.refreshSettingsFacts();
    expect(status.disableAllHooks).toBe(true);
    expect(services.integration().disableAllHooks).toBe(true);
    expect(prober.execFile).toHaveBeenCalledTimes(0);
  });

  it("Test 2: keeps the Claude version cached by the last background refresh", async () => {
    writeSettings({});
    writeInstallRecord({ claudeBin: FAKE_CLAUDE });
    const prober = fakeProber();
    const services = start({ versionProbe: prober.deps });
    const refreshed = await services.refreshIntegration();
    expect(refreshed.detectedClaudeVersion).toBe("2.1.5");
    expect(prober.execFile).toHaveBeenCalledTimes(1);

    writeSettings({ disableAllHooks: true });
    const status = services.refreshSettingsFacts();
    expect(status.disableAllHooks).toBe(true);
    expect(status.detectedClaudeVersion).toBe("2.1.5");
    expect(prober.execFile).toHaveBeenCalledTimes(1);
  });

  it("re-reads the hook install record too, so a drill that edits it is seen at once", () => {
    const handler = { command: "/nonexistent/node", args: [join(dir, "hooks", "handler.js")] };
    writeSettings({ hooks: { SessionStart: [{ hooks: [handler] }] } });
    const services = start({ versionProbe: fakeProber().deps });
    expect(services.integration().hooks).toBe("installed");
    expect(services.integration().hookRuntimeMissing).toBe(true);

    // The install record names a node that exists, and it wins over the settings command.
    const presentNode = join(dir, "present-node");
    writeFileSync(presentNode, "");
    writeInstallRecord({ nodePath: presentNode });
    expect(services.integration().hookRuntimeMissing).toBe(true);
    expect(services.refreshSettingsFacts().hookRuntimeMissing).toBe(false);
  });

  it("MINOR 5: publishes claude-integration.updated once when the facts changed (subscribers see the same state), and never calls the refresh listener", async () => {
    writeSettings({});
    const bus = createEventBus();
    const publish = vi.spyOn(bus, "publish");
    const onIntegrationRefresh = vi.fn();
    const services = start({ bus, onIntegrationRefresh, versionProbe: fakeProber().deps });
    const updates = () =>
      publish.mock.calls.filter((call) => call[0] === "claude-integration.updated").length;
    const before = updates();

    // Nothing changed: nothing is published.
    services.refreshSettingsFacts();
    expect(updates()).toBe(before);

    writeSettings({ disableAllHooks: true });
    const status = services.refreshSettingsFacts();
    expect(status.disableAllHooks).toBe(true);
    expect(updates()).toBe(before + 1);
    const last = publish.mock.calls
      .filter((call) => call[0] === "claude-integration.updated")
      .at(-1);
    expect(last?.[1]).toMatchObject({ disableAllHooks: true });
    expect(onIntegrationRefresh).not.toHaveBeenCalled();

    // The same state is not published twice: a repeat and the next background refresh stay quiet.
    services.refreshSettingsFacts();
    await services.refreshIntegration();
    expect(updates()).toBe(before + 1);
    expect(onIntegrationRefresh).toHaveBeenCalledTimes(1);
  });

  it("MINOR 5: a changed claudeBin clears the cached version at once (the old binary's version is not shown for the new one), with no probe", async () => {
    writeSettings({});
    writeInstallRecord({ claudeBin: FAKE_CLAUDE });
    const prober = fakeProber();
    const services = start({ versionProbe: prober.deps });
    expect((await services.refreshIntegration()).detectedClaudeVersion).toBe("2.1.5");

    // Same binary: the cached version stays.
    expect(services.refreshSettingsFacts().detectedClaudeVersion).toBe("2.1.5");

    writeInstallRecord({ claudeBin: "/opt/other/claude" });
    expect(services.refreshSettingsFacts().detectedClaudeVersion).toBeNull();
    expect(services.integration().detectedClaudeVersion).toBeNull();
    expect(prober.execFile).toHaveBeenCalledTimes(1);

    // The next background refresh probes the new binary.
    expect((await services.refreshIntegration()).detectedClaudeVersion).toBe("2.1.5");
    expect(prober.execFile).toHaveBeenCalledTimes(2);

    // Removing the record clears it too.
    rmSync(join(dir, "hooks", "install.json"));
    expect(services.refreshSettingsFacts().detectedClaudeVersion).toBeNull();
  });

  it("never throws on a missing or unreadable settings file; the status reads unknown", () => {
    const services = start({ versionProbe: fakeProber().deps });
    const status = services.refreshSettingsFacts();
    expect(status.hooks).toBe("unknown");
    expect(status.disableAllHooks).toBeNull();
  });
});
