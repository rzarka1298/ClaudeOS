import type { ApprovalLog, ProposeForceTerminate, RunInspector } from "@ccc/domain";
import type { ApprovalEngine } from "../approval/index.js";

/** Skeleton (RED): the engine-backed proposer follows in the GREEN commit. */
export interface ProposerDeps {
  readonly engine: Pick<ApprovalEngine, "submit">;
  readonly inspector: RunInspector;
  readonly runContext: (
    runId: string,
  ) => { readonly projectId: string | null; readonly projectName: string | null } | null;
  readonly processName: (pid: number) => Promise<string | null>;
  readonly log: ApprovalLog;
}

export function createProposeForceTerminate(_deps: ProposerDeps): ProposeForceTerminate {
  return { propose: async () => ({ ok: false, reason: "approval-unavailable" }) };
}
