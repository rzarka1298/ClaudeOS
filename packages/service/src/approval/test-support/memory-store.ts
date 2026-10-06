// An in-memory ApprovalStorePort for the approval tests (06-08). Folder-private:
// never exported from the approval public entry. It is a deliberately small
// model of the SQL store (06-06): the same decide answer order, the same
// compare-and-set on the source state, the same audit rows, and it takes its
// idea of a legal transition from the domain `PROPOSAL_TRANSITIONS` table, so
// the two cannot drift apart silently. The real SQL semantics are proven in
// 06-06 and re-proven end to end in 06-24; this double exists so engine tests
// run with no database. Imports `@ccc/domain` only.
import {
  type ApprovalAuditEvent,
  type ApprovalBucket,
  type ApprovalStorePort,
  type AuditRow,
  type ClaimFacts,
  type ClaimResult,
  type DecideInput,
  type DecideResult,
  type FinishInput,
  type NewProposal,
  type PendingCaps,
  PROPOSAL_TRANSITIONS,
  type ProposalId,
  type ProposalState,
  type RetryResult,
  type StoredProposal,
  type SubmitResult,
  classifyOperation,
} from "@ccc/domain";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface Row extends Mutable<StoredProposal> {
  claimedAt: string | null;
  finishedAt: string | null;
  seq: number;
}

function assertLegal(from: ProposalState, to: ProposalState): void {
  if (!PROPOSAL_TRANSITIONS[from].includes(to)) {
    throw new Error(`illegal transition ${from} -> ${to}`);
  }
}

function isEnabledApprovalOperation(operation: string): boolean {
  const classified = classifyOperation(operation);
  return (
    classified !== undefined &&
    classified.row.class === "approval-required" &&
    classified.row.status === "enabled"
  );
}

export interface MemoryApprovalStore extends ApprovalStorePort {
  /** Every port method that was called, in order, by name. Lets a test assert a call did NOT happen. */
  readonly calls: string[];
  /** Inserts a row exactly as given (a reserved operation, an odd state): a test of a row the engine never wrote. */
  insertRaw(row: StoredProposal): void;
  /** Rewrites the stored payload text behind the store's back, to model a corrupted or edited row. */
  tamperPayloadJson(proposalId: ProposalId, payloadJson: string | null): void;
  /** Rewrites the stored reason behind the store's back. */
  tamperReason(proposalId: ProposalId, reason: string): void;
  /** Every audit event of a row, oldest first, with no cap. */
  auditEvents(proposalId: ProposalId): ApprovalAuditEvent[];
  /** The finish inputs the store was handed, in order. */
  readonly finishes: FinishInput[];
}

