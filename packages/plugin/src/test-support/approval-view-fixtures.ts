import type { ProposalState } from "@ccc/domain/approval.js";
import type { ApprovalItemView } from "@ccc/domain/approval-view.js";
import type { ApprovalDetailResponse } from "../approvals/api.js";
import { proposalId, summary } from "./approval-fixtures.js";

/**
 * Item-view fixtures for the approval pane tests (plan 06-11). Everything is
 * synthetic: a dashboard requester, a session called `Refactor parser`, the
 * process `claude` with PID 4242. Times are fixed against {@link FIXTURE_NOW_MS}
 * so a rendered phrase never depends on when the test ran.
 */

/** The frozen "now" the pane tests pass as a prop. */
export const FIXTURE_NOW_MS = Date.parse("2026-10-06T12:00:00.000Z");

/** A syntactically valid payload hash (64 lowercase hex characters). */
export const FIXTURE_HASH = "ab12".repeat(16);
/** A different valid hash, for the changed-after-opening cases. */
export const OTHER_HASH = "cd34".repeat(16);

export const RUN_ID = "0mfk1a2b3c4d5e6f7a8b9c0d1";

/** A pending, destructive force-terminate request expiring 14 minutes after the frozen now. */
export function approvalView(overrides: Record<string, unknown> = {}): ApprovalItemView {
  return {
    proposalId: proposalId(1),
    state: "pending",
    revision: 1,
    title: "Force-terminate Refactor parser",
    destructive: true,
    effect: "force-terminate Refactor parser",
    expiresAt: "2026-10-06T12:14:00.000Z",
    requester: { kind: "dashboard", label: "Dashboard" },
    project: "example-project",
    run: { runId: RUN_ID, name: "Refactor parser" },
    action: "Force-terminate the Claude Code session Refactor parser by ending its process.",
    target: [
      { label: "Session", value: "Refactor parser", mono: false },
      { label: "Process", value: "claude · PID 4242", mono: true },
      { label: "Process started", value: "Oct 6, 11:00 AM", mono: false },
    ],
    change: {
      type: "diff",
      origin: "engine",
      lines: [
        { kind: "removed", text: "state: running", count: null },
        { kind: "added", text: "state: cancelled", count: null },
      ],
    },
    reason: {
      origin: "requester",
      shown: "The session stopped responding.",
      full: "The session stopped responding.",
      shortened: false,
    },
    risks: ["Unsaved work in that session is lost.", "The process is ended without a clean exit."],
    checkHint: "Check whether the session's process is still running before asking again.",
    record: {
      requestedAt: "2026-10-06T11:59:00.000Z",
      payloadHash: FIXTURE_HASH,
      fingerprint: FIXTURE_HASH.slice(0, 12),
      decidedAt: null,
      decidedVia: null,
      outcomeCode: null,
      outcomeNote: null,
    },
    history: [{ event: "requested", at: "2026-10-06T11:59:00.000Z" }],
    reviewable: true,
    ...overrides,
  } as unknown as ApprovalItemView;
}

/** The zero-effect test approval: not destructive, no effect sentence, no run. */
export function testApprovalView(overrides: Record<string, unknown> = {}): ApprovalItemView {
  return approvalView({
    title: "Test approval",
    destructive: false,
    effect: null,
    run: null,
    project: null,
    action: "Do nothing. This request exists only to try the approval inbox.",
    target: [],
    change: { type: "none", origin: "engine" },
    risks: [],
    checkHint: null,
    ...overrides,
  });
}

/** `view` as `get` returns it, with a summary in the same state. */
export function approvalDetail(
  view: ApprovalItemView = approvalView(),
  state: ProposalState = view.state,
): ApprovalDetailResponse {
  return {
    summary: summary(1, state, view.revision, { title: view.title, expiresAt: view.expiresAt }),
    view,
    purged: false,
    payloadHash: view.record.payloadHash,
  };
}

/** A decided view: the same request after it moved to `state`. */
export function decidedView(
  state: ProposalState,
  record: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
): ApprovalItemView {
  const base = approvalView();
  return approvalView({
    state,
    revision: base.revision + 2,
    record: {
      ...base.record,
      decidedAt: "2026-10-06T11:59:30.000Z",
      decidedVia: "plugin",
      ...record,
    },
    history: [
      { event: "requested", at: "2026-10-06T11:59:00.000Z" },
      { event: "approved", at: "2026-10-06T11:59:30.000Z" },
    ],
    ...overrides,
  });
}
