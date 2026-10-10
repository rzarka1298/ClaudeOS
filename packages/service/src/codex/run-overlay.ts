import type { CodexSessionState } from "@ccc/domain";
import type { PendingFact, RunFact, RunRecordReader } from "./run-records.js";
import type { CodexSessionMirror, SessionOverlay } from "./session-mirror.js";

/**
 * The mirror overlay over the wrapper's run records (plan 05.1-26, D-18, D-20, D-29, CODEX-05,
 * CODEX-06, CODEX-11). SIGNATURE STUBS for the red commit: the implementation follows.
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
  readonly inactivityMs: number;
  readonly logger?: {
    warn(fields: { readonly reason: string; readonly errorName?: string }, message: string): void;
  };
}

export interface RunOverlay {
  readonly overlay: SessionOverlay;
  refresh(): Promise<void>;
  dispose(): void;
}

export function createRunOverlay(_deps: RunOverlayDeps): RunOverlay {
  throw new Error("run-overlay: not implemented");
}
