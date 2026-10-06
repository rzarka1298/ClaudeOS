import { timingSafeEqual } from "node:crypto";
import {
  APPROVAL_PENDING_CAP_PER_OPERATION,
  APPROVAL_PENDING_CAP_TOTAL,
  type ApprovalAuditEvent,
  type ApprovalBucket,
  type ApprovalStorePort,
  type AuditRow,
  type ClaimFacts,
  type ClaimResult,
  classifyOperation,
  DECIDED_VIA,
  type DecidedVia,
  type DecideInput,
  type DecideResult,
  dedupeKeyOf,
  type FinishInput,
  type NewProposal,
  type NoteId,
  PAYLOAD_HASH_PATTERN,
  type PendingCaps,
  PROPOSAL_ID_PATTERN,
  PROPOSAL_STATES,
  type ProposalId,
  type ProposalState,
  REQUESTER_KINDS,
  type RequesterKind,
  RequesterSchema,
  type RetryResult,
  type StoredProposal,
  type SubmitResult,
} from "@ccc/domain";
import type Database from "better-sqlite3";

/**
 * The durable half of the approval engine (D-13, research Pattern 3). Every
 * port method is ONE immediate transaction that includes its own audit row, and
 * the port has no method that writes an audit row on its own, so "state and
 * audit disagree" is unrepresentable (APPR-08). Every state change is a
 * compare-and-set on the source state whose changed-row count is checked
 * (APPR-10, T-06-04); the triggers in the approvals migration are the second
 * layer, not a replacement.
 *
 * Time is injected: every method that compares or records a time takes `now`
 * (or the proposal's own timestamps) as an ISO 8601 UTC string with
 * millisecond precision, and this module never reads the clock (T-06-17).
 * Every SQL statement binds its values; no caller string reaches SQL text.
 */

/** Thrown when a caller passes a value the store refuses to write or compare (a malformed time, hash, id or requester). */
export class InvalidApprovalInputError extends Error {
  constructor(field: string) {
    super(`invalid approval input: ${field}`);
    this.name = "InvalidApprovalInputError";
  }
}

/** Thrown when a stored row fails validation: a row is an untrusted-input boundary, the file can be edited. */
export class InvalidApprovalRowError extends Error {
  constructor(field: string) {
    super(`invalid stored approval row: ${field}`);
    this.name = "InvalidApprovalRowError";
  }
}

/** The caps used when a caller does not pass any: the domain constants (D-15, T-06-14). */
const DEFAULT_CAPS: PendingCaps = {
  perOperation: APPROVAL_PENDING_CAP_PER_OPERATION,
  total: APPROVAL_PENDING_CAP_TOTAL,
};

/** The ISO 8601 UTC shape every timestamp here has, so plain string comparison orders instants. */
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isIsoUtc(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_UTC_PATTERN.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function assertIso(value: unknown, field: string): asserts value is string {
  if (!isIsoUtc(value)) throw new InvalidApprovalInputError(field);
}

function assertProposalId(value: unknown, field: string): asserts value is ProposalId {
  if (typeof value !== "string" || !PROPOSAL_ID_PATTERN.test(value)) {
    throw new InvalidApprovalInputError(field);
  }
}

function assertNonEmpty(value: unknown, field: string, max: number): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new InvalidApprovalInputError(field);
  }
}

function assertHash(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !PAYLOAD_HASH_PATTERN.test(value)) {
    throw new InvalidApprovalInputError(field);
  }
}

function validateNewProposal(proposal: NewProposal): void {
  assertProposalId(proposal.proposalId, "proposalId");
  assertNonEmpty(proposal.operation, "operation", 128);
  assertNonEmpty(proposal.subject, "subject", 1024);
  if (proposal.dedupeKey !== dedupeKeyOf(proposal.operation, proposal.subject)) {
    throw new InvalidApprovalInputError("dedupeKey");
  }
  if (!RequesterSchema.safeParse(proposal.requester).success) {
    throw new InvalidApprovalInputError("requester");
  }
  if (proposal.projectId !== null) assertNonEmpty(proposal.projectId, "projectId", 128);
  if (proposal.runId !== null) assertNonEmpty(proposal.runId, "runId", 128);
  if (typeof proposal.reason !== "string") throw new InvalidApprovalInputError("reason");
  if (typeof proposal.payloadJson !== "string" || proposal.payloadJson.length === 0) {
    throw new InvalidApprovalInputError("payloadJson");
  }
  assertHash(proposal.payloadHash, "payloadHash");
  assertIso(proposal.createdAt, "createdAt");
  assertIso(proposal.expiresAt, "expiresAt");
  if (proposal.expiresAt <= proposal.createdAt) throw new InvalidApprovalInputError("expiresAt");
  assertNonEmpty(proposal.mirrorNoteId, "mirrorNoteId", 128);
  if (proposal.supersedes !== null) assertProposalId(proposal.supersedes, "supersedes");
}

