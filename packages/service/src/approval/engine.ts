import {
  APPROVAL_CHIP_BOUND,
  APPROVAL_PENDING_CAP_PER_OPERATION,
  APPROVAL_PENDING_CAP_TOTAL,
  type ApprovalBucket,
  type ApprovalDecision,
  type ApprovalItemView,
  type ApprovalLog,
  type ApprovalPublisher,
  type ApprovalStorePort,
  type ApprovalSummary,
  type ApprovalsSnapshot,
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
  type ReconcileVerdict,
  type Requester,
  RequesterSchema,
  RunIdSchema,
  resolveTtlMs,
  type StoredProposal,
} from "@ccc/domain";
import { payloadHashOf, recomputeFromStored } from "./canonical-hash.js";
import { mintToken } from "./mint/mint-token.js";
import {
  assembleSnapshot,
  buildApprovalView,
  historyOf,
  operationLabelFor,
  summaryOf,
} from "./view.js";

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
  /** The longest `claimFacts` may take before the claim goes ahead with no facts. Defaults to 5000. */
  readonly claimFactsTimeoutMs?: number;
}

const DEFAULT_CLAIM_FACTS_TIMEOUT_MS = 5000;

/** Rejects after `ms`; the timer is always cleared once the race settles. */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
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

/** The detail of one request: the service-built view, or the reason there is none, plus what is always known. */
export type ApprovalDetail =
  | { readonly kind: "not-found" }
  | {
      readonly kind: "found";
      readonly summary: ApprovalSummary;
      /** Null when the payload was purged (`purged`) or can no longer be rendered (`unreadable`). */
      readonly view: ApprovalItemView | null;
      readonly purged: boolean;
      readonly unreadable: boolean;
      readonly history: ApprovalItemView["history"];
      /** The first twelve characters of the payload hash. */
      readonly fingerprint: string;
    };

export type WithdrawOutcome =
  | { readonly kind: "withdrawn" }
  | { readonly kind: "not-withdrawable" };

