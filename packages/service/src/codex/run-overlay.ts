import type { CodexSessionState } from "@ccc/domain";
import {
  type PendingFact,
  type PrivatePending,
  type PrivateRun,
  type RunFact,
  type RunRecordReader,
  type RunRecordScan,
  SKIP_REASONS,
} from "./run-records.js";
import type { CodexSessionMirror, SessionOverlay } from "./session-mirror.js";

/**
 * The mirror overlay over the wrapper's run records (plan 05.1-26, D-18, D-20, D-29, CODEX-05,
 * CODEX-06, CODEX-11).
 *
 * The rollout-derived session list is the base picture. The wrapper's records can resolve what a
 * rollout cannot, and never the reverse: they mark a thread's origin (a review run is `review`, any
 * other wrapper kind is `headless`), name the registered project, say which run has a live log, and
 * (Task 2 of this plan) report an explicit end or a pause by the usage limit.
 *
 * The overlay is a pure, synchronous function over the LAST scan: the filesystem is read by
 * {@link RunOverlay.refresh}, which the mirror's own subscriber-gated tick drives, so this module
 * owns no timer. A refresh that finds a changed scan asks the mirror to rebuild from its cached
 * facts (no store read).
 *
 * Privacy: the overlay only ever writes fields of the existing strict session view. No path,
 * worktree name, record text or kind reaches it, and every log line is a fixed reason code.
 */

export interface RunStateInput {
  readonly state: CodexSessionState;
  readonly lastActivityAt: string;
  readonly resumesAfter: string | null;
  readonly limitHitAfter: boolean;
  readonly lastLifecycleAt: string | null;
  /** The newest record naming this thread's session. */
  readonly record: Pick<RunFact, "runId" | "status" | "startedAt" | "resetsAt"> | null;
  /** The pending-resume record naming this thread's session. */
  readonly pending: PendingFact | null;
  /** The record of the run the pending record names (it may name no session). */
  readonly pendingRun: Pick<RunFact, "status" | "resetsAt"> | null;
}

export interface RunStateDecision {
  readonly state: CodexSessionState;
  readonly resumesAfter: string | null;
}

