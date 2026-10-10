import {
  type ApprovalLog,
  isTerminalRunState,
  type ProposeForceTerminate,
  type RunInspector,
} from "@ccc/domain";
import type { ApprovalEngine } from "../approval/index.js";

/**
 * The engine-backed `ProposeForceTerminate` (plan 06-21, D-16, D-42, A-9): what
 * `POST /sessions/terminate-request` calls instead of Phase 5's constant
 * "approval-unavailable". It captures the Run's name, project, process facts
 * and state at submit time into the force-terminate payload (so the owner is
 * shown exactly what the hash covers) and submits it for the dashboard
 * requester. It reaches the engine only through `submit`: it can create a
 * request and nothing else, and it never imports the executors or the
 * terminator.
 *
 * Every failure answers the contract's one failure, `approval-unavailable`, and
 * logs one fixed code (never a name, a path or an error message). A duplicate
 * pending request returns the existing proposal id (the engine dedupes on the
 * Run).
 */

const OPERATION = "session.force-terminate";
const REQUESTER = { kind: "dashboard", label: "Agent runs" } as const;
const REASON = "You asked to force-terminate this session from Agent runs.";
const RUN_NAME_MAX = 120;
const PROJECT_NAME_MAX = 120;
const PROCESS_NAME_MAX = 64;
const FALLBACK_PROCESS_NAME = "process";

export interface ProposerDeps {
  readonly engine: Pick<ApprovalEngine, "submit">;
  readonly inspector: RunInspector;
  /** The Run's project id and display name, or null for an unknown Run. Display data only. */
  readonly runContext: (
    runId: string,
  ) => { readonly projectId: string | null; readonly projectName: string | null } | null;
  /** The short name of a process, or null when it cannot be read. Never a path. */
  readonly processName: (pid: number) => Promise<string | null>;
  readonly log: ApprovalLog;
}

const UNAVAILABLE = { ok: false, reason: "approval-unavailable" } as const;

export function createProposeForceTerminate(deps: ProposerDeps): ProposeForceTerminate {
  const { engine, inspector, log } = deps;

  function refuse(code: string): typeof UNAVAILABLE {
    log.warn({ operation: OPERATION, code });
    return UNAVAILABLE;
  }

  return {
    async propose({ runId }) {
      let run: ReturnType<RunInspector["readRun"]>;
      try {
        run = inspector.readRun(runId);
      } catch {
        return refuse("inspector-failed");
      }
      if (run === null) return refuse("run-not-found");
      if (isTerminalRunState(run.state)) return refuse("run-ended");
      if (run.pid === null || run.processStartedAt === null) return refuse("no-process-facts");

      let processName: string | null;
      try {
        processName = await deps.processName(run.pid);
      } catch {
        processName = null;
      }
      let context: ReturnType<ProposerDeps["runContext"]>;
      try {
        context = deps.runContext(runId);
      } catch {
        context = null;
      }
      const projectName = context?.projectName?.trim() ?? "";

      try {
        const outcome = engine.submit({
          operation: OPERATION,
          subject: run.runId,
          requester: REQUESTER,
          projectId: context?.projectId ?? null,
          runId: run.runId,
          reason: REASON,
          payload: {
            runId: run.runId,
            runName: run.displayName.slice(0, RUN_NAME_MAX),
            ...(projectName.length > 0
              ? { projectName: projectName.slice(0, PROJECT_NAME_MAX) }
              : {}),
            processName: (processName ?? FALLBACK_PROCESS_NAME).slice(0, PROCESS_NAME_MAX),
            pid: run.pid,
            processStartedAt: run.processStartedAt,
            stateBefore: run.state,
          },
        });
        if (outcome.kind === "rejected") return refuse(outcome.reason);
        return { ok: true, proposalId: outcome.proposalId };
      } catch {
        // The error text is never read: it could carry a name or a path.
        return refuse("submit-failed");
      }
    },
  };
}