export interface ApprovalEngine {
  submit(input: SubmitInput): SubmitOutcome;
  decide(input: EngineDecideInput): Promise<DecideResponse>;
  /** The requester takes back a request that is still pending. */
  withdraw(proposalId: string): WithdrawOutcome;
  /** One request's detail, built from its stored row and audit trail. */
  get(proposalId: string): ApprovalDetail;
  /** Summaries of one bucket of requests. */
  list(bucket: ApprovalBucket, limit?: number): ApprovalSummary[];
  /** The inbox as the snapshot carries it, within the response budget (bytes of the approvals part). */
  snapshot(budgetBytes?: number): ApprovalsSnapshot;
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

/** Bounds on requester-supplied text the engine stores (T-06-14). */
const REASON_MAX_CHARS = 16_000;
const SUBJECT_MAX_CHARS = 1024;
const PROJECT_ID_MAX_CHARS = 128;

function isoAfter(now: string, ms: number): string {
  return new Date(Date.parse(now) + ms).toISOString();
}

// ---------------------------------------------------------------------------
// Outcome handling (D-17, D-42, A-7, Codex finding 1)

/** What the engine writes to the store when an attempt ends. Every code is a fixed token, never free text. */
export interface FinishDecision {
  readonly state: "executed" | "failed" | "unknown";
  readonly code: string;
  readonly note: string | null;
  readonly evidence: string | null;
  readonly reconciled: boolean;
}

/** `threw: true` is an `execute` that rejected. Its message is never read. */
export type ExecuteResult =
  | { readonly threw: true }
  | { readonly threw: false; readonly outcome: ExecuteOutcome };

const FIXED_TOKEN = /^[a-z][a-z0-9-]{0,63}$/;
/** Used when an operation hands back evidence that is not a fixed token: the fact is kept, the text is not. */
const GENERIC_EVIDENCE = "reconcile-evidence";

function fixedToken(value: string, fallback: string): string {
  return FIXED_TOKEN.test(value) ? value : fallback;
}

/**
 * The one place an attempt's result becomes a recorded outcome, used by the
 * first run and by crash recovery (06-12).
 *
 * - A rejected `execute` is `unknown` (`executor-threw`), never `failed`: an
 *   effect may already have started.
 * - On the first attempt a refusal or failure is definitive: nothing was done,
 *   so `failed` with the reason code is truthful.
 * - On a retry attempt (2 or more) any non-executed result is routed through
 *   the operation's read-only `reconcile`: `effect-proven` records `executed`
 *   (flagged reconciled, with the evidence code); anything else records
 *   `unknown`. A plain `failed` is never written for a retry.
 */
export async function resolveOutcome(
  definition: RegisteredDefinition,
  payload: unknown,
  context: ExecuteContext,
  result: ExecuteResult,
): Promise<FinishDecision> {
  if (result.threw) return unknownDecision("executor-threw", null);
  const outcome = result.outcome;
  if (outcome.kind === "executed") {
    const note = outcome.note !== undefined && FIXED_TOKEN.test(outcome.note) ? outcome.note : null;
    return { state: "executed", code: "executed", note, evidence: null, reconciled: false };
  }
  if (context.attempt < 2) {
    return {
      state: "failed",
      code: fixedToken(outcome.reason, "refused"),
      note: null,
      evidence: null,
      reconciled: false,
    };
  }
  let verdict: ReconcileVerdict;
  try {
    verdict = await definition.reconcile(payload, context);
  } catch {
    return unknownDecision("reconcile-threw", null);
  }
  if (verdict.kind === "effect-proven") {
    return {
      state: "executed",
      code: "executed",
      note: null,
      evidence: fixedToken(verdict.evidence, GENERIC_EVIDENCE),
      reconciled: true,
    };
  }
  if (verdict.kind === "effect-absent") return unknownDecision("outcome-unknown", "effect-absent");
  return unknownDecision("outcome-unknown", fixedToken(verdict.reason, GENERIC_EVIDENCE));
}

function unknownDecision(code: string, evidence: string | null): FinishDecision {
  return { state: "unknown", code, note: null, evidence, reconciled: false };
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

  /** The shape checks a requester-supplied request must pass before anything is stored (T-06-14, T-06-15). */
  function wellFormed(input: SubmitInput): boolean {
    return (
      RequesterSchema.safeParse(input.requester).success &&
      typeof input.reason === "string" &&
      input.reason.length <= REASON_MAX_CHARS &&
      typeof input.subject === "string" &&
      input.subject.length >= 1 &&
      input.subject.length <= SUBJECT_MAX_CHARS &&
      (input.projectId === null ||
        (typeof input.projectId === "string" &&
          input.projectId.length >= 1 &&
          input.projectId.length <= PROJECT_ID_MAX_CHARS)) &&
      (input.runId === null || RunIdSchema.safeParse(input.runId).success)
    );
  }

  function submit(input: SubmitInput): SubmitOutcome {
    const row = Object.hasOwn(registry.table, input.operation)
      ? registry.table[input.operation]
      : undefined;
    if (row === undefined) return { kind: "rejected", reason: "operation-unknown" };
    if (row.class !== "approval-required") {
      return { kind: "rejected", reason: "operation-not-approvable" };
    }
    if (row.status !== "enabled") return { kind: "rejected", reason: "operation-reserved" };
    const definition = registry.lookup(input.operation);
    if (definition === undefined) return { kind: "rejected", reason: "operation-unknown" };
    if (!wellFormed(input)) return { kind: "rejected", reason: "invalid-payload" };

    const parsed = definition.payload.safeParse(input.payload);
    if (!parsed.success) return { kind: "rejected", reason: "invalid-payload" };
    // The subject names what the capability token will cover: it must be the target the payload
    // (and so the owner's view) names, never a separate claim by the requester.
    if (definition.subjectOf !== undefined) {
      let expected: string;
      try {
        expected = definition.subjectOf(parsed.data);
      } catch {
        return { kind: "rejected", reason: "invalid-payload" };
      }
      if (input.subject !== expected) return { kind: "rejected", reason: "invalid-payload" };
    }
    // A request the owner could not be shown is never stored: the draft must render.
    try {
      definition.render(parsed.data, { requester: input.requester });
    } catch {
      return { kind: "rejected", reason: "invalid-payload" };
    }

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
    const caps = {
      perOperation: APPROVAL_PENDING_CAP_PER_OPERATION,
      total: APPROVAL_PENDING_CAP_TOTAL,
    };
    let result = store.submit(proposal, caps);
    if (result.kind === "deduped" && result.proposal.expiresAt <= now) {
      // The pending twin is already past its expiry and not yet swept: settle it as expired and
      // submit afresh, so a requester is never handed a request nobody can decide.
      for (const expiredId of store.expireDue(now)) {
        const expired = store.get(expiredId);
        if (expired !== null) announce(expired);
      }
      result = store.submit(proposal, caps);
    }
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

  function withdraw(proposalId: string): WithdrawOutcome {
    const id = ProposalIdSchema.safeParse(proposalId);
    if (!id.success) return { kind: "not-withdrawable" };
    const withdrawn = store.withdraw(id.data, clock.now());
    if (withdrawn === null) return { kind: "not-withdrawable" };
    log.info({ proposalId: id.data, state: "withdrawn", code: "withdrawn" });
    announce(withdrawn);
    return { kind: "withdrawn" };
  }

  // --- decide ---------------------------------------------------------------

  const decided = (stored: StoredProposal): DecideResponse => ({
    outcome: "decided",
    approval: summaryFor(stored),
  });

  /** True when the registry's table says `operation` is an enabled approval-required row with a definition (T-06-15). */
  function isDecidable(operation: string): boolean {
    const row = Object.hasOwn(registry.table, operation) ? registry.table[operation] : undefined;
    return (
      row?.class === "approval-required" &&
      row.status === "enabled" &&
      registry.lookup(operation) !== undefined
    );
  }

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

    // The engine's own checks, before the store is asked to decide (T-06-03, T-06-15). The store
    // repeats the ones it can and settles every race inside its transaction.
    const current = store.get(proposalId);
    if (current?.state === "pending") {
      if (!isDecidable(current.operation)) {
        log.error({ proposalId, code: "operation-not-decidable" });
        return { outcome: "operation-reserved" };
      }
      if (input.decision === "approve" && recomputeFromStored(current) !== current.payloadHash) {
        // The row no longer says what was hashed at submit: never approve it, never run it.
        log.error({ proposalId, code: "stored-hash-mismatch", payloadHash: current.payloadHash });
        return { outcome: "hash-mismatch" };
      }
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
          facts = await withTimeout(
            definition.claimFacts(parsed.value),
            deps.claimFactsTimeoutMs ?? DEFAULT_CLAIM_FACTS_TIMEOUT_MS,
          );
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

  function finishWith(proposal: StoredProposal, initial: FinishDecision): void {
    let decision = initial;
    const write = (d: FinishDecision): StoredProposal | null =>
      store.finish({
        proposalId: proposal.proposalId,
        state: d.state,
        code: d.code,
        note: d.note,
        evidence: d.evidence,
        reconciled: d.reconciled,
        now: clock.now(),
      });
    let finished: StoredProposal | null;
    try {
      finished = write(decision);
    } catch {
      // The store refused the outcome (never log its message). The request must not stay
      // `executing`: an effect may already have happened, so the truthful terminal state is unknown.
      log.error({ proposalId: proposal.proposalId, code: "finish-failed" });
      try {
        decision = unknownDecision("outcome-unknown", null);
        finished = write(decision);
      } catch {
        log.error({ proposalId: proposal.proposalId, code: "finish-failed" });
        return;
      }
    }
    if (finished === null) {
      log.warn({ proposalId: proposal.proposalId, code: "finish-lost" });
      return;
    }
    log.info({ proposalId: proposal.proposalId, state: finished.state, code: decision.code });
    announce(finished);
  }

  /**
   * A failure before `execute` was ever called. On the first attempt nothing was done, so `failed`
   * is truthful; on a retry an earlier attempt may have had an effect, so it is `unknown`.
   */
  function failBeforeExecute(proposal: StoredProposal, code: string): void {
    finishWith(
      proposal,
      proposal.attempts < 2
        ? { state: "failed", code, note: null, evidence: null, reconciled: false }
        : unknownDecision(code, null),
    );
  }

  /** Carries out one attempt of a claimed request and records the outcome. */
  async function runAttempt(proposal: StoredProposal): Promise<void> {
    const definition = registry.lookup(proposal.operation);
    const row = approvalRowOf(registry.table, proposal.operation);
    if (definition === undefined || row === undefined || proposal.approvedAt === null) {
      failBeforeExecute(proposal, "capability-refused");
      return;
    }
    if (recomputeFromStored(proposal) !== proposal.payloadHash) {
      log.error({ proposalId: proposal.proposalId, code: "stored-hash-mismatch" });
      failBeforeExecute(proposal, "integrity-check-failed");
      return;
    }
    const parsed = parseStoredPayload(definition, proposal.payloadJson);
    if (!parsed.ok) {
      failBeforeExecute(proposal, "payload-invalid");
      return;
    }

    // D-18: the earlier of the proposal's own expiry and approval time plus the operation's age.
    const expiresMs = Math.min(
      Date.parse(proposal.expiresAt),
      Date.parse(proposal.approvedAt) + row.maxApprovalAgeMs,
    );
    if (!(expiresMs > Date.parse(clock.now()))) {
      // The authorisation is already stale: it is never honoured (T-06-05).
      failBeforeExecute(proposal, "token-expired");
      return;
    }
    const token = ledger.issue({
      proposalId: proposal.proposalId,
      operation: definition.operation,
      subject: proposal.subject,
      expiresAt: new Date(expiresMs).toISOString(),
    });
    const context: ExecuteContext = {
      idempotencyKey: proposal.proposalId,
      claimFacts: proposal.claimFacts ?? {},
      attempt: proposal.attempts,
    };
    let result: ExecuteResult;
    try {
      result = {
        threw: false,
        outcome: await dispatchWithToken(ledger, definition, token, parsed.value, context),
      };
    } catch {
      // The message is never read or logged: it may carry a path or a name.
      result = { threw: true };
    }
    finishWith(proposal, await resolveOutcome(definition, parsed.value, context, result));
  }

  // --- read side ------------------------------------------------------------

  function get(proposalId: string): ApprovalDetail {
    const id = ProposalIdSchema.safeParse(proposalId);
    if (!id.success) return { kind: "not-found" };
    const stored = store.get(id.data);
    if (stored === null) return { kind: "not-found" };
    const audit = store.auditFor(id.data);
    const common = {
      kind: "found" as const,
      summary: summaryFor(stored),
      history: historyOf(audit),
      fingerprint: stored.payloadHash.slice(0, 12),
    };
    if (stored.payloadJson === null) {
      return { ...common, view: null, purged: true, unreadable: false };
    }
    const definition = registry.lookup(stored.operation);
    const parsed =
      definition === undefined ? null : parseStoredPayload(definition, stored.payloadJson);
    if (definition !== undefined && parsed?.ok === true) {
      try {
        const draft = definition.render(parsed.value, { requester: stored.requester });
        const view = buildApprovalView(
          stored,
          draft,
          audit,
          { projectName: projectNameOf(stored) },
          registry.table,
        );
        return { ...common, view, purged: false, unreadable: false };
      } catch {
        // fall through: a row that cannot be rendered is reported, never half-built
      }
    }
    return { ...common, view: null, purged: false, unreadable: true };
  }

  function list(bucket: ApprovalBucket, limit: number = APPROVAL_CHIP_BOUND): ApprovalSummary[] {
    return store.list(bucket, limit).map(summaryFor);
  }

  function snapshot(budgetBytes?: number): ApprovalsSnapshot {
    const input = {
      pending: list("pending"),
      decided: list("decided"),
      expired: list("expired"),
      counts: store.counts(),
    };
    return budgetBytes === undefined
      ? assembleSnapshot(input)
      : assembleSnapshot(input, budgetBytes);
  }

  async function settled(): Promise<void> {
    while (inflight.size > 0) {
      await Promise.allSettled([...inflight]);
    }
  }

  return { submit, decide, withdraw, get, list, snapshot, settled };
}