function timeOf(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * The resume time of a pause when (and only when) the run is paused by the usage limit, else null
 * for "not paused". A pause needs the pending-resume record naming this thread's session PLUS a
 * second signal: the wrapper's own record for that run says it hit the limit, or the rollout shows
 * a limit-hit fact after the last lifecycle event (D-20, CODEX-11, T-05.1-27).
 */
function pauseOf(input: RunStateInput): { readonly resumesAfter: string | null } | null {
  const pending = input.pending;
  if (pending === null) return null;
  // A finished turn is never paused, whatever else the files say.
  if (input.state === "completed") return null;
  const recordedMs = timeOf(pending.recordedAt);
  // Activity after the pending record was written means the thread is running (or ran) again.
  if (input.state === "running" && timeOf(input.lastActivityAt) > recordedMs) return null;
  if (input.lastLifecycleAt !== null && timeOf(input.lastLifecycleAt) > recordedMs) return null;
  // A later run of the same session supersedes the pending record.
  const record = input.record;
  if (record !== null && record.runId !== pending.runId && timeOf(record.startedAt) > recordedMs) {
    return null;
  }
  const wrapperSaysLimit = input.pendingRun?.status === "limit";
  if (!wrapperSaysLimit && !input.limitHitAfter) return null;
  return { resumesAfter: pending.resetsAt ?? input.pendingRun?.resetsAt ?? null };
}

/**
 * The one rule table for what a wrapper record may change about a session's state (D-18, D-20).
 *
 * 1. End reports, from the newest record naming the session. They resolve what a rollout cannot
 *    and never the reverse: `ok` turns a STALE view into completed; `failed` and `timeout` turn a
 *    running or stale view into failed; a `running`, `limit` or `refused` record changes nothing,
 *    and no state is ever moved to completed without an explicit ok report.
 * 2. The pause, applied LAST so a paused run is never also reported failed: see {@link pauseOf}.
 */
export function decideRunState(input: RunStateInput): RunStateDecision {
  let state = input.state;
  const record = input.record;
  if (record !== null) {
    if (record.status === "ok" && state === "stale") state = "completed";
    else if (
      (record.status === "failed" || record.status === "timeout") &&
      (state === "running" || state === "stale")
    ) {
      state = "failed";
    }
  }
  const pause = pauseOf(input);
  if (pause !== null) return { state: "limit-paused", resumesAfter: pause.resumesAfter };
  return { state, resumesAfter: input.resumesAfter };
}

export interface RunOverlayDeps {
  readonly reader: Pick<RunRecordReader, "scan">;
  readonly mirror: Pick<CodexSessionMirror, "addOverlay" | "addTickHook" | "invalidate">;
  readonly now: () => number;
  /** A log untouched for longer than this is no longer live (the mirror's inactivity window). */
  readonly inactivityMs: number;
  /** Reason codes only. */
  readonly logger?: {
    warn(
      fields: { readonly reason: string; readonly errorName?: string; readonly detail?: string },
      message: string,
    ): void;
  };
}

export interface RunOverlay {
  readonly overlay: SessionOverlay;
  /** Rescans the records and asks the mirror to rebuild when something a viewer sees changed. */
  refresh(): Promise<void>;
  /** Removes the overlay and the tick hook from the mirror. */
  dispose(): void;
}

const MAX_PROJECT_NAME = 256;

export function createRunOverlay(deps: RunOverlayDeps): RunOverlay {
  /** The newest record per session id (lower case). */
  let latestBySession = new Map<string, PrivateRun>();
  let runById = new Map<string, PrivateRun>();
  let pendingBySession = new Map<string, PrivatePending>();
  /** The key of the last scan the mirror was told about; an empty scan is the starting point. */
  let lastKey = "|";
  let lastSkipKey = "";

  function index(next: RunRecordScan): void {
    const bySession = new Map<string, PrivateRun>();
    const byId = new Map<string, PrivateRun>();
    for (const run of next.runs) {
      byId.set(run.runId, run);
      if (run.sessionId === null) continue;
      const known = bySession.get(run.sessionId);
      if (known === undefined || timeOf(run.startedAt) > timeOf(known.startedAt)) {
        bySession.set(run.sessionId, run);
      }
    }
    const pendingMap = new Map<string, PrivatePending>();
    for (const record of next.pending) {
      const known = pendingMap.get(record.sessionId);
      if (known === undefined || timeOf(record.recordedAt) > timeOf(known.recordedAt)) {
        pendingMap.set(record.sessionId, record);
      }
    }
    latestBySession = bySession;
    runById = byId;
    pendingBySession = pendingMap;
  }

  /** The run id whose live log may be followed, or null (D-29). */
  function liveLogRunIdOf(run: PrivateRun, nowMs: number): string | null {
    if (run.status !== "running" || run.mode === "tui") return null;
    if (run.liveLog?.kind !== "live") return null;
    return nowMs - run.liveLog.mtimeMs <= deps.inactivityMs ? run.runId : null;
  }

  /** Which running logs are fresh: flipping to stale must rebuild even though no file changed. */
  function livenessKey(next: RunRecordScan, nowMs: number): string {
    return next.runs
      .filter((run) => run.liveLog?.kind === "live")
      .map((run) => `${run.runId}:${liveLogRunIdOf(run, nowMs) === null ? 0 : 1}`)
      .join(",");
  }

  const overlay: SessionOverlay = (view, context) => {
    try {
      const key = view.threadId.toLowerCase();
      const record = latestBySession.get(key) ?? null;
      const pending = pendingBySession.get(key) ?? null;
      if (record === null && pending === null) return view;
      let next = view;
      if (record !== null) {
        next = {
          ...next,
          origin: record.kind === "review" ? "review" : "headless",
          liveLogRunId: liveLogRunIdOf(record, deps.now()),
        };
        // Attribution by working directory is more specific than a record's directory: keep it.
        if (next.projectId === null) {
          next = {
            ...next,
            projectId: record.projectId,
            projectName: record.projectName.slice(0, MAX_PROJECT_NAME),
          };
        }
      }
      const decision = decideRunState({
        state: next.state,
        lastActivityAt: next.lastActivityAt,
        resumesAfter: next.resumesAfter,
        limitHitAfter: context.limitHitAfter,
        lastLifecycleAt: context.lastLifecycleAt,
        record,
        pending,
        pendingRun: pending === null ? null : (runById.get(pending.runId) ?? null),
      });
      if (decision.state !== next.state || decision.resumesAfter !== next.resumesAfter) {
        next = { ...next, state: decision.state, resumesAfter: decision.resumesAfter };
      }
      return next;
    } catch {
      return view;
    }
  };

  function logSkips(next: RunRecordScan): void {
    const detail = SKIP_REASONS.filter((reason) => next.skipped[reason] > 0)
      .map((reason) => `${reason}=${next.skipped[reason]}`)
      .join(",");
    if (detail === lastSkipKey) return;
    lastSkipKey = detail;
    if (detail !== "") {
      deps.logger?.warn({ reason: "records-skipped", detail }, "codex run records skipped");
    }
  }

  async function refresh(): Promise<void> {
    try {
      const next = await deps.reader.scan();
      index(next);
      logSkips(next);
      const key = `${next.signature}|${livenessKey(next, deps.now())}`;
      if (key === lastKey) return;
      lastKey = key;
      deps.mirror.invalidate();
    } catch (error: unknown) {
      deps.logger?.warn(
        { reason: "scan-failed", errorName: error instanceof Error ? error.name : "non-error" },
        "codex run records scan failed",
      );
    }
  }

  const removeOverlay = deps.mirror.addOverlay(overlay);
  const removeHook = deps.mirror.addTickHook(() => refresh());

  return {
    overlay,
    refresh,
    dispose() {
      removeOverlay();
      removeHook();
    },
  };
}
