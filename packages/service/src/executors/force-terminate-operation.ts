import {
  type ApprovalItemDraft,
  type ApprovalLog,
  type ClaimFacts,
  type ExecuteContext,
  type ExecuteOutcome,
  isTerminalRunState,
  type OperationDefinition,
  type ProcessStatus,
  type ReconcileVerdict,
  RUN_STATES,
  type RunFacts,
  RunIdSchema,
  type RunInspector,
  type SessionTerminator,
} from "@ccc/domain";
import { z } from "zod";

/**
 * The `session.force-terminate` operation (D-42): an `OperationDefinition`
 * around Phase 5's identity-checked terminator. The terminator stays where it
 * is (`claude/terminate-executor.ts`) and keeps all of its own checks; this
 * adapter owns the payload, the render, the claim facts, the result mapping and
 * the reconcile hook, and reaches the world only through the `SessionTerminator`
 * and `RunInspector` ports.
 *
 * Element: `executors`. Imports `@ccc/domain` and zod only.
 */

const OPERATION = "session.force-terminate" as const;

/**
 * What a force-terminate request carries, captured by the requester adapter at
 * submit time (D-16): everything the owner is shown, so the displayed text is
 * what the hash covers. It holds no path.
 */
const ForceTerminatePayloadSchema = z.strictObject({
  runId: RunIdSchema,
  /** The Run's display name. */
  runName: z.string().min(1).max(120),
  /** The registered project's display name, when the Run has one. */
  projectName: z.string().min(1).max(120).optional(),
  /** The process's short name (for example the binary's name), never a path. */
  processName: z.string().min(1).max(64),
  pid: z.number().int().positive(),
  /** The process start the Run recorded, in the form the process table reports it. */
  processStartedAt: z.string().min(1).max(64),
  stateBefore: z.enum(RUN_STATES),
});
export type ForceTerminatePayload = z.infer<typeof ForceTerminatePayloadSchema>;

export interface ForceTerminateDeps {
  readonly terminator: SessionTerminator;
  readonly inspector: RunInspector;
  readonly log: ApprovalLog;
}

/** The note recorded when the terminator succeeded but the Run is not yet in a terminal state. */
const AWAITING_EXIT_NOTE = "awaiting-exit";

/** Evidence codes `reconcile` records; fixed vocabulary, never a path or a name. */
const EVIDENCE_RUN_CANCELLED_SAME_PROCESS = "run-cancelled-same-process";
const EVIDENCE_PROCESS_GONE = "process-gone";
const UNKNOWN_CLAIM_FACTS_MISSING = "claim-facts-missing";
const UNKNOWN_CLAIM_FACTS_MISMATCH = "claim-facts-mismatch";
const UNKNOWN_RUN_NOT_FOUND = "run-not-found";
const UNKNOWN_INSPECTOR_FAILED = "inspector-failed";

const CHECK_HINT = "Check whether the session's process is still running before asking again.";

function render(payload: ForceTerminatePayload): ApprovalItemDraft {
  const { runName } = payload;
  return {
    title: `Force-terminate ${runName}`,
    destructive: true,
    effect: `force-terminate ${runName}`,
    action:
      "Ask the session's process to stop, then force it to stop if it is still running after a short wait.",
    runName,
    target: [
      { label: "Session", value: runName, mono: false },
      { label: "Process", value: `${payload.processName} · PID ${payload.pid}`, mono: true },
      { label: "Process started", value: payload.processStartedAt, mono: false },
    ],
    change: {
      type: "diff",
      lines: [
        { kind: "removed", text: `state: ${payload.stateBefore}` },
        { kind: "added", text: "state: cancelled" },
      ],
    },
    changeFromRequester: false,
    risks: [
      "Work in progress in the session is lost.",
      "The process is forced to stop if it does not end when asked.",
      "A stopped process cannot be brought back by this request.",
    ],
    checkHint: CHECK_HINT,
  };
}