function validateCaps(caps: PendingCaps): void {
  if (
    !Number.isInteger(caps.perOperation) ||
    !Number.isInteger(caps.total) ||
    caps.perOperation < 0 ||
    caps.total < 0
  ) {
    throw new InvalidApprovalInputError("caps");
  }
}

/** Constant-time comparison of two hashes, so a wrong hash leaks nothing about the stored one. */
function hashesEqual(supplied: string, stored: string): boolean {
  const a = Buffer.from(supplied, "utf8");
  const b = Buffer.from(stored, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

interface ProposalRow {
  proposal_id: string;
  operation: string;
  subject: string;
  state: string;
  requester_kind: string;
  requester_label: string;
  project_id: string | null;
  run_id: string | null;
  reason: string;
  payload_json: string | null;
  payload_hash: string;
  dedupe_key: string;
  mirror_note_id: string;
  created_at: string;
  expires_at: string;
  approved_at: string | null;
  decided_at: string | null;
  decided_via: string | null;
  claimed_at: string | null;
  claim_facts_json: string | null;
  finished_at: string | null;
  attempts: number;
  outcome_code: string | null;
  outcome_note: string | null;
  supersedes: string | null;
  revision: number;
}

function isProposalState(value: string): value is ProposalState {
  return (PROPOSAL_STATES as readonly string[]).includes(value);
}

function isRequesterKind(value: string): value is RequesterKind {
  return (REQUESTER_KINDS as readonly string[]).includes(value);
}

function isDecidedVia(value: string): value is DecidedVia {
  return (DECIDED_VIA as readonly string[]).includes(value);
}

function parseClaimFacts(json: string): ClaimFacts {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new InvalidApprovalRowError("claim_facts_json");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InvalidApprovalRowError("claim_facts_json");
  }
  const facts: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      throw new InvalidApprovalRowError("claim_facts_json");
    }
    facts[key] = value;
  }
  return facts;
}

/** True only for an approval-required operation whose row is `enabled`; reserved, no-approval and unknown names are false. */
function isEnabledApprovalOperation(operation: string): boolean {
  const row = classifyOperation(operation)?.row;
  return row !== undefined && row.class === "approval-required" && row.status === "enabled";
}

function rowToProposal(row: ProposalRow): StoredProposal {
  if (!isProposalState(row.state)) throw new InvalidApprovalRowError("state");
  if (!isRequesterKind(row.requester_kind)) throw new InvalidApprovalRowError("requester_kind");
  if (row.decided_via !== null && !isDecidedVia(row.decided_via)) {
    throw new InvalidApprovalRowError("decided_via");
  }
  return {
    proposalId: row.proposal_id as ProposalId,
    operation: row.operation,
    subject: row.subject,
    dedupeKey: row.dedupe_key,
    requester: { kind: row.requester_kind, label: row.requester_label },
    projectId: row.project_id,
    runId: row.run_id,
    reason: row.reason,
    payloadJson: row.payload_json,
    payloadHash: row.payload_hash,
    state: row.state,
    revision: row.revision,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    approvedAt: row.approved_at,
    decidedAt: row.decided_at,
    decidedVia: row.decided_via,
    claimFacts: row.claim_facts_json === null ? null : parseClaimFacts(row.claim_facts_json),
    attempts: row.attempts,
    outcomeCode: row.outcome_code,
    outcomeNote: row.outcome_note,
    mirrorNoteId: row.mirror_note_id as NoteId,
    supersedes: row.supersedes as ProposalId | null,
  };
}

/** Thrown by a port method a later task of this plan has not implemented yet. */
export class ApprovalStoreNotImplementedError extends Error {
  constructor(method: string) {
    super(`approval store method not implemented: ${method}`);
    this.name = "ApprovalStoreNotImplementedError";
  }
}

export type ApprovalStore = ApprovalStorePort;

/**
 * Builds the store over a migrated database. The tables must already exist
 * (call `applyMigrations` first): the statements are prepared here.
 */
