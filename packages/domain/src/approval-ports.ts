import type {
  ApprovalAuditEvent,
  ApprovalDecision,
  ApprovalUpsertedPayload,
  DecidedVia,
  ProposalId,
  ProposalState,
  Requester,
} from "./approval.js";
import type { ClaimFacts } from "./approval-operations.js";
import type { NoteId } from "./ids.js";
import type { RunState } from "./run.js";

/**
 * The ports the approval engine depends on (D-01, D-13, D-17, D-22, D-43).
 * Types only: no runtime export, no `node:` import. The engine imports nothing
 * but `@ccc/domain`, so the store, the mirror, the run inspector, the
 * diagnostic effect, the logger and the publisher are all injected, and every
 * one of them can be replaced by an in-memory fake in a test.
 */

/** Wall-clock time as an ISO 8601 UTC string with millisecond precision (`...Z`), so plain string comparison orders instants. */
export interface Clock {
  now(): string;
}

/** The proposal as the store holds it. The payload text is the source of truth for what runs. */
export interface StoredProposal {
  readonly proposalId: ProposalId;
  readonly operation: string;
  readonly subject: string;
  readonly dedupeKey: string;
  readonly requester: Requester;
  readonly projectId: string | null;
  readonly runId: string | null;
  readonly reason: string;
  /** The canonical payload text, or null once the decided payload was purged (D-19). */
  readonly payloadJson: string | null;
  /** SHA-256 of the canonical envelope, computed once at submit. */
  readonly payloadHash: string;
  readonly state: ProposalState;
  /** Increments on every state change, so a client can discard a stale event. */
  readonly revision: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly approvedAt: string | null;
  readonly decidedAt: string | null;
  readonly decidedVia: DecidedVia | null;
  readonly claimFacts: ClaimFacts | null;
  readonly attempts: number;
  readonly outcomeCode: string | null;
  readonly outcomeNote: string | null;
  /** The read-only mirror note's id, minted once at submit so the note keeps its identity. */
  readonly mirrorNoteId: NoteId;
  /** The earlier request this one replaces after an expiry, or null. */
  readonly supersedes: ProposalId | null;
}

/** What the engine hands the store to create a proposal. State and revision are the store's. */
export interface NewProposal {
  readonly proposalId: ProposalId;
  readonly operation: string;
  readonly subject: string;
  readonly dedupeKey: string;
  readonly requester: Requester;
  readonly projectId: string | null;
  readonly runId: string | null;
  readonly reason: string;
  readonly payloadJson: string;
  readonly payloadHash: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly mirrorNoteId: NoteId;
  readonly supersedes: ProposalId | null;
}

export interface PendingCaps {
  readonly perOperation: number;
  readonly total: number;
}

export type SubmitResult =
  | { readonly kind: "created"; readonly proposal: StoredProposal }
  | { readonly kind: "deduped"; readonly proposal: StoredProposal }
  | { readonly kind: "capped"; readonly scope: "operation" | "total" };

export interface DecideInput {
  readonly proposalId: ProposalId;
  readonly decision: ApprovalDecision;
  /** The full hash of the content the owner saw. */
  readonly expectedHash: string;
  readonly now: string;
  readonly via: DecidedVia;
}

export type DecideResult =
  | { readonly kind: "approved"; readonly proposal: StoredProposal }
  | { readonly kind: "denied"; readonly proposal: StoredProposal }
  | { readonly kind: "expired"; readonly proposal: StoredProposal }
  | { readonly kind: "hash-mismatch" }
  | { readonly kind: "already-decided"; readonly state: ProposalState }
  | { readonly kind: "not-found" };

export type ClaimResult =
  | { readonly kind: "claimed"; readonly proposal: StoredProposal }
  | { readonly kind: "lost" };

export type RetryResult =
  | { readonly kind: "retrying"; readonly proposal: StoredProposal }
  | { readonly kind: "lost" };

