import type { CodexSessionState } from "@ccc/domain";
import {
  type PendingFact,
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

export function decideRunState(_input: RunStateInput): RunStateDecision {
  throw new Error("run-overlay: not implemented");
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

function timeOf(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

export function createRunOverlay(deps: RunOverlayDeps): RunOverlay {
  /** The newest record per session id (lower case). */
  let latestBySession = new Map<string, PrivateRun>();
  /** The key of the last scan the mirror was told about; an empty scan is the starting point. */
  let lastKey = "|";
  let lastSkipKey = "";

  function index(next: RunRecordScan): void {
    const bySession = new Map<string, PrivateRun>();
    for (const run of next.runs) {
      if (run.sessionId === null) continue;
      const known = bySession.get(run.sessionId);
      if (known === undefined || timeOf(run.startedAt) > timeOf(known.startedAt)) {
        bySession.set(run.sessionId, run);
      }
    }
    latestBySession = bySession;
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

  const overlay: SessionOverlay = (view) => {
    try {
      const key = view.threadId.toLowerCase();
      const record = latestBySession.get(key) ?? null;
      if (record === null) return view;
      let next = view;
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
