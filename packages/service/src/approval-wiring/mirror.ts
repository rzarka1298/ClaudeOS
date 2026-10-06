import type { ApprovalLog, MirrorPort } from "@ccc/domain";

// Skeleton for the RED commit: writes nothing until the GREEN step.
export interface ApprovalMirrorDeps {
  readonly getVaultRoot: () => string | null;
  readonly log: ApprovalLog;
}

export function createApprovalMirror(_deps: ApprovalMirrorDeps): MirrorPort {
  return { mirror: () => Promise.resolve() };
}
