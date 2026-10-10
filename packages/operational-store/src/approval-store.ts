import { timingSafeEqual } from "node:crypto";
import {
  APPROVAL_AUDIT_EVENTS,
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
  type DiagnosticEffectsPort,
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

/** The most characters the claim facts may serialise to; the facts are a pid and a start time, never a document. */
const CLAIM_FACTS_MAX_CHARS = 4096;

function serialiseClaimFacts(facts: ClaimFacts): string {
  if (typeof facts !== "object" || facts === null || Array.isArray(facts)) {
    throw new InvalidApprovalInputError("claimFacts");
  }
  for (const value of Object.values(facts)) {
    const ok =
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value));
    if (!ok) throw new InvalidApprovalInputError("claimFacts");
  }
  const json = JSON.stringify(facts);
  if (json.length > CLAIM_FACTS_MAX_CHARS) throw new InvalidApprovalInputError("claimFacts");
  return json;
}

/** An outcome code, evidence code or note: a short fixed-vocabulary token, never free text (APPR-08). */
const OUTCOME_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

function assertOutcomeCode(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !OUTCOME_CODE_PATTERN.test(value)) {
    throw new InvalidApprovalInputError(field);
  }
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

function isAuditEvent(value: string): value is ApprovalAuditEvent {
  return (APPROVAL_AUDIT_EVENTS as readonly string[]).includes(value);
}

const BUCKETS = ["pending", "decided", "expired"] as const satisfies readonly ApprovalBucket[];

/** The most audit events one read returns; a request never has more than a handful. */
const AUDIT_READ_LIMIT = 20;

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

/**
 * The store as built here: the domain port, with the pending caps optional on
 * `submit` (they default to the domain constants). It remains assignable to
 * {@link ApprovalStorePort}, which the tests assert at compile time.
 */
