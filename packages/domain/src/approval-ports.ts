import type {
  ApprovalAuditEvent,
  ApprovalDecision,
  ApprovalUpsertedPayload,
  DecidedVia,
  PresenceRefusalDetail,
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
  /**
   * The decision proof written when the request was approved (09-16, D-03): strict JSON
   * `{ v: 1, mac, presence }`, or null for every row that was not approved with one. Both stores always
   * set it (a string after a signed approve, `null` otherwise); it is optional in the type only so older
   * row factories keep compiling. An absent value is treated exactly like `null`: it fails verification
   * (fail closed). The service verifies it; the domain only carries it.
   */
  readonly decisionProof?: string | null;
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
  /**
   * The instant the owner vouched for the approval (D-01): fixed before a presence prompt, so it can be
   * earlier than `now`. Absent, the store records `now` as before. Never later than `now`. The expiry
   * check still runs against `now`, so a request that lapsed while the prompt was up is expired.
   */
  readonly approvedAt?: string;
  /**
   * The decision proof for an approving decision (09-16, D-03), made by the service for exactly this
   * row, instant and channel. Written only when approving and only in the update that moves the row to
   * approved; ignored on a deny. Absent, an approved row is stored with no proof and fails verification.
   * The store treats it as opaque text of 1 to 2048 characters and validates nothing else; the service
   * checks its shape and MAC.
   */
  readonly decisionProof?: string;
}

/** What the engine hands the store to put a presence refusal on the record. */
export interface DecisionRefusalInput {
  readonly proposalId: ProposalId;
  readonly at: string;
  /** The payload hash the owner was asked to approve. */
  readonly payloadHash: string;
  readonly detail: PresenceRefusalDetail;
}

export type DecideResult =
  | { readonly kind: "approved"; readonly proposal: StoredProposal }
  | { readonly kind: "denied"; readonly proposal: StoredProposal }
  | { readonly kind: "expired"; readonly proposal: StoredProposal }
  | { readonly kind: "hash-mismatch" }
  | { readonly kind: "already-decided"; readonly state: ProposalState }
  | { readonly kind: "not-found" }
  /** The stored operation is reserved, not an approval-required operation, or unknown: nothing is decided (T-06-15). */
  | { readonly kind: "operation-reserved" };

export type ClaimResult =
  | { readonly kind: "claimed"; readonly proposal: StoredProposal }
  | { readonly kind: "lost" };

export type RetryResult =
  | { readonly kind: "retrying"; readonly proposal: StoredProposal }
  /** The row is not in `executing`, so there is nothing to retry. */
  | { readonly kind: "not-executing" }
  /** Two attempts are already recorded: never a third (D-17). */
  | { readonly kind: "exhausted" }
  /** Another caller changed the attempt count first. */
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
 * its own, so "state and audit disagree" is unrepresentable (D-13, Pitfall 2). The one
 * exception, `recordDecisionRefusal`, records a refusal that changes no state (09-14).
 * Every state change is a compare-and-set on the source state; losing the race
 * returns a result, never an exception.
 */
export interface ApprovalStorePort {
  submit(proposal: NewProposal, caps: PendingCaps): SubmitResult;
  get(proposalId: ProposalId): StoredProposal | null;
  list(bucket: ApprovalBucket, limit: number): StoredProposal[];
  counts(): { readonly pending: number; readonly decided: number; readonly expired: number };
  decide(input: DecideInput): DecideResult;
  /**
   * Puts a refused presence-required approve on the record: one `presence-refused` audit row with the
   * refusal as its detail, no state or revision change. `not-pending` (and nothing written) when the
   * request is no longer pending; `suppressed` (nothing written) when the refusal repeats one already
   * on the record inside the window or the proposal's refusal rows are at their cap, so a caller
   * looping on a pending request cannot grow the append-only trail (see `presenceRefusalIsRecordable`).
   */
  recordDecisionRefusal(input: DecisionRefusalInput): "recorded" | "suppressed" | "not-pending";
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

// ---------------------------------------------------------------------------
// Presence (D-01, D-02, R-02): the owner's verified presence at an approval

/** What the presence check is asked to vouch for: one proposal, one operation, one payload, one approval instant. */
export interface PresenceRequest {
  readonly proposalId: ProposalId;
  readonly operation: string;
  /** The payload hash the owner approved, lowercase hex. */
  readonly payloadHash: string;
  /** When the approval was given, ISO 8601 UTC. */
  readonly approvedAt: string;
}

/**
 * The closed answer of a presence check. `proved` carries the proof scheme and its signature (null
 * under the `none` scheme); `denied` means the owner did not give the gesture; `unavailable` means
 * the check cannot run on this machine right now. Nothing here is a standing choice.
 */
export type PresenceResult =
  /** The owner's gesture produced a P-256 signature over the exact approval message (custody K-SE / K-ATTR). */
  | { readonly kind: "proved"; readonly scheme: "p256"; readonly signature: string }
  /** The check alone, no key (custody K-SVC): there is no signature to carry. */
  | { readonly kind: "proved"; readonly scheme: "none"; readonly signature: null }
  | { readonly kind: "denied" }
  | { readonly kind: "unavailable" };

/** Whether the presence check could run at all, without asking the owner for anything. */
export type PresenceAvailability = "available" | "unavailable";

/** The port the engine asks to verify the owner's presence. Types only; the helper adapter lives in the service. */
export interface PresencePort {
  prove(request: PresenceRequest): Promise<PresenceResult>;
  availability(): Promise<PresenceAvailability>;
}
