import {
  APPROVAL_PENDING_CAP_PER_OPERATION,
  APPROVAL_PENDING_CAP_TOTAL,
  type ApprovalDecision,
  type ApprovalLog,
  type ApprovalPublisher,
  type ApprovalStorePort,
  type ApprovalSummary,
  buildEnvelope,
  type CapabilityToken,
  type ClaimFacts,
  type ClassificationTable,
  type Clock,
  canonicalJson,
  type DecidedVia,
  type DecideResponse,
  dedupeKeyOf,
  type EnabledOperation,
  type ExecuteContext,
  type ExecuteOutcome,
  type JsonValue,
  type MirrorPort,
  type NewProposal,
  type NoteId,
  newNoteId,
  newProposalId,
  normaliseDecidedVia,
  type OperationDefinition,
  PAYLOAD_HASH_PATTERN,
  type ProposalId,
  ProposalIdSchema,
  type Requester,
  resolveTtlMs,
  type StoredProposal,
} from "@ccc/domain";
import { payloadHashOf } from "./canonical-hash.js";
import { mintToken } from "./mint/mint-token.js";
import { operationLabelFor, summaryOf } from "./view.js";

/**
 * The approval engine core (APPR-01, APPR-02, APPR-04, APPR-10, D-01, D-02,
 * D-14 to D-18). It owns the state machine, the token and the claim; an
 * operation owns what it does. Everything it touches arrives as an injected
 * port (store, registry, clock, publisher, mirror, log), so every one of them
 * can be replaced by an in-memory double in a test.
 *
 * Element: `approval`. Imports `@ccc/domain`, files in this folder and the
 * minter folder only. This file is the ONLY importer of the minter.
 */

// ---------------------------------------------------------------------------
// Token ledger

/**
 * The module-private record of every token this engine minted (research Pattern
 * 7, T-06-01). Membership is by object identity, so a structurally identical
 * hand-built object, a spread copy of a real token, or a token from another
 * engine's ledger is not a member.
 */
export interface TokenLedger {
  issue(input: {
    readonly proposalId: string;
    readonly operation: EnabledOperation;
    readonly subject: string;
    readonly expiresAt: string;
  }): CapabilityToken<EnabledOperation>;
  has(token: object): boolean;
}

export function createTokenLedger(): TokenLedger {
  const minted = new WeakSet<object>();
  return {
    issue(input) {
      const token = mintToken<EnabledOperation>(input);
      minted.add(token);
      return token;
    },
    has: (token) => minted.has(token),
  };
}

/**
 * The only way the engine calls an operation's `execute`. A token that the
 * ledger did not issue is refused before the operation is touched, so a
 * structurally valid forgery that reaches this function does nothing.
 */
export async function dispatchWithToken(
  ledger: TokenLedger,
  definition: RegisteredDefinition,
  token: CapabilityToken<EnabledOperation>,
  payload: unknown,
  context: ExecuteContext,
): Promise<ExecuteOutcome> {
  if (!ledger.has(token)) return { kind: "failed", reason: "capability-refused" };
  return definition.execute(token, payload, context);
}

// ---------------------------------------------------------------------------
// Public shapes

export type RegisteredDefinition = OperationDefinition<EnabledOperation, unknown>;

/** What the engine needs from the operation registry: a lookup and the table it was built against. */
export interface OperationRegistry {
  /** The classification table the registry was checked against. The engine classifies through it and never through a second copy. */
  readonly table: ClassificationTable;
  lookup(operation: string): RegisteredDefinition | undefined;
  operations(): readonly string[];
}

export interface ApprovalEngineDeps {
  readonly store: ApprovalStorePort;
  readonly registry: OperationRegistry;
  readonly clock: Clock;
  readonly publisher: ApprovalPublisher;
  readonly mirror: MirrorPort;
  readonly log: ApprovalLog;
  /** Mints proposal ids and mirror note ids. Defaults to the domain minters. */
  readonly ids?: { proposalId(): ProposalId; noteId(): NoteId };
  /** The display name of a registered project, or null. Display only; never a path. */
  readonly projectName?: (projectId: string) => string | null;
}