export interface FinishInput {
  readonly proposalId: ProposalId;
  readonly state: "executed" | "failed" | "unknown";
  /** A fixed-vocabulary outcome code, never free text. */
  readonly code: string;
  readonly note: string | null;
  /** The reconcile evidence code when the outcome was proven by reconciliation. */
  readonly evidence: string | null;
  /** True when `reconcile` (not `execute`) established the outcome. */
  readonly reconciled: boolean;
  readonly now: string;
}

export interface AuditRow {
  readonly event: ApprovalAuditEvent;
  readonly at: string;
  readonly code: string | null;
}

export type ApprovalBucket = "pending" | "decided" | "expired";

/**
 * The persistence port. Synchronous: it is implemented over better-sqlite3 in
 * the operational store. Every method is ONE transaction that includes its own
 * audit row, and there is deliberately no method that writes an audit row on
 * its own, so "state and audit disagree" is unrepresentable (D-13, Pitfall 2).
 * Every state change is a compare-and-set on the source state; losing the race
 * returns a result, never an exception.
 */
export interface ApprovalStorePort {
  submit(proposal: NewProposal, caps: PendingCaps): SubmitResult;
  get(proposalId: ProposalId): StoredProposal | null;
  list(bucket: ApprovalBucket, limit: number): StoredProposal[];
  counts(): { readonly pending: number; readonly decided: number; readonly expired: number };
  decide(input: DecideInput): DecideResult;
  /** `approved` to `executing`: the single-use claim, recording the facts gathered beforehand. */
  claim(proposalId: ProposalId, facts: ClaimFacts, now: string): ClaimResult;
  /** The one retry after a restart: attempt 2, with the same idempotency key. */
  beginRetry(proposalId: ProposalId, now: string): RetryResult;
  finish(input: FinishInput): StoredProposal | null;
  /** Denies every pending request past its expiry. Returns the ids it changed. */
  expireDue(now: string): ProposalId[];
  /** Lapses approved-but-unclaimed requests older than their operation's maximum approval age. */
  lapseStaleApproved(
    now: string,
    maxAgeMsByOperation: Readonly<Record<string, number>>,
  ): ProposalId[];
  listExecuting(): StoredProposal[];
  listApprovedUnclaimed(): StoredProposal[];
  withdraw(proposalId: ProposalId, now: string): StoredProposal | null;
  /** Clears the payload text of decided proposals older than the cutoff. Audit rows are never touched. */
  purgeDecidedPayloads(before: string): number;
  auditFor(proposalId: ProposalId): AuditRow[];
}

/** Writes the read-only mirror note. Best-effort and templated; its result is never read back (D-22). */
export interface MirrorPort {
  mirror(proposal: StoredProposal): Promise<void>;
}

/** The facts about a Run the engine's operations need. */
export interface RunFacts {
  readonly runId: string;
  readonly state: RunState;
  readonly displayName: string;
  readonly pid: number | null;
  /** The recorded start time of the process, or null when unknown. */
  readonly processStartedAt: string | null;
}

/** `gone`: no such process. `same`: alive with the expected start time. `different`: alive, but a reused pid. */
export type ProcessStatus = "gone" | "same" | "different";

export interface RunInspector {
  readRun(runId: string): RunFacts | null;
  processStatus(pid: number, expectedStartedAt: string): Promise<ProcessStatus>;
}

/** The effect of the zero-impact test operation: one row per proposal id, so tests count executions and effects apart. */
export interface DiagnosticEffectsPort {
  record(proposalId: ProposalId): "recorded" | "already-recorded";
  exists(proposalId: ProposalId): boolean;
}

/** A minimal structured-logger shape, so the engine never imports the service logger. */
export interface ApprovalLog {
  info(fields: Readonly<Record<string, unknown>>, message?: string): void;
  warn(fields: Readonly<Record<string, unknown>>, message?: string): void;
  error(fields: Readonly<Record<string, unknown>>, message?: string): void;
}

/** Announces a changed request to connected clients. Carries a summary only, never a payload (D-28). */
export interface ApprovalPublisher {
  publish(event: "approval.upserted", payload: ApprovalUpsertedPayload): void;
}
