import { join } from "node:path";
import { parseTranscriptChunk } from "@ccc/collectors";
import {
  type ClaudeIntegrationStatus,
  type IntegrationInstallState,
  type RunId,
  type SessionUsage,
  type StatusLineSnapshot,
  StatusLineSnapshotSchema,
  type UsageSummary,
} from "@ccc/domain";
import {
  appendToggleLog,
  deleteUsageAnalytics,
  getCollectorSetting,
  getSessionRun,
  latestCapacity,
  listCostSnapshots,
  setCollectorSetting,
  upsertCapacitySnapshot,
  upsertCostSnapshot,
} from "@ccc/operational-store";
import type Database from "better-sqlite3";
import type { Logger } from "pino";
import type { EventBus } from "../events/event-bus.js";
import { resolveClaudeConfigDir, resolveRuntimeDir } from "../paths.js";
import {
  buildIntegrationStatus,
  type ClaudeSettingsFacts,
  type InstallRecord,
  nodePathExists,
  nodeVersionProbeDeps,
  probeClaudeVersion,
  readClaudeSettingsFacts,
  readInstallRecord,
  type VersionProbeDeps,
} from "./integration-status.js";
import type { ClaudePipeline } from "./pipeline.js";
import type { SpoolPoller } from "./spool-poller.js";
import { createTranscriptJob, nodeTranscriptIo, type TranscriptIo } from "./transcript-job.js";
import {
  buildSessionUsage,
  buildUsageSummary,
  EMPTY_STATUS_LINE_OBSERVATION,
  localDayOf,
  type StatusLineObservation,
  type UsageSummaryInputs,
} from "./usage-summary.js";

/** The collector setting that holds the transcript-analysis toggle (D-03, D-47). Default off. */
export const TRANSCRIPT_ANALYSIS_SETTING = "transcript_analysis_enabled";

/** The periodic transcript sweep (D-40) and usage refresh (Codex 4); `CCC_TRANSCRIPT_SWEEP_MS` overrides it. */
export const DEFAULT_TRANSCRIPT_SWEEP_MS = 300_000;

/** The integration-status refresh (PR-24); `CCC_INTEGRATION_REFRESH_MS` overrides it. */
export const DEFAULT_INTEGRATION_REFRESH_MS = 60_000;