export function createApprovalStore(db: Database.Database): ApprovalStore {
  const selectById = db.prepare("SELECT * FROM proposals WHERE proposal_id = ?");
  const selectPendingByDedupe = db.prepare(
    "SELECT * FROM proposals WHERE dedupe_key = ? AND state = 'pending'",
  );
  const countPendingForOperation = db.prepare(
    "SELECT count(*) AS n FROM proposals WHERE state = 'pending' AND operation = ?",
  );
  const countPendingTotal = db.prepare(
    "SELECT count(*) AS n FROM proposals WHERE state = 'pending'",
  );
  // The most recent expired request with this key that no later request already supersedes (APPR-06, D-08).
  const selectSupersedable = db.prepare(
    `SELECT proposal_id FROM proposals AS p
     WHERE p.dedupe_key = ? AND p.state = 'expired'
       AND NOT EXISTS (SELECT 1 FROM proposals AS q WHERE q.supersedes = p.proposal_id)
     ORDER BY p.created_at DESC, p.rowid DESC LIMIT 1`,
  );
  const insertProposal = db.prepare(
    `INSERT INTO proposals (
       proposal_id, operation, subject, state, requester_kind, requester_label, project_id, run_id,
       reason, payload_json, payload_hash, dedupe_key, mirror_note_id, created_at, expires_at,
       supersedes, attempts, revision
     ) VALUES (
       @proposalId, @operation, @subject, 'pending', @requesterKind, @requesterLabel, @projectId, @runId,
       @reason, @payloadJson, @payloadHash, @dedupeKey, @mirrorNoteId, @createdAt, @expiresAt,
       @supersedes, 0, 1
     )`,
  );
  const insertAudit = db.prepare(
    `INSERT INTO approval_audit (proposal_id, event, at, decided_via, payload_hash, detail)
     VALUES (@proposalId, @event, @at, @decidedVia, @payloadHash, @detail)`,
  );
  const expireOne = db.prepare(
    `UPDATE proposals SET state = 'expired', decided_at = @now, revision = revision + 1
     WHERE proposal_id = @proposalId AND state = 'pending'`,
  );
  const decideOne = db.prepare(
    `UPDATE proposals
     SET state = @state, approved_at = @approvedAt, decided_at = @now, decided_via = @via,
         revision = revision + 1
     WHERE proposal_id = @proposalId AND state = 'pending'`,
  );

  /** Runs `fn` as one write transaction taken up front, so two connections racing a read-then-write queue instead of failing. */
  function immediate<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    const transaction = db.transaction(fn);
    return (...args: A) => transaction.immediate(...args);
  }

  function readRow(proposalId: string): ProposalRow | undefined {
    return selectById.get(proposalId) as ProposalRow | undefined;
  }

  function mustRead(proposalId: string): StoredProposal {
    const row = readRow(proposalId);
    if (!row) throw new InvalidApprovalRowError("proposal vanished inside its own transaction");
    return rowToProposal(row);
  }

  function writeAudit(
    proposalId: string,
    event: ApprovalAuditEvent,
    at: string,
    decidedVia: DecidedVia | null,
    payloadHash: string | null,
    detail: string | null,
  ): void {
    insertAudit.run({ proposalId, event, at, decidedVia, payloadHash, detail });
  }

  const submitTx = immediate((proposal: NewProposal, caps: PendingCaps): SubmitResult => {
    const existing = selectPendingByDedupe.get(proposal.dedupeKey) as ProposalRow | undefined;
    if (existing) return { kind: "deduped", proposal: rowToProposal(existing) };

    const forOperation = (countPendingForOperation.get(proposal.operation) as { n: number }).n;
    if (forOperation >= caps.perOperation) return { kind: "capped", scope: "operation" };
    const total = (countPendingTotal.get() as { n: number }).n;
    if (total >= caps.total) return { kind: "capped", scope: "total" };

    let supersedes: string | null = proposal.supersedes;
    if (supersedes === null) {
      const previous = selectSupersedable.get(proposal.dedupeKey) as
        | { proposal_id: string }
        | undefined;
      supersedes = previous ? previous.proposal_id : null;
    }

    insertProposal.run({
      proposalId: proposal.proposalId,
      operation: proposal.operation,
      subject: proposal.subject,
      requesterKind: proposal.requester.kind,
      requesterLabel: proposal.requester.label,
      projectId: proposal.projectId,
      runId: proposal.runId,
      reason: proposal.reason,
      payloadJson: proposal.payloadJson,
      payloadHash: proposal.payloadHash,
      dedupeKey: proposal.dedupeKey,
      mirrorNoteId: proposal.mirrorNoteId,
      createdAt: proposal.createdAt,
      expiresAt: proposal.expiresAt,
      supersedes,
    });
    writeAudit(
      proposal.proposalId,
      "requested",
      proposal.createdAt,
      null,
      proposal.payloadHash,
      null,
    );
    return { kind: "created", proposal: mustRead(proposal.proposalId) };
  });

  const decideTx = immediate((input: DecideInput): DecideResult => {
    const row = readRow(input.proposalId);
    if (!row) return { kind: "not-found" };
    // A repeated decision on a settled request reports its state BEFORE any expiry handling, so a
    // second decide after the deadline never attempts a transition to expired (D-14, D-16).
    if (row.state !== "pending") {
      if (!isProposalState(row.state)) throw new InvalidApprovalRowError("state");
      return { kind: "already-decided", state: row.state };
    }

    if (input.now >= row.expires_at) {
      const expired = expireOne.run({ proposalId: row.proposal_id, now: input.now });
      if (expired.changes !== 1) return currentStateResult(row.proposal_id);
      writeAudit(row.proposal_id, "expired", input.now, null, row.payload_hash, null);
      return { kind: "expired", proposal: mustRead(row.proposal_id) };
    }

    // Defense in depth for T-06-15: a row for a reserved, non-approval or unknown operation is never decided.
    if (!isEnabledApprovalOperation(row.operation)) return { kind: "operation-reserved" };

    if (!hashesEqual(input.expectedHash, row.payload_hash)) return { kind: "hash-mismatch" };

    const approve = input.decision === "approve";
    const changed = decideOne.run({
      proposalId: row.proposal_id,
      state: approve ? "approved" : "denied",
      approvedAt: approve ? input.now : null,
      now: input.now,
      via: input.via,
    });
    if (changed.changes !== 1) return currentStateResult(row.proposal_id);
    writeAudit(
      row.proposal_id,
      approve ? "approved" : "denied",
      input.now,
      input.via,
      row.payload_hash,
      null,
    );
    const proposal = mustRead(row.proposal_id);
    return approve ? { kind: "approved", proposal } : { kind: "denied", proposal };
  });

  /** A compare-and-set that lost: report whatever the row now says, never throw. */
  function currentStateResult(proposalId: string): DecideResult {
    const row = readRow(proposalId);
    if (!row) return { kind: "not-found" };
    if (!isProposalState(row.state)) throw new InvalidApprovalRowError("state");
    return { kind: "already-decided", state: row.state };
  }

  return {
    submit(proposal: NewProposal, caps: PendingCaps = DEFAULT_CAPS): SubmitResult {
      validateNewProposal(proposal);
      validateCaps(caps);
      return submitTx(proposal, caps);
    },
    get(proposalId: ProposalId): StoredProposal | null {
      const row = readRow(proposalId);
      return row ? rowToProposal(row) : null;
    },
    decide(input: DecideInput): DecideResult {
      assertProposalId(input.proposalId, "proposalId");
      assertIso(input.now, "now");
      if (typeof input.expectedHash !== "string")
        throw new InvalidApprovalInputError("expectedHash");
      if (input.decision !== "approve" && input.decision !== "deny") {
        throw new InvalidApprovalInputError("decision");
      }
      if (!isDecidedVia(input.via)) throw new InvalidApprovalInputError("via");
      return decideTx(input);
    },
    list(_bucket: ApprovalBucket, _limit: number): StoredProposal[] {
      throw new ApprovalStoreNotImplementedError("list");
    },
    counts() {
      throw new ApprovalStoreNotImplementedError("counts");
    },
    claim(_proposalId: ProposalId, _facts: ClaimFacts, _now: string): ClaimResult {
      throw new ApprovalStoreNotImplementedError("claim");
    },
    beginRetry(_proposalId: ProposalId, _now: string): RetryResult {
      throw new ApprovalStoreNotImplementedError("beginRetry");
    },
    finish(_input: FinishInput): StoredProposal | null {
      throw new ApprovalStoreNotImplementedError("finish");
    },
    expireDue(_now: string): ProposalId[] {
      throw new ApprovalStoreNotImplementedError("expireDue");
    },
    lapseStaleApproved(): ProposalId[] {
      throw new ApprovalStoreNotImplementedError("lapseStaleApproved");
    },
    listExecuting(): StoredProposal[] {
      throw new ApprovalStoreNotImplementedError("listExecuting");
    },
    listApprovedUnclaimed(): StoredProposal[] {
      throw new ApprovalStoreNotImplementedError("listApprovedUnclaimed");
    },
    withdraw(_proposalId: ProposalId, _now: string): StoredProposal | null {
      throw new ApprovalStoreNotImplementedError("withdraw");
    },
    purgeDecidedPayloads(_before: string): number {
      throw new ApprovalStoreNotImplementedError("purgeDecidedPayloads");
    },
    auditFor(_proposalId: ProposalId): AuditRow[] {
      throw new ApprovalStoreNotImplementedError("auditFor");
    },
  };
}
