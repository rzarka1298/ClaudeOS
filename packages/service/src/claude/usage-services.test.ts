import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