export function createMemoryApprovalStore(): MemoryApprovalStore {
  const rows = new Map<string, Row>();
  const audit = new Map<string, AuditRow[]>();
  const calls: string[] = [];
  const finishes: FinishInput[] = [];
  let seq = 0;

  const writeAudit = (
    proposalId: string,
    event: ApprovalAuditEvent,
    at: string,
    code: string | null,
  ): void => {
    const list = audit.get(proposalId) ?? [];
    list.push({ event, at, code });
    audit.set(proposalId, list);
  };

  const toStored = (row: Row): StoredProposal => ({
    proposalId: row.proposalId,
    operation: row.operation,
    subject: row.subject,
    dedupeKey: row.dedupeKey,
    requester: { ...row.requester },
    projectId: row.projectId,
    runId: row.runId,
    reason: row.reason,
    payloadJson: row.payloadJson,
    payloadHash: row.payloadHash,
    state: row.state,
    revision: row.revision,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    approvedAt: row.approvedAt,
    decidedAt: row.decidedAt,
    decidedVia: row.decidedVia,
    claimFacts: row.claimFacts === null ? null : { ...row.claimFacts },
    attempts: row.attempts,
    outcomeCode: row.outcomeCode,
    outcomeNote: row.outcomeNote,
    mirrorNoteId: row.mirrorNoteId,
    supersedes: row.supersedes,
  });

  const change = (row: Row, to: ProposalState): void => {
    assertLegal(row.state, to);
    row.state = to;
    row.revision += 1;
  };

  const pendingRows = (): Row[] => [...rows.values()].filter((row) => row.state === "pending");
  const byState = (...states: ProposalState[]): Row[] =>
    [...rows.values()].filter((row) => states.includes(row.state));
  const lastChange = (row: Row): string =>
    row.finishedAt ?? row.claimedAt ?? row.decidedAt ?? row.createdAt;

  const store: MemoryApprovalStore = {
    calls,
    finishes,

    insertRaw(row) {
      seq += 1;
      rows.set(row.proposalId, { ...row, claimedAt: null, finishedAt: null, seq });
    },
    tamperPayloadJson(proposalId, payloadJson) {
      const row = rows.get(proposalId);
      if (row) row.payloadJson = payloadJson;
    },
    tamperReason(proposalId, reason) {
      const row = rows.get(proposalId);
      if (row) row.reason = reason;
    },
    auditEvents(proposalId) {
      return (audit.get(proposalId) ?? []).map((entry) => entry.event);
    },

    submit(proposal: NewProposal, caps: PendingCaps): SubmitResult {
      calls.push("submit");
      const twin = pendingRows().find((row) => row.dedupeKey === proposal.dedupeKey);
      if (twin) return { kind: "deduped", proposal: toStored(twin) };
      const forOperation = pendingRows().filter((row) => row.operation === proposal.operation);
      if (forOperation.length >= caps.perOperation) return { kind: "capped", scope: "operation" };
      if (pendingRows().length >= caps.total) return { kind: "capped", scope: "total" };

      let supersedes: ProposalId | null = proposal.supersedes;
      if (supersedes === null) {
        const superseded = new Set(
          [...rows.values()].map((row) => row.supersedes).filter((id) => id !== null),
        );
        const candidates = byState("expired")
          .filter((row) => row.dedupeKey === proposal.dedupeKey && !superseded.has(row.proposalId))
          .sort((a, b) =>
            a.createdAt === b.createdAt ? b.seq - a.seq : b.createdAt < a.createdAt ? -1 : 1,
          );
        supersedes = candidates[0]?.proposalId ?? null;
      }

      seq += 1;
      const row: Row = {
        proposalId: proposal.proposalId,
        operation: proposal.operation,
        subject: proposal.subject,
        dedupeKey: proposal.dedupeKey,
        requester: { ...proposal.requester },
        projectId: proposal.projectId,
        runId: proposal.runId,
        reason: proposal.reason,
        payloadJson: proposal.payloadJson,
        payloadHash: proposal.payloadHash,
        state: "pending",
        revision: 1,
        createdAt: proposal.createdAt,
        expiresAt: proposal.expiresAt,
        approvedAt: null,
        decidedAt: null,
        decidedVia: null,
        claimFacts: null,
        attempts: 0,
        outcomeCode: null,
        outcomeNote: null,
        mirrorNoteId: proposal.mirrorNoteId,
        supersedes,
        claimedAt: null,
        finishedAt: null,
        seq,
      };
      rows.set(row.proposalId, row);
      writeAudit(row.proposalId, "requested", proposal.createdAt, null);
      return { kind: "created", proposal: toStored(row) };
    },

    get(proposalId) {
      calls.push("get");
      const row = rows.get(proposalId);
      return row ? toStored(row) : null;
    },

    list(bucket: ApprovalBucket, limit: number) {
      calls.push("list");
      const pick =
        bucket === "pending"
          ? pendingRows().sort((a, b) =>
              a.expiresAt !== b.expiresAt
                ? a.expiresAt < b.expiresAt
                  ? -1
                  : 1
                : a.createdAt !== b.createdAt
                  ? a.createdAt < b.createdAt
                    ? -1
                    : 1
                  : a.seq - b.seq,
            )
          : bucket === "expired"
            ? byState("expired").sort((a, b) =>
                a.expiresAt !== b.expiresAt ? (a.expiresAt < b.expiresAt ? 1 : -1) : b.seq - a.seq,
              )
            : byState(
                "approved",
                "executing",
                "executed",
                "failed",
                "unknown",
                "denied",
                "withdrawn",
                "lapsed",
              ).sort((a, b) =>
                lastChange(a) !== lastChange(b)
                  ? lastChange(a) < lastChange(b)
                    ? 1
                    : -1
                  : b.seq - a.seq,
              );
      return pick.slice(0, limit).map(toStored);
    },

    counts() {
      calls.push("counts");
      const all = [...rows.values()];
      return {
        pending: all.filter((row) => row.state === "pending").length,
        expired: all.filter((row) => row.state === "expired").length,
        decided: all.filter((row) => row.state !== "pending" && row.state !== "expired").length,
      };
    },

    decide(input: DecideInput): DecideResult {
      calls.push("decide");
      const row = rows.get(input.proposalId);
      if (!row) return { kind: "not-found" };
      if (row.state !== "pending") return { kind: "already-decided", state: row.state };
      if (input.now >= row.expiresAt) {
        change(row, "expired");
        row.decidedAt = input.now;
        writeAudit(row.proposalId, "expired", input.now, null);
        return { kind: "expired", proposal: toStored(row) };
      }
      if (!isEnabledApprovalOperation(row.operation)) return { kind: "operation-reserved" };
      if (input.expectedHash !== row.payloadHash) return { kind: "hash-mismatch" };
      const approve = input.decision === "approve";
      change(row, approve ? "approved" : "denied");
      row.approvedAt = approve ? input.now : null;
      row.decidedAt = input.now;
      row.decidedVia = input.via;
      writeAudit(row.proposalId, approve ? "approved" : "denied", input.now, null);
      return approve
        ? { kind: "approved", proposal: toStored(row) }
        : { kind: "denied", proposal: toStored(row) };
    },

    claim(proposalId: ProposalId, facts: ClaimFacts, now: string): ClaimResult {
      calls.push("claim");
      const row = rows.get(proposalId);
      if (row?.state !== "approved") return { kind: "lost" };
      change(row, "executing");
      row.claimedAt = now;
      row.claimFacts = { ...facts };
      row.attempts = 1;
      writeAudit(proposalId, "claimed", now, null);
      return { kind: "claimed", proposal: toStored(row) };
    },

    beginRetry(proposalId: ProposalId, now: string): RetryResult {
      calls.push("beginRetry");
      const row = rows.get(proposalId);
      if (row?.state !== "executing") return { kind: "not-executing" };
      if (row.attempts >= 2) return { kind: "exhausted" };
      row.attempts += 1;
      row.revision += 1;
      writeAudit(proposalId, "retried-after-restart", now, null);
      return { kind: "retrying", proposal: toStored(row) };
    },

    finish(input: FinishInput) {
      calls.push("finish");
      finishes.push(input);
      const row = rows.get(input.proposalId);
      if (row?.state !== "executing") return null;
      change(row, input.state);
      row.outcomeCode = input.code;
      row.outcomeNote = input.note;
      row.finishedAt = input.now;
      const event: ApprovalAuditEvent =
        input.state === "executed"
          ? input.reconciled
            ? "reconciled-executed"
            : "executed"
          : input.state === "failed"
            ? "failed"
            : "outcome-unknown";
      writeAudit(input.proposalId, event, input.now, input.evidence ?? input.code);
      return toStored(row);
    },

    expireDue(now: string) {
      calls.push("expireDue");
      const expired: ProposalId[] = [];
      for (const row of pendingRows().sort((a, b) => (a.expiresAt < b.expiresAt ? -1 : 1))) {
        if (row.expiresAt > now) continue;
        change(row, "expired");
        row.decidedAt = now;
        writeAudit(row.proposalId, "expired", now, null);
        expired.push(row.proposalId);
      }
      return expired;
    },

    lapseStaleApproved(now: string, maxAgeMsByOperation: Readonly<Record<string, number>>) {
      calls.push("lapseStaleApproved");
      const lapsed: ProposalId[] = [];
      for (const row of byState("approved")) {
        const maxAge = Object.hasOwn(maxAgeMsByOperation, row.operation)
          ? maxAgeMsByOperation[row.operation]
          : undefined;
        const approvedMs = row.approvedAt === null ? Number.NaN : Date.parse(row.approvedAt);
        const stale =
          maxAge === undefined ||
          !Number.isFinite(approvedMs) ||
          Date.parse(now) - approvedMs >= maxAge;
        if (!stale) continue;
        change(row, "lapsed");
        row.decidedAt = now;
        writeAudit(row.proposalId, "lapsed", now, null);
        lapsed.push(row.proposalId);
      }
      return lapsed;
    },

    listExecuting() {
      calls.push("listExecuting");
      return byState("executing").map(toStored);
    },
    listApprovedUnclaimed() {
      calls.push("listApprovedUnclaimed");
      return byState("approved").map(toStored);
    },

    withdraw(proposalId: ProposalId, now: string) {
      calls.push("withdraw");
      const row = rows.get(proposalId);
      if (row?.state !== "pending") return null;
      change(row, "withdrawn");
      row.decidedAt = now;
      writeAudit(proposalId, "withdrawn", now, null);
      return toStored(row);
    },

    purgeDecidedPayloads(before: string) {
      calls.push("purgeDecidedPayloads");
      let purged = 0;
      for (const row of byState(
        "denied",
        "expired",
        "withdrawn",
        "lapsed",
        "executed",
        "failed",
        "unknown",
      )) {
        if (row.payloadJson !== null && lastChange(row) < before) {
          row.payloadJson = null;
          purged += 1;
        }
      }
      return purged;
    },

    auditFor(proposalId: ProposalId) {
      calls.push("auditFor");
      return (audit.get(proposalId) ?? []).slice(-20).map((entry) => ({ ...entry }));
    },
  };
  return store;
}