export interface SubmitInput {
  readonly operation: string;
  readonly subject: string;
  readonly requester: Requester;
  readonly projectId: string | null;
  readonly runId: string | null;
  readonly reason: string;
  readonly payload: unknown;
  /** A requester may shorten its request's lifetime, never lengthen it (D-10). */
  readonly requestedTtlMs?: number;
}

export type SubmitRejection =
  | "operation-reserved"
  | "operation-unknown"
  | "operation-not-approvable"
  | "invalid-payload"
  | "inbox-full";

export type SubmitOutcome =
  | {
      readonly kind: "proposed";
      readonly proposalId: ProposalId;
      readonly deduped: boolean;
      readonly supersedes: ProposalId | null;
    }
  | { readonly kind: "rejected"; readonly reason: SubmitRejection };

/** A decision names one request, one decision and the full hash of what the owner saw. Nothing else: there is no way to carry a payload. */
export interface EngineDecideInput {
  readonly proposalId: string;
  readonly decision: ApprovalDecision;
  readonly payloadHash: string;
  readonly via: DecidedVia;
}

export interface ApprovalEngine {
  submit(input: SubmitInput): SubmitOutcome;
  decide(input: EngineDecideInput): Promise<DecideResponse>;
  /** Resolves when every execution the engine started has finished (tests, shutdown). */
  settled(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers

/** The approval-required row of `operation`, or undefined. */
function approvalRowOf(table: ClassificationTable, operation: string) {
  const row = Object.hasOwn(table, operation) ? table[operation] : undefined;
  return row?.class === "approval-required" ? row : undefined;
}

type ParsedPayload = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

/** Parses the stored payload text and validates it against the operation's strict schema. */
function parseStoredPayload(
  definition: RegisteredDefinition,
  payloadJson: string | null,
): ParsedPayload {
  if (payloadJson === null) return { ok: false };
  let raw: unknown;
  try {
    raw = JSON.parse(payloadJson);
  } catch {
    return { ok: false };
  }
  const parsed = definition.payload.safeParse(raw);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}

function isoAfter(now: string, ms: number): string {
  return new Date(Date.parse(now) + ms).toISOString();
}

// ---------------------------------------------------------------------------
// The engine

export function createApprovalEngine(deps: ApprovalEngineDeps): ApprovalEngine {
  const { store, registry, clock, publisher, mirror, log } = deps;
  const ids = deps.ids ?? { proposalId: newProposalId, noteId: newNoteId };
  const ledger = createTokenLedger();
  const inflight = new Set<Promise<void>>();

  /** The owner-facing title of a stored request, rendered from its stored payload; the operation's label when that is not possible. */
  function titleOf(stored: StoredProposal): string {
    const definition = registry.lookup(stored.operation);
    if (definition !== undefined) {
      const parsed = parseStoredPayload(definition, stored.payloadJson);
      if (parsed.ok) {
        try {
          return definition.render(parsed.value, { requester: stored.requester }).title;
        } catch {
          // fall through to the fixed label: a summary of an odd row must still render
        }
      }
    }
    return operationLabelFor(registry.table, stored.operation);
  }

  function summaryFor(stored: StoredProposal): ApprovalSummary {
    return summaryOf(stored, {
      title: titleOf(stored),
      projectName: projectNameOf(stored),
      table: registry.table,
    });
  }

  function projectNameOf(stored: StoredProposal): string | null {
    if (stored.projectId === null || deps.projectName === undefined) return null;
    try {
      return deps.projectName(stored.projectId);
    } catch {
      return null;
    }
  }

  /** Publishes a summary and requests a best-effort mirror write. Neither can change a result (D-22, D-28). */
  function announce(stored: StoredProposal): void {
    try {
      publisher.publish("approval.upserted", { approval: summaryFor(stored) });
    } catch {
      log.warn({ proposalId: stored.proposalId, code: "publish-failed" });
    }
    try {
      mirror.mirror(stored).catch(() => {
        log.warn({ proposalId: stored.proposalId, code: "mirror-failed" });
      });
    } catch {
      log.warn({ proposalId: stored.proposalId, code: "mirror-failed" });
    }
  }

  // --- submit ---------------------------------------------------------------

  function submit(input: SubmitInput): SubmitOutcome {
    const definition = registry.lookup(input.operation);
    const row = approvalRowOf(registry.table, input.operation);
    if (definition === undefined || row === undefined) {
      return { kind: "rejected", reason: "operation-unknown" };
    }

    const parsed = definition.payload.safeParse(input.payload);
    if (!parsed.success) return { kind: "rejected", reason: "invalid-payload" };

    const now = clock.now();
    const expiresAt = isoAfter(now, resolveTtlMs(input.requestedTtlMs, row));
    let payloadJson: string;
    let payloadHash: string;
    try {
      const envelope = buildEnvelope({
        operation: input.operation,
        subject: input.subject,
        requester: input.requester,
        projectId: input.projectId,
        runId: input.runId,
        reason: input.reason,
        payload: parsed.data as JsonValue,
      });
      payloadJson = canonicalJson(envelope.payload);
      payloadHash = payloadHashOf(envelope);
    } catch {
      return { kind: "rejected", reason: "invalid-payload" };
    }

    const proposal: NewProposal = {
      proposalId: ids.proposalId(),
      operation: input.operation,
      subject: input.subject,
      dedupeKey: dedupeKeyOf(input.operation, input.subject),
      requester: { kind: input.requester.kind, label: input.requester.label },
      projectId: input.projectId,
      runId: input.runId,
      reason: input.reason,
      payloadJson,
      payloadHash,
      createdAt: now,
      expiresAt,
      mirrorNoteId: ids.noteId(),
      supersedes: null,
    };
    const result = store.submit(proposal, {
      perOperation: APPROVAL_PENDING_CAP_PER_OPERATION,
      total: APPROVAL_PENDING_CAP_TOTAL,
    });
    if (result.kind === "capped") return { kind: "rejected", reason: "inbox-full" };
    if (result.kind === "deduped") {
      return {
        kind: "proposed",
        proposalId: result.proposal.proposalId,
        deduped: true,
        supersedes: result.proposal.supersedes,
      };
    }
    log.info({
      proposalId: result.proposal.proposalId,
      state: result.proposal.state,
      operation: result.proposal.operation,
      payloadHash: result.proposal.payloadHash,
      code: "submitted",
    });
    announce(result.proposal);
    return {
      kind: "proposed",
      proposalId: result.proposal.proposalId,
      deduped: false,
      supersedes: result.proposal.supersedes,
    };
  }

  // --- decide ---------------------------------------------------------------

  const decided = (stored: StoredProposal): DecideResponse => ({
    outcome: "decided",
    approval: summaryFor(stored),
  });

  async function decide(input: EngineDecideInput): Promise<DecideResponse> {
    const id = ProposalIdSchema.safeParse(input.proposalId);
    if (!id.success) return { outcome: "not-found" };
    const proposalId = id.data;

    if (!PAYLOAD_HASH_PATTERN.test(input.payloadHash)) {
      // A hash that is not even shaped like one can never match: answer as the store would for a wrong hash.
      const row = store.get(proposalId);
      if (row === null) return { outcome: "not-found" };
      if (row.state !== "pending") return { outcome: "already-decided", state: row.state };
      return { outcome: "hash-mismatch" };
    }

    const result = store.decide({
      proposalId,
      decision: input.decision,
      expectedHash: input.payloadHash,
      now: clock.now(),
      via: normaliseDecidedVia(input.via),
    });
    switch (result.kind) {
      case "not-found":
        return { outcome: "not-found" };
      case "already-decided":
        return { outcome: "already-decided", state: result.state };
      case "hash-mismatch":
        return { outcome: "hash-mismatch" };
      case "operation-reserved":
        return { outcome: "operation-reserved" };
      case "expired":
        announce(result.proposal);
        return { outcome: "expired" };
      case "denied":
        log.info({ proposalId, state: "denied", code: "denied" });
        announce(result.proposal);
        return decided(result.proposal);
      case "approved":
        log.info({ proposalId, state: "approved", code: "approved" });
        announce(result.proposal);
        return approvedFlow(result.proposal);
    }
  }

  /** Claim, then start the effect WITHOUT awaiting it: decide returns once the request is `executing` (D-14). */
  async function approvedFlow(approved: StoredProposal): Promise<DecideResponse> {
    const definition = registry.lookup(approved.operation);
    if (definition === undefined) {
      // Cannot happen with a fail-closed registry; leave the request approved for recovery to lapse.
      log.error({ proposalId: approved.proposalId, code: "operation-unregistered" });
      return decided(approved);
    }
    let facts: ClaimFacts = {};
    if (definition.claimFacts !== undefined) {
      const parsed = parseStoredPayload(definition, approved.payloadJson);
      if (parsed.ok) {
        try {
          facts = await definition.claimFacts(parsed.value);
        } catch {
          // Facts are an aid to recovery, never a gate: claim with none and never log the error text.
          log.warn({ proposalId: approved.proposalId, code: "claim-facts-failed" });
        }
      }
    }
    const claim = store.claim(approved.proposalId, facts, clock.now());
    if (claim.kind === "lost") {
      return decided(store.get(approved.proposalId) ?? approved);
    }
    announce(claim.proposal);
    const response = decided(claim.proposal);
    const run: Promise<void> = runAttempt(claim.proposal)
      .catch(() => {
        log.error({ proposalId: claim.proposal.proposalId, code: "engine-fault" });
      })
      .finally(() => {
        inflight.delete(run);
      });
    inflight.add(run);
    return response;
  }

  // --- execute --------------------------------------------------------------

  function finishWith(
    proposal: StoredProposal,
    outcome: {
      readonly state: "executed" | "failed" | "unknown";
      readonly code: string;
      readonly note?: string | null;
      readonly evidence?: string | null;
      readonly reconciled?: boolean;
    },
  ): void {
    const finished = store.finish({
      proposalId: proposal.proposalId,
      state: outcome.state,
      code: outcome.code,
      note: outcome.note ?? null,
      evidence: outcome.evidence ?? null,
      reconciled: outcome.reconciled ?? false,
      now: clock.now(),
    });
    if (finished === null) {
      log.warn({ proposalId: proposal.proposalId, code: "finish-lost" });
      return;
    }
    log.info({ proposalId: proposal.proposalId, state: finished.state, code: outcome.code });
    announce(finished);
  }

  /** Carries out one attempt of a claimed request and records the outcome. */
  async function runAttempt(proposal: StoredProposal): Promise<void> {
    const definition = registry.lookup(proposal.operation);
    const row = approvalRowOf(registry.table, proposal.operation);
    if (definition === undefined || row === undefined || proposal.approvedAt === null) {
      finishWith(proposal, { state: "failed", code: "capability-refused" });
      return;
    }
    const parsed = parseStoredPayload(definition, proposal.payloadJson);
    if (!parsed.ok) {
      finishWith(proposal, { state: "failed", code: "payload-invalid" });
      return;
    }

    const expiresAt = new Date(
      Math.min(
        Date.parse(proposal.expiresAt),
        Date.parse(proposal.approvedAt) + row.maxApprovalAgeMs,
      ),
    ).toISOString();
    const token = ledger.issue({
      proposalId: proposal.proposalId,
      operation: definition.operation,
      subject: proposal.subject,
      expiresAt,
    });
    const outcome = await dispatchWithToken(ledger, definition, token, parsed.value, {
      idempotencyKey: proposal.proposalId,
      claimFacts: proposal.claimFacts ?? {},
      attempt: proposal.attempts,
    });
    if (outcome.kind === "executed") {
      finishWith(proposal, { state: "executed", code: "executed", note: outcome.note ?? null });
    } else {
      finishWith(proposal, { state: "failed", code: outcome.reason });
    }
  }

  async function settled(): Promise<void> {
    while (inflight.size > 0) {
      await Promise.allSettled([...inflight]);
    }
  }

  return { submit, decide, settled };
}
