import type { ApprovalPublisher } from "@ccc/domain";

// Skeleton for the RED commit: publishes nothing until the GREEN step.
export function createApprovalPublisher(_bus: unknown): ApprovalPublisher {
  return { publish() {} };
}
