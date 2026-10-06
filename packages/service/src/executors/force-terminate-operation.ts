import {
  type ApprovalItemDraft,
  type ApprovalLog,
  type ClaimFacts,
  type ExecuteContext,
  type ExecuteOutcome,
  type OperationDefinition,
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

/** Thrown by the parts of the definition a later task adds. */
class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} is not implemented yet`);
    this.name = "NotImplementedError";
  }
}

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
  const { inspector } = deps;
  return {
    operation: OPERATION,
    payload: ForceTerminatePayloadSchema,

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
      return {
        runId: payload.runId,
        pid: run?.pid ?? null,
        processStartedAt: run?.processStartedAt ?? null,
        state: run?.state ?? null,
      };
    },

    async execute(
      _token,
      _payload: ForceTerminatePayload,
      _context: ExecuteContext,
    ): Promise<ExecuteOutcome> {
      throw new NotImplementedError("execute");
    },

    async reconcile(
      _payload: ForceTerminatePayload,
      _context: ExecuteContext,
    ): Promise<ReconcileVerdict> {
      throw new NotImplementedError("reconcile");
    },

    render,
  };
}