/** A positive integer of milliseconds from the environment, else the default. */
export function envMs(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/** The settings facts the usage model needs (PR-24); Task 3 reads them from Claude's settings. */
export interface UsageSettingsFacts {
  readonly statusLine: IntegrationInstallState;
  readonly cleanupPeriodDays: number;
}

export interface UsageServicesDeps {
  readonly db: Database.Database;
  readonly bus: Pick<EventBus, "publish">;
  readonly pipeline: Pick<ClaudePipeline, "onRunSettled" | "health" | "applyStatusMetadata">;
  readonly poller: Pick<SpoolPoller, "setStatusLineSink" | "dropCount">;
  readonly logger: Logger;
  readonly env: NodeJS.ProcessEnv;
  readonly now: () => Date;
  /** The local time zone ranges are computed in (D-45); defaults to the process zone. */
  readonly timeZone?: string;
  /** `<claude-config>/projects`, the only transcript root (defaults from `CLAUDE_CONFIG_DIR`). */
  readonly claudeProjectsRoot?: string;
  /** Overrides the transcript file IO (tests). */
  readonly transcriptIo?: Partial<TranscriptIo>;
  /** The service runtime dir holding `hooks/install.json`; defaults to `CCC_RUNTIME_DIR`. */
  readonly runtimeDir?: string;
  /** Claude Code's config dir holding `settings.json` (read only); defaults to `CLAUDE_CONFIG_DIR`. */
  readonly claudeConfigDir?: string;
  /** Overrides the version probe's exec, realpath and mtime (tests). */
  readonly versionProbe?: VersionProbeDeps;
  /** Overrides the hook-runtime existence check (tests). */
  readonly pathExists?: (path: string) => boolean;
  /** Overrides the settings facts (tests). */
  readonly settingsFacts?: () => UsageSettingsFacts;
}

export type StatusLineOutcome = "applied" | "invalid";

export interface UsageServices {
  /** The current summary, computed synchronously (the snapshot reads it in the same tick). */
  summary(): UsageSummary;
  /**
   * Validates and applies one status-line snapshot, from the socket route or
   * the spool poller's latest-only file (D-02). Never throws for bad input.
   */
  handleStatusLine(input: unknown): StatusLineOutcome;
  /**
   * Starts the background work: a non-blocking startup sweep and the
   * periodic sweep, both gated on transcript analysis. `main.ts` calls it
   * once the socket is open, so a sweep never delays startup (D-55).
   */
  start(): void;
  /** The integration status, synchronously (GET integration and the snapshot read it). */
  integration(): ClaudeIntegrationStatus;
  /** Re-reads the settings and install record, probes the version, publishes on change. */
  refreshIntegration(): Promise<ClaudeIntegrationStatus>;
  /**
   * Persists the transcript-analysis toggle service-side and appends it to
   * the toggle log (D-47, D-48). On: first scan pending and a sweep. Off:
   * the in-flight scan stops at its next chunk boundary; aggregates stay.
   */
  setTranscriptAnalysis(enabled: boolean): Promise<{ enabled: boolean }>;
  /**
   * Empties the usage tables in one transaction and republishes (D-46,
   * USAGE-08); Runs stay. With analysis on, this is an honest rebuild (wave
   * 4 review): coverage starts over, the summary reads first-scan-pending
   * (never the deleted totals, never a day as covered), and a full sweep
   * immediately recounts from the transcripts Claude Code still keeps —
   * minus any switched-off period (D-47). With analysis off, nothing is
   * read and the totals stay deleted.
   */
  deleteUsage(): void;
  /** Usage for one Run's Claude session, or null for an unknown Run. */
  sessionUsage(runId: RunId): SessionUsage | null;
  /** Stops timers and listeners and waits for in-flight work. */
  stop(): Promise<void>;
}

const VERSION_SHAPE = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;

/** The version an invalid snapshot names, only when it is shaped like one. */
function versionNamedBy(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const version = (input as { version?: unknown }).version;
  return typeof version === "string" && VERSION_SHAPE.test(version) ? version : null;
}

/** A status-line `resets_at` as ISO: a number is epoch SECONDS (PR-14). */
function isoResetsAt(value: string | number): string | null {
  const ms = typeof value === "number" ? value * 1000 : Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function processTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * The usage composition (05-12): the status-line ingest into capacity and
 * cost, and the one summary builder behind `usage.updated` and
 * `snapshot.state.usage`. It hooks the pipeline and the poller only through
 * their listener APIs (05-08).
 */
export function startUsageServices(deps: UsageServicesDeps): UsageServices {
  const { db, bus, logger, now } = deps;
  const timeZone = deps.timeZone ?? processTimeZone();
  const runtimeDir = deps.runtimeDir ?? resolveRuntimeDir();
  const claudeConfigDir = deps.claudeConfigDir ?? resolveClaudeConfigDir();
  const settingsPath = join(claudeConfigDir, "settings.json");
  const probeDeps = deps.versionProbe ?? nodeVersionProbeDeps();
  const pathExists = deps.pathExists ?? nodePathExists;
  // Read-only (PR-24): re-read at startup, on the refresh timer and never written.
  let claudeSettings: ClaudeSettingsFacts = readClaudeSettingsFacts(settingsPath, runtimeDir);
  let installRecord: InstallRecord | null = readInstallRecord(runtimeDir);
  let detectedClaudeVersion: string | null = null;
  const settingsFacts =
    deps.settingsFacts ??
    ((): UsageSettingsFacts => ({
      statusLine: claudeSettings.statusLine,
      cleanupPeriodDays: claudeSettings.cleanupPeriodDays,
    }));
  let observation: StatusLineObservation = EMPTY_STATUS_LINE_OBSERVATION;
  let firstScanPending = false;

  /** Off unless the owner turned it on: an absent setting is off (D-03, USAGE-07). */
  function analysisEnabled(): boolean {
    return getCollectorSetting(db, TRANSCRIPT_ANALYSIS_SETTING) === "true";
  }

  const io = nodeTranscriptIo();
  const job = createTranscriptJob({
    db,
    logger,
    claudeProjectsRoot: deps.claudeProjectsRoot ?? join(claudeConfigDir, "projects"),
    readChunk: deps.transcriptIo?.readChunk ?? io.readChunk,
    stat: deps.transcriptIo?.stat ?? io.stat,
    listFiles: deps.transcriptIo?.listFiles ?? io.listFiles,
    parse: deps.transcriptIo?.parse ?? parseTranscriptChunk,
    now,
    isEnabled: analysisEnabled,
    dayOf: (iso) => localDayOf(iso, timeZone),
    cleanupPeriodDays: () => settingsFacts().cleanupPeriodDays,
  });

  function summaryInputs(): UsageSummaryInputs {
    const facts = settingsFacts();
    return {
      db,
      statusLineInstall: facts.statusLine,
      observation,
      now: now(),
      timeZone,
      analysis: { enabled: analysisEnabled(), firstScanPending },
      cleanupPeriodDays: facts.cleanupPeriodDays,
      transcripts: job.facts(),
    };
  }

  function summary(): UsageSummary {
    return buildUsageSummary(summaryInputs());
  }

  function publishUsage(): void {
    try {
      bus.publish("usage.updated", summary());
    } catch (err: unknown) {
      logger.warn({ err }, "usage summary publish failed");
    }
  }

  /** Capacity per window (latest wins) and the session's running cost total (never summed). */
  function applySnapshot(snapshot: StatusLineSnapshot): void {
    const observedAt = new Date(snapshot.observedAt).toISOString();
    const windows = [
      ["five-hour", snapshot.rate_limits?.five_hour],
      ["seven-day", snapshot.rate_limits?.seven_day],
    ] as const;
    let hadLimits = false;
    db.transaction(() => {
      for (const [window, limit] of windows) {
        if (limit === undefined) continue;
        hadLimits = true;
        upsertCapacitySnapshot(db, {
          window,
          usedPercent: limit.used_percentage,
          resetsAt: isoResetsAt(limit.resets_at),
          observedAt,
          claudeSessionId: snapshot.session_id,
        });
      }
      if (snapshot.cost_total_usd !== undefined) {
        upsertCostSnapshot(db, {
          claudeSessionId: snapshot.session_id,
          totalCostUsd: snapshot.cost_total_usd,
          observedAt,
        });
      }
    })();
    const isNewest =
      observation.lastValidAt === null ||
      Date.parse(observedAt) >= Date.parse(observation.lastValidAt);
    observation = {
      lastValidAt: isNewest ? observedAt : observation.lastValidAt,
      lastHadLimits: isNewest ? hadLimits : observation.lastHadLimits,
      lastInvalidAt: null,
      lastInvalidVersion: null,
    };
  }

  function handleStatusLine(input: unknown): StatusLineOutcome {
    const parsed = StatusLineSnapshotSchema.safeParse(input);
    if (!parsed.success) {
      observation = {
        ...observation,
        lastInvalidAt: now().toISOString(),
        lastInvalidVersion: versionNamedBy(input),
      };
      logger.warn(
        { fields: parsed.error.issues.map((issue) => issue.path.join(".")).slice(0, 8) },
        "status-line snapshot failed its schema",
      );
      publishUsage();
      return "invalid";
    }
    try {
      applySnapshot(parsed.data);
      const snapshot = parsed.data;
      // Off the status-line reply path: a metadata merge failure never fails
      // the snapshot, which is already stored.
      void deps.pipeline
        .applyStatusMetadata({
          claudeSessionId: snapshot.session_id,
          observedAt: new Date(snapshot.observedAt).toISOString(),
          name: snapshot.session_name,
          model: snapshot.model_id,
          effort: snapshot.effort_level,
          claudeVersion: snapshot.version,
        })
        .catch((err: unknown) => {
          logger.warn({ err }, "status-line session metadata could not be applied");
        });
    } catch (err: unknown) {
      logger.error({ err }, "status-line snapshot could not be stored");
      throw err;
    }
    publishUsage();
    return "applied";
  }

  deps.poller.setStatusLineSink((snapshot) => {
    try {
      handleStatusLine(snapshot);
    } catch {
      // Logged in handleStatusLine; a spooled snapshot is a latest-only
      // update, and the next one supersedes it.
    }
  });

  // --- the transcript scanner: never on the ingest path (D-55) -------------

  const inFlight = new Set<Promise<void>>();
  let stopped = false;
  let sweeping = false;
  let sweepAgain = false;
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let integrationTimer: ReturnType<typeof setInterval> | undefined;

  function track(work: Promise<void>): void {
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
  }

  /**
   * One sweep at a time; a request arriving mid-sweep (a re-enable right
   * after a cancel, say) runs once more when it ends. usage.updated goes
   * out once a batch completes, never per chunk.
   */
  async function runSweep(): Promise<boolean> {
    if (sweeping) {
      sweepAgain = true;
      return false;
    }
    sweeping = true;
    let published = false;
    try {
      do {
        sweepAgain = false;
        if (stopped || !analysisEnabled()) break;
        const outcome = await job.sweep();
        // A held sweep has its answer too: the format-changed verdict (D-41).
        if (!outcome.completed && !outcome.held) continue;
        firstScanPending = false;
        publishUsage();
        published = true;
      } while (sweepAgain);
    } catch (err: unknown) {
      logger.warn({ err }, "transcript sweep failed");
    } finally {
      sweeping = false;
    }
    return published;
  }

  /**
   * The periodic tick (Codex 4): a sweep when analysis is on, and a fresh
   * usage.updated either way, so freshness and the Today range recompute
   * (across midnight too) even when no transcript is ever read.
   */
  async function periodicRefresh(): Promise<void> {
    if (stopped) return;
    const published = await runSweep();
    if (!published && !stopped) publishUsage();
  }

  /** The scan a Stop or SessionEnd schedules for that Run's own contained transcript (D-40). */
  async function scanSettled(transcriptPath: string): Promise<void> {
    try {
      const outcome = await job.scanFile(transcriptPath);
      if (outcome.kind === "scanned" || outcome.kind === "held") publishUsage();
    } catch (err: unknown) {
      logger.warn({ err }, "transcript scan failed");
    }
  }

  const unsubscribeSettled = deps.pipeline.onRunSettled((run) => {
    // The gate is checked here, inside the listener, before anything is
    // scheduled: with analysis off, a settle touches no file (USAGE-07).
    if (stopped || run.transcriptPath === null || !analysisEnabled()) return;
    const transcriptPath = run.transcriptPath;
    // The listener runs inside the pipeline's apply; the scan waits for the
    // next turn of the event loop so the ingest path never reads a file.
    setImmediate(() => {
      if (!stopped) track(scanSettled(transcriptPath));
    });
  });

  // --- integration status (PR-24) ------------------------------------------

  /** Whether any status-line report is known: this process saw one, or the store holds one. */
  function statusLineReported(): boolean {
    return (
      observation.lastValidAt !== null ||
      latestCapacity(db).length > 0 ||
      listCostSnapshots(db).length > 0
    );
  }

  /** Cached settings and version facts plus the live pipeline and spool counters. */
  function integration(): ClaudeIntegrationStatus {
    return buildIntegrationStatus({
      settings: claudeSettings,
      install: installRecord,
      pathExists,
      health: deps.pipeline.health(),
      dropCount: deps.poller.dropCount(),
      analysisEnabled: analysisEnabled(),
      statusLineReported: statusLineReported(),
      detectedClaudeVersion,
    });
  }

  let lastIntegration = JSON.stringify(integration());

  /** Publishes claude-integration.updated only when the status differs from the last one. */
  function publishIntegrationIfChanged(): void {
    try {
      const status = integration();
      const key = JSON.stringify(status);
      if (key === lastIntegration) return;
      lastIntegration = key;
      bus.publish("claude-integration.updated", status);
    } catch (err: unknown) {
      logger.warn({ err }, "integration status publish failed");
    }
  }

  /** Re-reads Claude's settings and the install record, re-probes the version (cached), publishes on change. */
  async function refreshIntegration(): Promise<ClaudeIntegrationStatus> {
    claudeSettings = readClaudeSettingsFacts(settingsPath, runtimeDir);
    installRecord = readInstallRecord(runtimeDir);
    detectedClaudeVersion = await probeClaudeVersion(installRecord?.claudeBin ?? null, probeDeps);
    publishIntegrationIfChanged();
    return integration();
  }

  async function refreshInBackground(): Promise<void> {
    try {
      await refreshIntegration();
    } catch (err: unknown) {
      logger.warn({ err }, "integration status refresh failed");
    }
  }

  return {
    summary,
    handleStatusLine,
    integration,
    refreshIntegration,
    async setTranscriptAnalysis(enabled) {
      const was = analysisEnabled();
      const at = now().toISOString();
      // Service-owned (D-48): the setting and its history change together.
      db.transaction(() => {
        setCollectorSetting(db, TRANSCRIPT_ANALYSIS_SETTING, enabled ? "true" : "false", at);
        if (was !== enabled) appendToggleLog(db, at, enabled);
      })();
      if (enabled) {
        if (!was) firstScanPending = true;
      } else {
        // Stops an in-flight scan at its next chunk boundary; aggregates stay (D-47).
        job.cancel();
        firstScanPending = false;
      }
      publishUsage();
      publishIntegrationIfChanged();
      if (enabled && !stopped) track(runSweep().then(() => undefined));
      return { enabled };
    },
    deleteUsage() {
      // Cancel first, so a scan mid-file writes nothing after the delete.
      job.reset();
      deleteUsageAnalytics(db);
      observation = EMPTY_STATUS_LINE_OBSERVATION;
      const rebuild = analysisEnabled() && !stopped;
      firstScanPending = rebuild;
      publishUsage();
      publishIntegrationIfChanged();
      if (rebuild) track(runSweep().then(() => undefined));
    },
    sessionUsage(runId) {
      const run = getSessionRun(db, runId);
      if (run === null) return null;
      return buildSessionUsage({ ...summaryInputs(), run });
    },
    start() {
      if (stopped || sweepTimer !== undefined) return;
      const sweepMs = envMs(deps.env.CCC_TRANSCRIPT_SWEEP_MS, DEFAULT_TRANSCRIPT_SWEEP_MS);
      setImmediate(() => {
        if (!stopped) track(runSweep().then(() => undefined));
      });
      sweepTimer = setInterval(() => track(periodicRefresh()), sweepMs);
      sweepTimer.unref();
      const refreshMs = envMs(deps.env.CCC_INTEGRATION_REFRESH_MS, DEFAULT_INTEGRATION_REFRESH_MS);
      track(refreshInBackground());
      integrationTimer = setInterval(() => track(refreshInBackground()), refreshMs);
      integrationTimer.unref();
    },
    async stop() {
      stopped = true;
      if (sweepTimer !== undefined) clearInterval(sweepTimer);
      if (integrationTimer !== undefined) clearInterval(integrationTimer);
      unsubscribeSettled();
      job.cancel();
      await Promise.allSettled([...inFlight]);
      await job.idle();
    },
  };
}
