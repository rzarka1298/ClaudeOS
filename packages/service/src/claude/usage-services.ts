import {
  type IntegrationInstallState,
  type StatusLineSnapshot,
  StatusLineSnapshotSchema,
  type UsageSummary,
} from "@ccc/domain";
import {
  getCollectorSetting,
  upsertCapacitySnapshot,
  upsertCostSnapshot,
} from "@ccc/operational-store";
import type Database from "better-sqlite3";
import type { Logger } from "pino";
import type { EventBus } from "../events/event-bus.js";
import type { ClaudePipeline } from "./pipeline.js";
import type { SpoolPoller } from "./spool-poller.js";
import {
  buildUsageSummary,
  EMPTY_STATUS_LINE_OBSERVATION,
  type StatusLineObservation,
} from "./usage-summary.js";

/** The collector setting that holds the transcript-analysis toggle (D-03, D-47). Default off. */
export const TRANSCRIPT_ANALYSIS_SETTING = "transcript_analysis_enabled";

/** The settings facts the usage model needs (PR-24); Task 3 reads them from Claude's settings. */
export interface UsageSettingsFacts {
  readonly statusLine: IntegrationInstallState;
  readonly cleanupPeriodDays: number;
}

export interface UsageServicesDeps {
  readonly db: Database.Database;
  readonly bus: Pick<EventBus, "publish">;
  readonly pipeline: Pick<ClaudePipeline, "onRunSettled" | "health">;
  readonly poller: Pick<SpoolPoller, "setStatusLineSink" | "dropCount">;
  readonly logger: Logger;
  readonly env: NodeJS.ProcessEnv;
  readonly now: () => Date;
  /** The local time zone ranges are computed in (D-45); defaults to the process zone. */
  readonly timeZone?: string;
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
  /** Starts the background work; `main.ts` calls it once the socket is open. */
  start(): void;
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
  const settingsFacts =
    deps.settingsFacts ??
    ((): UsageSettingsFacts => ({ statusLine: "unknown", cleanupPeriodDays: 30 }));
  let observation: StatusLineObservation = EMPTY_STATUS_LINE_OBSERVATION;
  const firstScanPending = false;

  function analysisEnabled(): boolean {
    return getCollectorSetting(db, TRANSCRIPT_ANALYSIS_SETTING) === "true";
  }

  function summary(): UsageSummary {
    return buildUsageSummary({
      db,
      statusLineInstall: settingsFacts().statusLine,
      observation,
      now: now(),
      timeZone,
      analysis: { enabled: analysisEnabled(), firstScanPending },
    });
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

  return {
    summary,
    handleStatusLine,
    start() {},
    async stop() {},
  };
}
