import { ageFreshness, buildCodexHeadroom } from "@ccc/collectors";
import {
  type ClaudeHeadroomView,
  CODEX_USAGE_LIVE_MAX_AGE_MS,
  type CodexHeadroom,
  type CodexUsageSnapshot,
  type CodexUsageUpdatedPayload,
  CodexUsageUpdatedPayloadSchema,
  type HeadroomSignal,
  HeadroomSignalSchema,
} from "@ccc/domain";

/**
 * The Codex headroom service (plan 05.1-15, D-04, D-22 to D-25, CODEX-08,
 * CODEX-11, CODEX-12).
 *
 * It owns the last weekly-allowance read, refreshes it about every minute only
 * while the event stream has subscribers, reads through when a caller asks for
 * a snapshot that is missing or older than the live max age, persists the last
 * live read, and publishes `codex.usage.updated` only when what a viewer would
 * see changed. The verdict and its reason come from the plan 07 guard; nothing
 * here dispatches work, ranks agents or acts on a verdict (D-04): the signal is
 * a statement about capacity.
 *
 * Honesty rules: only a live, fresh, app-server, allowed, unpaused read yields
 * `allow` (the guard). The rollout fallback may feed the bar but the gate still
 * refuses it (OQ-3). A snapshot reloaded from the store at start is presented
 * as stale until a read in this process succeeds. A failed refresh keeps the
 * previous read, which then ages to stale and to unavailable (`too-old`).
 */

/** The production refresh cadence while the dashboard is watching (D-24). */
export const HEADROOM_REFRESH_INTERVAL_MS = 60_000;

/**
 * After a failed (or unconfigured) refresh, read-through callers wait this long before the next
 * attempt, so a broken app-server is never hammered. It is deliberately short: freshness is
 * judged from the last SUCCESSFUL read, so a stale cache keeps retrying soon.
 */
export const HEADROOM_FAILURE_RETRY_MS = 10_000;