export type ApprovalStore = Omit<ApprovalStorePort, "submit"> & {
  submit(proposal: NewProposal, caps?: PendingCaps): SubmitResult;
};

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

  const claimOne = db.prepare(
    `UPDATE proposals
     SET state = 'executing', claimed_at = @now, claim_facts_json = @facts, attempts = 1,
         revision = revision + 1
     WHERE proposal_id = @proposalId AND state = 'approved'`,
  );
  const retryOne = db.prepare(
    `UPDATE proposals SET attempts = attempts + 1, revision = revision + 1
     WHERE proposal_id = @proposalId AND state = 'executing' AND attempts = @expectedAttempts`,
  );
  const finishOne = db.prepare(
    `UPDATE proposals
     SET state = @state, outcome_code = @code, outcome_note = @note, finished_at = @now,
         revision = revision + 1
     WHERE proposal_id = @proposalId AND state = 'executing'`,
  );
  const withdrawOne = db.prepare(
    `UPDATE proposals SET state = 'withdrawn', decided_at = @now, revision = revision + 1
     WHERE proposal_id = @proposalId AND state = 'pending'`,
  );
  const insertAttempt = db.prepare(
    `INSERT INTO approval_executions (proposal_id, attempt, started_at)
     VALUES (@proposalId, @attempt, @startedAt)`,
  );
  const finishAttempt = db.prepare(
    `UPDATE approval_executions SET finished_at = @now, result_code = @code
     WHERE proposal_id = @proposalId AND attempt = @attempt AND finished_at IS NULL`,
  );

  const lapseOne = db.prepare(
    `UPDATE proposals SET state = 'lapsed', decided_at = @now, revision = revision + 1
     WHERE proposal_id = @proposalId AND state = 'approved'`,
  );
  const selectDue = db.prepare(
    `SELECT * FROM proposals WHERE state = 'pending' AND expires_at <= ?
     ORDER BY expires_at ASC, rowid ASC`,
  );
  const selectApprovedUnclaimed = db.prepare(
    "SELECT * FROM proposals WHERE state = 'approved' ORDER BY approved_at ASC, rowid ASC",
  );
  const selectExecuting = db.prepare(
    "SELECT * FROM proposals WHERE state = 'executing' ORDER BY claimed_at ASC, rowid ASC",
  );
  const listPending = db.prepare(
    `SELECT * FROM proposals WHERE state = 'pending'
     ORDER BY expires_at ASC, created_at ASC, rowid ASC LIMIT ?`,
  );
  // "Decided" is every state past pending that is not an expiry; most recent change first.
  const listDecided = db.prepare(
    `SELECT * FROM proposals
     WHERE state IN ('approved', 'executing', 'executed', 'failed', 'unknown', 'denied', 'withdrawn', 'lapsed')
     ORDER BY COALESCE(finished_at, claimed_at, decided_at, created_at) DESC, rowid DESC LIMIT ?`,
  );
  const listExpired = db.prepare(
    "SELECT * FROM proposals WHERE state = 'expired' ORDER BY expires_at DESC, rowid DESC LIMIT ?",
  );
  const countByState = db.prepare("SELECT state, count(*) AS n FROM proposals GROUP BY state");
  const purgeOlder = db.prepare(
    `UPDATE proposals SET payload_json = NULL
     WHERE payload_json IS NOT NULL
       AND state IN ('denied', 'expired', 'withdrawn', 'lapsed', 'executed', 'failed', 'unknown')
       AND COALESCE(finished_at, decided_at, created_at) < ?`,
  );
  const selectAudit = db.prepare(
    `SELECT event, at, detail FROM (
       SELECT seq, event, at, detail FROM approval_audit WHERE proposal_id = ? ORDER BY seq DESC LIMIT ?
     ) ORDER BY seq ASC`,
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

  const claimTx = immediate((proposalId: ProposalId, facts: string, now: string): ClaimResult => {
    const changed = claimOne.run({ proposalId, facts, now });
    if (changed.changes !== 1) return { kind: "lost" };
    insertAttempt.run({ proposalId, attempt: 1, startedAt: now });
    const proposal = mustRead(proposalId);
    writeAudit(proposalId, "claimed", now, null, proposal.payloadHash, null);
    return { kind: "claimed", proposal };
  });

  const retryTx = immediate((proposalId: ProposalId, now: string): RetryResult => {
    const row = readRow(proposalId);
    if (row?.state !== "executing") return { kind: "not-executing" };
    if (row.attempts >= 2) return { kind: "exhausted" };
    const changed = retryOne.run({ proposalId, expectedAttempts: row.attempts });
    if (changed.changes !== 1) return { kind: "lost" };
    insertAttempt.run({ proposalId, attempt: row.attempts + 1, startedAt: now });
    writeAudit(proposalId, "retried-after-restart", now, null, row.payload_hash, null);
    return { kind: "retrying", proposal: mustRead(proposalId) };
  });

  const finishTx = immediate((input: FinishInput): StoredProposal | null => {
    const row = readRow(input.proposalId);
    if (row?.state !== "executing") return null;
    const changed = finishOne.run({
      proposalId: input.proposalId,
      state: input.state,
      code: input.code,
      note: input.note,
      now: input.now,
    });
    if (changed.changes !== 1) return null;
    finishAttempt.run({
      proposalId: input.proposalId,
      attempt: row.attempts,
      now: input.now,
      code: input.code,
    });
    const event: ApprovalAuditEvent =
      input.state === "executed"
        ? input.reconciled
          ? "reconciled-executed"
          : "executed"
        : input.state === "failed"
          ? "failed"
          : "outcome-unknown";
    writeAudit(
      input.proposalId,
      event,
      input.now,
      null,
      row.payload_hash,
      input.evidence ?? input.code,
    );
    return mustRead(input.proposalId);
  });

  const withdrawTx = immediate((proposalId: ProposalId, now: string): StoredProposal | null => {
    const row = readRow(proposalId);
    if (!row) return null;
    const changed = withdrawOne.run({ proposalId, now });
    if (changed.changes !== 1) return null;
    writeAudit(proposalId, "withdrawn", now, null, row.payload_hash, null);
    return mustRead(proposalId);
  });

  const expireDueTx = immediate((now: string): ProposalId[] => {
    const expired: ProposalId[] = [];
    for (const row of selectDue.all(now) as ProposalRow[]) {
      const changed = expireOne.run({ proposalId: row.proposal_id, now });
      if (changed.changes !== 1) continue;
      writeAudit(row.proposal_id, "expired", now, null, row.payload_hash, null);
      expired.push(row.proposal_id as ProposalId);
    }
    return expired;
  });

  const lapseTx = immediate(
    (now: string, maxAgeMsByOperation: Readonly<Record<string, number>>): ProposalId[] => {
      const nowMs = Date.parse(now);
      const lapsed: ProposalId[] = [];
      for (const row of selectApprovedUnclaimed.all() as ProposalRow[]) {
        if (!isStale(row, nowMs, maxAgeMsByOperation)) continue;
        const changed = lapseOne.run({ proposalId: row.proposal_id, now });
        if (changed.changes !== 1) continue;
        writeAudit(row.proposal_id, "lapsed", now, null, row.payload_hash, null);
        lapsed.push(row.proposal_id as ProposalId);
      }
      return lapsed;
    },
  );

  /**
   * An approval is stale when its operation's maximum approval age has passed. Every doubt fails
   * closed: an operation with no age in the table, an unreadable approval time, or an age that is
   * not a finite number all lapse the approval, and the boundary itself counts as stale.
   */
  function isStale(
    row: ProposalRow,
    nowMs: number,
    maxAgeMsByOperation: Readonly<Record<string, number>>,
  ): boolean {
    const maxAge = Object.hasOwn(maxAgeMsByOperation, row.operation)
      ? maxAgeMsByOperation[row.operation]
      : undefined;
    if (maxAge === undefined || !Number.isFinite(maxAge) || maxAge < 0) return true;
    const approvedMs = row.approved_at === null ? Number.NaN : Date.parse(row.approved_at);
    if (!Number.isFinite(approvedMs)) return true;
    return nowMs - approvedMs >= maxAge;
  }

  const purgeTx = immediate((before: string): number => purgeOlder.run(before).changes);

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
    list(bucket: ApprovalBucket, limit: number): StoredProposal[] {
      if (!BUCKETS.includes(bucket)) throw new InvalidApprovalInputError("bucket");
      if (!Number.isInteger(limit) || limit < 0) throw new InvalidApprovalInputError("limit");
      const statement =
        bucket === "pending" ? listPending : bucket === "decided" ? listDecided : listExpired;
      return (statement.all(limit) as ProposalRow[]).map(rowToProposal);
    },
    counts() {
      let pending = 0;
      let expired = 0;
      let decided = 0;
      for (const row of countByState.all() as { state: string; n: number }[]) {
        if (row.state === "pending") pending += row.n;
        else if (row.state === "expired") expired += row.n;
        else decided += row.n;
      }
      return { pending, decided, expired };
    },
    claim(proposalId: ProposalId, facts: ClaimFacts, now: string): ClaimResult {
      assertProposalId(proposalId, "proposalId");
      assertIso(now, "now");
      return claimTx(proposalId, serialiseClaimFacts(facts), now);
    },
    beginRetry(proposalId: ProposalId, now: string): RetryResult {
      assertProposalId(proposalId, "proposalId");
      assertIso(now, "now");
      return retryTx(proposalId, now);
    },
    finish(input: FinishInput): StoredProposal | null {
      assertProposalId(input.proposalId, "proposalId");
      assertIso(input.now, "now");
      if (input.state !== "executed" && input.state !== "failed" && input.state !== "unknown") {
        throw new InvalidApprovalInputError("state");
      }
      assertOutcomeCode(input.code, "code");
      if (input.note !== null) assertOutcomeCode(input.note, "note");
      if (input.evidence !== null) assertOutcomeCode(input.evidence, "evidence");
      return finishTx(input);
    },
    expireDue(now: string): ProposalId[] {
      assertIso(now, "now");
      return expireDueTx(now);
    },
    lapseStaleApproved(
      now: string,
      maxAgeMsByOperation: Readonly<Record<string, number>>,
    ): ProposalId[] {
      assertIso(now, "now");
      if (typeof maxAgeMsByOperation !== "object" || maxAgeMsByOperation === null) {
        throw new InvalidApprovalInputError("maxAgeMsByOperation");
      }
      return lapseTx(now, maxAgeMsByOperation);
    },
    listExecuting(): StoredProposal[] {
      return (selectExecuting.all() as ProposalRow[]).map(rowToProposal);
    },
    listApprovedUnclaimed(): StoredProposal[] {
      return (selectApprovedUnclaimed.all() as ProposalRow[]).map(rowToProposal);
    },
    withdraw(proposalId: ProposalId, now: string): StoredProposal | null {
      assertProposalId(proposalId, "proposalId");
      assertIso(now, "now");
      return withdrawTx(proposalId, now);
    },
    purgeDecidedPayloads(before: string): number {
      assertIso(before, "before");
      return purgeTx(before);
    },
    auditFor(proposalId: ProposalId): AuditRow[] {
      assertProposalId(proposalId, "proposalId");
      return (
        selectAudit.all(proposalId, AUDIT_READ_LIMIT) as {
          event: string;
          at: string;
          detail: string | null;
        }[]
      ).map((row) => {
        if (!isAuditEvent(row.event)) throw new InvalidApprovalRowError("event");
        return { event: row.event, at: row.at, code: row.detail };
      });
    },
  };
}

/**
 * The effect ledger of the zero-impact `diagnostic.test` operation (D-43): one
 * row per proposal id with insert-or-ignore semantics, so a test can count
 * executions and effects apart and a second execution of one proposal is
 * visible as `already-recorded`. `now` is injected because this module never
 * reads the clock.
 */
export function createDiagnosticEffects(
  db: Database.Database,
  now: () => string,
): DiagnosticEffectsPort {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO diagnostic_effects (proposal_id, recorded_at) VALUES (?, ?)",
  );
  const exists = db.prepare("SELECT 1 AS present FROM diagnostic_effects WHERE proposal_id = ?");
  return {
    record(proposalId: ProposalId): "recorded" | "already-recorded" {
      assertProposalId(proposalId, "proposalId");
      const recordedAt = now();
      assertIso(recordedAt, "recordedAt");
      return insert.run(proposalId, recordedAt).changes === 1 ? "recorded" : "already-recorded";
    },
    exists(proposalId: ProposalId): boolean {
      assertProposalId(proposalId, "proposalId");
      return exists.get(proposalId) !== undefined;
    },
  };
}