export function createForceTerminateOperation(
  deps: ForceTerminateDeps,
): OperationDefinition<typeof OPERATION, ForceTerminatePayload> {
  const { terminator, inspector, log } = deps;

  /**
   * `ok` is also returned when the pid outlives the kill wait, so the Run may
   * not be cancelled yet; the liveness sweep finishes it later. The note lets
   * the inbox say so. Reading the Run happens after the effect, so a failing
   * read cannot undo it: the outcome stays `executed`, without a note.
   */
  function executedOutcome(payload: ForceTerminatePayload): ExecuteOutcome {
    let run: RunFacts | null = null;
    try {
      run = inspector.readRun(payload.runId);
    } catch {
      run = null;
    }
    if (run !== null && !isTerminalRunState(run.state)) {
      return { kind: "executed", note: AWAITING_EXIT_NOTE };
    }
    return { kind: "executed" };
  }

  return {
    operation: OPERATION,
    payload: ForceTerminatePayloadSchema,

    subjectOf: (payload: ForceTerminatePayload) => payload.runId,

    async claimFacts(payload: ForceTerminatePayload): Promise<ClaimFacts> {
      // Read-only. A missing Run or a failing inspector yields null facts rather
      // than an error, so the engine can still claim and let the executor refuse
      // (the error text is never logged: it may carry a path).
      let run: RunFacts | null = null;
      try {
        run = inspector.readRun(payload.runId);
      } catch {
        run = null;
      }
      // The pid and process start recorded are the ones the owner approved (the
      // payload's), never the Run's current ones: reconcile must be about the
      // approved process, not whatever the Run points at after a restart.
      return {
        runId: payload.runId,
        pid: payload.pid,
        processStartedAt: payload.processStartedAt,
        state: run?.state ?? null,
      };
    },

    async execute(
      token,
      payload: ForceTerminatePayload,
      context: ExecuteContext,
    ): Promise<ExecuteOutcome> {
      const proposalId = context.idempotencyKey;
      // Defense in depth (T-06-01): the terminator checks its own token, but a
      // token minted for another operation, another Run or another proposal
      // never reaches it. The Run id comes from the stored payload, never from
      // a request (D-16).
      if (
        token.operation !== OPERATION ||
        token.subject !== payload.runId ||
        token.proposalId !== proposalId
      ) {
        log.error({ proposalId, code: "token-mismatch" }, "force-terminate: token mismatch");
        return { kind: "failed", reason: "capability-refused" };
      }

      // What you approve is what runs: the Run must still point at the process
      // the owner approved. Fail closed: a missing Run or a failing read means
      // the identity cannot be verified, so the terminator is never called.
      let current: RunFacts | null = null;
      try {
        current = inspector.readRun(payload.runId);
      } catch {
        return { kind: "refused", reason: "identity-mismatch" };
      }
      if (current === null) return { kind: "refused", reason: "run-not-found" };
      if (current.pid !== payload.pid || current.processStartedAt !== payload.processStartedAt) {
        return { kind: "refused", reason: "identity-mismatch" };
      }

      // Deliberately not wrapped in a catch: once the terminator is called a
      // signal may already have been sent, so a rejection must reach the engine,
      // which records the outcome as unknown rather than as a failure.
      const result = await terminator.terminate(token, payload.runId);

      if (result.ok) return executedOutcome(payload);
      switch (result.reason) {
        case "process-ended":
        case "run-not-found":
        case "identity-mismatch":
          // Nothing was done. Definitive on a first attempt; after a restart the
          // engine asks `reconcile` before recording anything (D-17).
          return { kind: "refused", reason: result.reason };
        case "capability-refused":
          // The engine's minter and the terminator disagree about what the token
          // covers: an engine bug, not an owner-facing condition.
          log.error(
            { proposalId, code: "capability-refused" },
            "force-terminate: capability refused",
          );
          return { kind: "failed", reason: "capability-refused" };
      }
    },

    async reconcile(
      payload: ForceTerminatePayload,
      context: ExecuteContext,
    ): Promise<ReconcileVerdict> {
      // Read-only: this hook never signals anything and never calls the terminator.
      //
      // `effect-proven` means the goal state was observed with matching identity
      // (research assumption A9), not that this engine's signal caused it: the
      // owner may have closed the session by hand meanwhile. The evidence code
      // records which of the two observations was made.
      const { pid, processStartedAt } = context.claimFacts;
      if (
        typeof pid !== "number" ||
        !Number.isInteger(pid) ||
        pid <= 0 ||
        typeof processStartedAt !== "string" ||
        processStartedAt === ""
      ) {
        return { kind: "unknown", reason: UNKNOWN_CLAIM_FACTS_MISSING };
      }
      // The claim must be about the approved process; anything else says
      // nothing about whether the approved action happened.
      if (pid !== payload.pid || processStartedAt !== payload.processStartedAt) {
        return { kind: "unknown", reason: UNKNOWN_CLAIM_FACTS_MISMATCH };
      }

      let run: RunFacts | null;
      try {
        run = inspector.readRun(payload.runId);
      } catch {
        return { kind: "unknown", reason: UNKNOWN_INSPECTOR_FAILED };
      }
      if (run === null) return { kind: "unknown", reason: UNKNOWN_RUN_NOT_FOUND };

      if (
        run.state === "cancelled" &&
        run.pid === pid &&
        run.processStartedAt === processStartedAt
      ) {
        return { kind: "effect-proven", evidence: EVIDENCE_RUN_CANCELLED_SAME_PROCESS };
      }

      let status: ProcessStatus;
      try {
        status = await inspector.processStatus(pid, processStartedAt);
      } catch {
        return { kind: "unknown", reason: UNKNOWN_INSPECTOR_FAILED };
      }
      // A pid that is gone, or that now belongs to a different process, is no
      // longer the process the owner approved ending.
      return status === "same"
        ? { kind: "effect-absent" }
        : { kind: "effect-proven", evidence: EVIDENCE_PROCESS_GONE };
    },

    render,
  };
}