export interface HeadroomTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** Real timers whose handle never keeps the process alive. */
export const defaultHeadroomTimers: HeadroomTimers = {
  setInterval(fn, ms) {
    const handle = setInterval(fn, ms);
    handle.unref();
    return handle;
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

export interface HeadroomServiceDeps {
  /** The RPC client; its `read()` never rejects. */
  readonly client: { read(): Promise<CodexUsageSnapshot>; dispose(): void | Promise<void> };
  /** Persists the last live snapshot (plan 11 store). */
  readonly saveSnapshot: (snapshot: CodexUsageSnapshot) => void;
  /** The persisted snapshot, or null. */
  readonly loadSnapshot: () => CodexUsageSnapshot | null;
  /** The bar-only rollout fallback (already normalised), or null. */
  readonly fallback: () => CodexUsageSnapshot | null;
  /** Runs paused by the usage limit (plan 26 binds this). */
  readonly pausedRuns: () => { readonly count: number; readonly earliestResetAt: string | null };
  /** The Claude member, injected (plan 28 binds it to the Phase 5 usage services). */
  readonly claudeView: () => ClaudeHeadroomView;
  /** Open event-stream subscribers; the timer reads only while this is above zero. */
  readonly subscribers: () => number;
  readonly publish: (type: "codex.usage.updated", payload: CodexUsageUpdatedPayload) => void;
  readonly now: () => number;
  readonly timers: HeadroomTimers;
  readonly refreshIntervalMs?: number;
  /** False when Codex is not installed or configured: no read is attempted. */
  readonly isConfigured?: () => boolean;
  /** Reason codes only. */
  readonly logger?: { warn(fields: { readonly reason: string }, message: string): void };
}

export interface HeadroomService {
  /** Read-through: waits for one refresh when the snapshot is missing or older than the live max age. */
  getUsage(): Promise<CodexUsageSnapshot>;
  getHeadroom(): Promise<HeadroomSignal>;
  /** Cache only, synchronous; null before any observation. */
  peekUsage(): CodexUsageSnapshot | null;
  peekHeadroom(): HeadroomSignal | null;
  /** Starts at most one background refresh when the cache is missing or old; returns at once. */
  refreshIfStale(): void;
  start(): void;
  stop(): void | Promise<void>;
}

type Available = Extract<CodexUsageSnapshot, { kind: "available" }>;

export function createHeadroomService(deps: HeadroomServiceDeps): HeadroomService {
  const intervalMs = deps.refreshIntervalMs ?? HEADROOM_REFRESH_INTERVAL_MS;
  const configured = (): boolean => deps.isConfigured?.() ?? true;

  let lastGood: Available | null = null;
  /** True while `lastGood` came from the store and no read in this process has succeeded. */
  let fromStore = false;
  let lastFailure: CodexUsageSnapshot | null = null;
  /** When the last attempt that did NOT produce a live app-server read ended. */
  let lastFailedAttemptMs: number | null = null;
  /** Observation time of the last successful read in this process (a reloaded snapshot is not one). */
  let lastSuccessObservedMs: number | null = null;
  let inFlight: Promise<void> | null = null;
  let timerHandle: unknown = null;
  let lastPublishedKey: string | null = null;

  /** Re-stamps freshness from age; past the stale max age the snapshot becomes `too-old`. */
  function aged(
    snapshot: CodexUsageSnapshot,
    nowMs: number,
    reloaded: boolean,
  ): CodexUsageSnapshot {
    if (snapshot.kind === "unavailable") return snapshot;
    const freshness = ageFreshness(Date.parse(snapshot.observedAt), nowMs);
    if (freshness === "unavailable") {
      return {
        kind: "unavailable",
        reason: "too-old",
        version: snapshot.codexVersion ?? null,
        observedAt: snapshot.observedAt,
      };
    }
    return { ...snapshot, freshness: reloaded && freshness === "live" ? "stale" : freshness };
  }

  /** What the bar shows: the live read, else the rollout fallback, else the reason it is missing. */
  function display(nowMs: number): CodexUsageSnapshot | null {
    const good = lastGood === null ? null : aged(lastGood, nowMs, fromStore);
    if (good?.kind === "available") return good;
    const fallback = deps.fallback();
    const fallbackAged = fallback === null ? null : aged(fallback, nowMs, false);
    if (fallbackAged?.kind === "available") return fallbackAged;
    return good ?? lastFailure ?? fallbackAged;
  }

  /** A reloaded snapshot is never live and never gates: the guard re-stamps from age, so state it here. */
  function restateReloaded(codex: CodexHeadroom): CodexHeadroom {
    if (!fromStore || codex.freshness !== "live") return codex;
    return {
      ...codex,
      freshness: "stale",
      verdict: "refuse",
      reason: codex.reason ?? "usage-unavailable",
    };
  }

  function signalFor(snapshot: CodexUsageSnapshot | null, nowMs: number): HeadroomSignal {
    const paused = deps.pausedRuns();
    const codex = restateReloaded(
      buildCodexHeadroom({
        snapshot,
        nowMs,
        pausedRuns: { count: paused.count, earliestResetAt: paused.earliestResetAt },
      }),
    );
    const generatedAt = new Date(nowMs).toISOString();
    const candidate = { generatedAt, codex, claude: deps.claudeView() };
    const parsed = HeadroomSignalSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
    deps.logger?.warn({ reason: "claude-view-invalid" }, "headroom signal fell back");
    return {
      generatedAt,
      codex,
      claude: { kind: "unavailable", reason: "shape-changed" },
    };
  }

  function missingUsage(nowMs: number): CodexUsageSnapshot {
    return {
      kind: "unavailable",
      reason: "read-failed",
      version: null,
      observedAt: new Date(nowMs).toISOString(),
    };
  }

  function publishIfChanged(): void {
    const nowMs = deps.now();
    const usage = display(nowMs) ?? missingUsage(nowMs);
    const headroom = signalFor(display(nowMs), nowMs);
    // `generatedAt` changes on every call, so it is not part of "did anything change".
    const key = JSON.stringify([usage, headroom.codex, headroom.claude]);
    if (key === lastPublishedKey) return;
    const payload = CodexUsageUpdatedPayloadSchema.safeParse({ usage, headroom });
    if (!payload.success) {
      deps.logger?.warn({ reason: "payload-invalid" }, "codex usage event not published");
      return;
    }
    lastPublishedKey = key;
    deps.publish("codex.usage.updated", payload.data);
  }

  async function runRefresh(): Promise<void> {
    if (!configured()) {
      lastFailedAttemptMs = deps.now();
      publishIfChanged();
      return;
    }
    let snapshot: CodexUsageSnapshot;
    try {
      snapshot = await deps.client.read();
    } catch {
      deps.logger?.warn({ reason: "client-threw" }, "codex usage read failed");
      snapshot = missingUsage(deps.now());
    }
    if (snapshot.kind === "available" && snapshot.source === "app-server") {
      const observed = Date.parse(snapshot.observedAt);
      lastSuccessObservedMs = Number.isFinite(observed) ? observed : deps.now();
      lastFailedAttemptMs = null;
      lastGood = snapshot;
      fromStore = false;
      try {
        deps.saveSnapshot(snapshot);
      } catch {
        deps.logger?.warn({ reason: "persist-failed" }, "codex usage snapshot not saved");
      }
    } else {
      lastFailedAttemptMs = deps.now();
      lastFailure = snapshot;
    }
    publishIfChanged();
  }

  function refresh(): Promise<void> {
    if (inFlight !== null) return inFlight;
    const attempt = runRefresh().finally(() => {
      if (inFlight === attempt) inFlight = null;
    });
    inFlight = attempt;
    return attempt;
  }

  function needsRefresh(): boolean {
    const nowMs = deps.now();
    if (lastFailedAttemptMs !== null && nowMs - lastFailedAttemptMs <= HEADROOM_FAILURE_RETRY_MS) {
      return false;
    }
    return (
      lastSuccessObservedMs === null || nowMs - lastSuccessObservedMs > CODEX_USAGE_LIVE_MAX_AGE_MS
    );
  }

  async function ensureFresh(): Promise<void> {
    if (needsRefresh()) await refresh();
  }

  return {
    async getUsage() {
      await ensureFresh();
      const nowMs = deps.now();
      return display(nowMs) ?? missingUsage(nowMs);
    },
    async getHeadroom() {
      await ensureFresh();
      const nowMs = deps.now();
      return signalFor(display(nowMs), nowMs);
    },
    peekUsage() {
      return display(deps.now());
    },
    peekHeadroom() {
      const nowMs = deps.now();
      const snapshot = display(nowMs);
      return snapshot === null ? null : signalFor(snapshot, nowMs);
    },
    refreshIfStale() {
      if (needsRefresh()) void refresh();
    },
    start() {
      if (timerHandle !== null) return;
      const saved = deps.loadSnapshot();
      if (saved !== null && saved.kind === "available" && saved.source === "app-server") {
        lastGood = saved;
        fromStore = true;
      }
      timerHandle = deps.timers.setInterval(() => {
        if (deps.subscribers() > 0 && configured()) void refresh();
      }, intervalMs);
    },
    stop() {
      if (timerHandle !== null) {
        deps.timers.clearInterval(timerHandle);
        timerHandle = null;
      }
      return deps.client.dispose();
    },
  };
}
