import type { ApprovalSummary, ApprovalsSnapshot, ProposalState } from "@ccc/domain";

/**
 * Approval fixtures for the plugin tests (plan 06-10). Ids are the 25
 * lowercase alphanumerics the domain pattern requires.
 */

/** A valid proposal id, varied by `n`. */
export function proposalId(n: number): string {
  return `0mfk1a2b3c4d5e6f7a8b9c${String(n).padStart(3, "0")}`;
}

export function summary(
  n: number,
  state: ProposalState = "pending",
  revision = 1,
  overrides: Record<string, unknown> = {},
): ApprovalSummary {
  return {
    proposalId: proposalId(n),
    state,
    revision,
    title: `Test approval ${n}`,
    operationLabel: "Test approval",
    requesterKind: "dashboard",
    requesterLabel: "Dashboard",
    projectName: null,
    runId: null,
    createdAt: "2026-10-06T10:00:00.000Z",
    expiresAt: "2026-10-07T10:00:00.000Z",
    decidedAt: null,
    outcomeCode: null,
    ...overrides,
  } as unknown as ApprovalSummary;
}

export function approvalsSnapshot(
  parts: {
    pending?: readonly ApprovalSummary[];
    decided?: readonly ApprovalSummary[];
    expired?: readonly ApprovalSummary[];
    ready?: boolean;
    truncated?: boolean;
    counts?: { pending: number; decided: number; expired: number };
  } = {},
): ApprovalsSnapshot {
  const pending = [...(parts.pending ?? [])];
  const decided = [...(parts.decided ?? [])];
  const expired = [...(parts.expired ?? [])];
  return {
    ready: parts.ready ?? true,
    pending,
    decided,
    expired,
    counts: parts.counts ?? {
      pending: pending.length,
      decided: decided.length,
      expired: expired.length,
    },
    truncated: parts.truncated ?? false,
  };
}
