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
  type DecideResult,
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
  PRESENCE_PROMPT_TIMEOUT_MS,
  type PresencePort,
  type PresenceResult,
  type ProposalId,
  ProposalIdSchema,
  type Requester,
  RequesterSchema,
  RunIdSchema,
  resolveTtlMs,
  type StoredProposal,
  type UnverifiedDecidedVia,
} from "@ccc/domain";
import { payloadHashOf, recomputeFromStored } from "./canonical-hash.js";
import { mintToken } from "./mint/mint-token.js";
import {
  type ExecuteResult,
  type FinishDecision,
  resolveOutcome,
  unknownDecision,
} from "./outcome.js";
import {
  decisionMacFields,
  type PresencePart,
  type ProofVerdict,
  presenceMessage,
  signDecisionProof,
  verifyDecisionProof,
  verifyPresenceSignature,
} from "./proof.js";
import { createRecovery, type RecoverySummary, tokenExpiryMs } from "./recovery.js";
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
  /**
   * The key the engine signs every approval with and checks before an approved or executing row is
   * carried out (09-17, D-03, APPR-12): `approvalProofKey(installSecret)`. REQUIRED, so no construction
   * site can skip the proof. It is held here and nowhere else; it is never logged, stored or returned.
   */
  readonly proofKey: Buffer;
  /** Mints proposal ids and mirror note ids. Defaults to the domain minters. */
  readonly ids?: { proposalId(): ProposalId; noteId(): NoteId };
  /** The display name of a registered project, or null. Display only; never a path. */
  readonly projectName?: (projectId: string) => string | null;
  /** The longest `claimFacts` may take before the claim goes ahead with no facts. Defaults to 5000. */
  readonly claimFactsTimeoutMs?: number;
  /**
   * Verifies the owner's presence for an approve whose classification row says `presence: "required"`
   * (D-01, D-02). Absent, {@link UNAVAILABLE_PRESENCE} stands in, so every such approval fails closed.
   */
  readonly presence?: PresencePort;
  /**
   * Reads the pin (the base64 SPKI public key in the helper-only Keychain item, read attribute-only) that a
   * presence signature is verified against (09-18, R-02). Called only when a `proved` answer needs verifying and
   * when a presence-required row is re-verified (recovery, the claim, the last gate before execute); never on a
   * timer. Absent, it answers null, so every presence-required approval and row fails closed.
   */
  readonly readPin?: () => Promise<string | null>;
}

/**
 * The port used when none is wired: it can prove nothing and says so, so a presence-required approval
 * is refused `presence-unavailable` rather than waved through (D-01).
 */
export const UNAVAILABLE_PRESENCE: PresencePort = {
  async prove() {
    return { kind: "unavailable" };
  },
  async availability() {
    return "unavailable";
  },
};

const DEFAULT_CLAIM_FACTS_TIMEOUT_MS = 5000;

/** The decision-proof key length (`approvalProofKey` derives 32 bytes). */
const PROOF_KEY_BYTES = 32;

/** What an approved row with no valid proof is finished as: it never ran, so `failed` is truthful (R-05). */
const PROOF_INVALID_FAILED: FinishDecision = {
  state: "failed",
  code: "proof-invalid",
  note: null,
  evidence: null,
  reconciled: false,
};

/**
 * What an approved row is finished as when the presence key could not be read at the claim or the last gate
 * (FIX15 M1): nothing ran and the owner is told so, rather than the row sitting approved or executing until a
 * restart. Distinct from `proof-invalid`, which means the row failed verification.
 */
const PRESENCE_KEY_UNREADABLE = "presence-key-unreadable";

/** At most this many presence checks start per {@link PRESENCE_WINDOW_MS}, across all requests (T-09-26). */
export const PRESENCE_PROMPTS_PER_MINUTE = 3;
const PRESENCE_WINDOW_MS = 60_000;

/**
 * How long the engine waits for the port before it gives up on it (m1): the helper's own prompt ceiling
 * plus a margin for its start and teardown, still inside the client's decide timeout (prompt + 25 s), so
 * a port that never settles answers `presence-unavailable` instead of wedging the proposal's flight.
 */
export const PRESENCE_ENGINE_TIMEOUT_MS = PRESENCE_PROMPT_TIMEOUT_MS + 5_000;

/**
 * After the owner's prompt for a proposal is denied, the same proposal cannot prompt again for this long
 * (m3). A token-holder looping approve on one request then costs one prompt, not the whole budget; it
 * does not stop one holding several requests from spending the global budget (recorded as residual risk).
 */
export const PRESENCE_DENIED_COOLDOWN_MS = 30_000;

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

/** What a presence check resolves to when shutdown abandons it. */
const ABANDONED = Symbol("presence-check-abandoned");

/** The answer of a presence port narrowed to the closed set; anything else proved nothing (fail closed, m2). */
function presenceResultOf(answer: unknown): PresenceResult {
  if (typeof answer === "object" && answer !== null) {
    const kind = (answer as { readonly kind?: unknown }).kind;
    if (kind === "proved" || kind === "denied" || kind === "unavailable") {
      return answer as PresenceResult;
    }
  }
  return { kind: "unavailable" };
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
  /**
   * An unverified hint recorded for operations that need no presence; never consulted for a
   * presence-required approval (D-03). It can never produce `presence`: only a proved check does.
   */
  readonly channelHint: UnverifiedDecidedVia;
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

export {
  type ExecuteResult,
  type FinishDecision,
  resolveOutcome,
} from "./outcome.js";
export type { RecoverySummary } from "./recovery.js";

/** What one expiry sweep changed. Counts only: never an id or a word of text. */
export interface SweepSummary {
  /** Pending requests past their expiry, denied automatically. */
  readonly expired: number;
  /** Approved requests never claimed within their operation's maximum approval age. */
  readonly lapsed: number;
}

/** A test-only window onto the engine's bookkeeping; not part of {@link ApprovalEngine}. */
export interface EngineProbe {
  /** How many presence checks are subscribed to shutdown right now (zero once every check has finished). */
  shutdownSubscriptions(): number;
}

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
  /**
   * Denies every pending request past its expiry and lapses approved requests never claimed
   * within their maximum approval age, publishing each change after the store call (D-08, D-09).
   * Safe to call at any time and as often as wanted; a sweep with nothing due changes nothing.
   */
  sweepExpired(): SweepSummary;
  /**
   * Startup recovery (D-17): brings every in-flight request to an honest state from evidence,
   * reconciling before any retry, and returns once each change is persisted, without waiting
   * for a retried effect. Run it after the Phase 5 spool drain and revival sweep, before the socket opens.
   */
  recover(): Promise<RecoverySummary>;
  /** Resolves when every execution the engine started has finished (tests, shutdown). */
  settled(): Promise<void>;
  /**
   * Shutdown: from this synchronous call on, no new attempt is claimed or started and `decide`
   * answers without touching the request (it stays pending or approved for recovery on next boot).
   */
  beginShutdown(): void;
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
// The engine

export function createApprovalEngine(deps: ApprovalEngineDeps): ApprovalEngine & EngineProbe {
  const { store, registry, clock, publisher, mirror, log, proofKey } = deps;
  // An all-zero or short key would sign proofs anyone can compute: refuse it at construction.
  if (!Buffer.isBuffer(proofKey) || proofKey.length !== PROOF_KEY_BYTES) {
    throw new RangeError(`createApprovalEngine: proofKey must be ${PROOF_KEY_BYTES} bytes`);
  }
  const presence = deps.presence ?? UNAVAILABLE_PRESENCE;
  const readPin = deps.readPin ?? (async () => null);
  const ids = deps.ids ?? { proposalId: newProposalId, noteId: newNoteId };
  const ledger = createTokenLedger();
  const inflight = new Set<Promise<void>>();
  /** Proposal ids this engine is itself claiming or carrying out: recovery and sweeps leave them alone. */
  const active = new Set<string>();

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
      expireDueRows(now);
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

  // --- expiry ---------------------------------------------------------------

  /** The maximum approval age of every enabled approval-required row; any other approved row lapses. */
  const maxApprovalAges: Readonly<Record<string, number>> = Object.fromEntries(
    Object.entries(registry.table).flatMap(([operation, row]) =>
      row.class === "approval-required" && row.status === "enabled"
        ? [[operation, row.maxApprovalAgeMs] as const]
        : [],
    ),
  );

  /** Denies every pending request past its expiry (one store call), then publishes each. Returns how many. */
  function expireDueRows(now: string): number {
    const expiredIds = store.expireDue(now);
    for (const expiredId of expiredIds) {
      const expired = store.get(expiredId);
      if (expired !== null) announce(expired);
    }
    return expiredIds.length;
  }

  /** Lapses approved requests never claimed within their operation's age (one store call), then publishes each. */
  function lapseStaleRows(now: string): number {
    const lapsedIds = store.lapseStaleApproved(now, maxApprovalAges);
    for (const lapsedId of lapsedIds) {
      const lapsed = store.get(lapsedId);
      if (lapsed !== null) announce(lapsed);
    }
    return lapsedIds.length;
  }

  function sweepExpired(): SweepSummary {
    const now = clock.now();
    const expired = expireDueRows(now);
    const lapsed = lapseStaleRows(now);
    if (expired > 0 || lapsed > 0) log.info({ code: "swept", counts: { expired, lapsed } });
    return { expired, lapsed };
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

  /**
   * True when approving `operation` needs the owner's verified presence. An operation that is reserved or has no
   * row is never carried out (recovery finishes it `operation-reserved`), so it needs no presence part here.
   */
  function presenceRequiredFor(operation: string): boolean {
    const row = Object.hasOwn(registry.table, operation) ? registry.table[operation] : undefined;
    return row?.class === "approval-required" && row.presence !== "none";
  }

  let stopping = false;

  async function decide(input: EngineDecideInput): Promise<DecideResponse> {
    // Shutting down: a late decision must not claim, start or even approve anything. The closed
    // DecideResponse vocabulary's `presence-unavailable` means the owner's presence could not be
    // checked, which is not this; "operation-reserved" is the closest refusal that leaves the request untouched.
    if (stopping) return { outcome: "operation-reserved" };
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
      // Denial never asks for presence (R-03); a presence-required approve goes through the gate (D-01).
      if (input.decision === "approve" && presenceRequiredFor(current.operation)) {
        return decideWithPresence(current, input);
      }
    }

    // ONE clock read: the instant the store records as `approvedAt` is the instant the proof covers.
    const now = clock.now();
    const via = channelOf(input);
    const proof =
      input.decision === "approve" && current?.state === "pending"
        ? signApproval(current, now, via, null)
        : undefined;
    return settleDecision(
      proposalId,
      store.decide({
        proposalId,
        decision: input.decision,
        expectedHash: input.payloadHash,
        now,
        via,
        ...(proof === undefined ? {} : { approvedAt: now, decisionProof: proof }),
      }),
    );
  }

  /**
   * The proof text for approving `row` at `approvedAt` through `via` (D-03). The MAC binds the row's id,
   * operation, payload hash, the approval instant and the channel, so it cannot be moved to another row.
   */
  function signApproval(
    row: StoredProposal,
    approvedAt: string,
    via: DecidedVia,
    presencePart: PresencePart | null,
  ): string {
    const fields = decisionMacFields({
      proposalId: row.proposalId,
      operation: row.operation,
      payloadHash: row.payloadHash,
      approvedAt,
      decidedVia: via,
    });
    if (fields === null) throw new Error("approval proof: no covered fields");
    return signDecisionProof(proofKey, fields, presencePart);
  }

  /** The pin, or null when it cannot be read: a throwing or non-string reader proved nothing. */
  async function pinOrNull(): Promise<string | null> {
    try {
      const pin = await readPin();
      return typeof pin === "string" ? pin : null;
    } catch {
      return null;
    }
  }

  /**
   * The verdict on `row`'s proof under this engine's key (R-05) and, for an operation whose classification needs
   * presence, on its presence signature against the pin (09-18). The pin is read only for a presence-required
   * row. `pin-unavailable` (09-FIX9) means the row is sound but the pin could not be read: the caller leaves it
   * for a later try. Nothing here throws; the verdict is about the row it is given, so a caller that awaits this
   * and then runs that same row has verified what it runs.
   */
  async function proofVerifies(row: StoredProposal): Promise<ProofVerdict> {
    const required = presenceRequiredFor(row.operation);
    const pin = required ? await pinOrNull() : null;
    return verifyDecisionProof(proofKey, row, { presenceRequired: required, pin });
  }

  /** The recorded channel of an ungated decision: the hint, with `presence` unreachable from outside (D-03). */
  function channelOf(input: EngineDecideInput): DecidedVia {
    return normaliseDecidedVia(input.channelHint);
  }

  /** Turns the store's answer into the closed response, announcing and starting the effect as the result calls for. */
  function settleDecision(
    proposalId: ProposalId,
    result: DecideResult,
  ): Promise<DecideResponse> | DecideResponse {
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

  // --- the presence gate (D-01, D-02, D-03, R-03) -----------------------------

  /** One presence-required approve per proposal at a time: a second caller joins the first's outcome (D-01). */
  const presenceFlights = new Map<string, Promise<DecideResponse>>();
  /** When each of the recent presence checks started, in epoch ms, for the prompt budget. */
  let presenceStarts: number[] = [];
  /** When each recently denied proposal may be asked about again, in epoch ms (m3). */
  const deniedUntil = new Map<string, number>();

  /**
   * An approve of a presence-required request. The cheap refusals come first and never start a check: a
   * request already past its deadline goes straight to the store (which expires it), and a hash that is
   * not the request's is refused. Then one check per proposal runs at a time, within a budget of
   * {@link PRESENCE_PROMPTS_PER_MINUTE} starts per minute across all requests.
   */
  function decideWithPresence(
    current: StoredProposal,
    input: EngineDecideInput,
  ): Promise<DecideResponse> | DecideResponse {
    const proposalId = current.proposalId;
    // ONE clock read decides everything before the prompt (C1): the deadline test, the budget window
    // and the instant the owner is asked to vouch for. A second read could step backwards and let a
    // request that the first read saw expired reach an approve with no presence call.
    const now = clock.now();
    if (now >= current.expiresAt) {
      // Past its deadline: only an expiry is possible, so use the store call that can only expire (never approve).
      expireDueRows(now);
      const row = store.get(proposalId);
      if (row === null) return { outcome: "not-found" };
      return row.state === "expired"
        ? { outcome: "expired" }
        : { outcome: "already-decided", state: row.state };
    }
    if (input.payloadHash !== current.payloadHash) return { outcome: "hash-mismatch" };

    // A proposal whose prompt was just denied does not prompt again yet: no port call, no budget spent (m3).
    const cooledUntil = deniedUntil.get(proposalId);
    if (cooledUntil !== undefined) {
      if (Date.parse(now) < cooledUntil) {
        return refuseApprove(current, "presence-denied", "presence-cooldown");
      }
      deniedUntil.delete(proposalId);
    }

    const running = presenceFlights.get(proposalId);
    if (running !== undefined) return joinFlight(proposalId, running);
    const flight = runPresenceCheck(current, input.payloadHash, now).finally(() => {
      if (presenceFlights.get(proposalId) === flight) presenceFlights.delete(proposalId);
    });
    presenceFlights.set(proposalId, flight);
    return flight;
  }

  /** A second approve of a request already being checked: one decision, so it reads as already decided. */
  async function joinFlight(
    proposalId: ProposalId,
    running: Promise<DecideResponse>,
  ): Promise<DecideResponse> {
    const shared = await running;
    if (shared.outcome !== "decided") return shared;
    const row = store.get(proposalId);
    return row === null
      ? { outcome: "not-found" }
      : { outcome: "already-decided", state: row.state };
  }

  /**
   * The abandon callbacks of the presence checks currently waiting on a port. Each check adds its own and
   * removes it when it finishes, so a completed check (and its result) is never retained until shutdown;
   * a shared never-settling promise raced by every check would keep every loser's reaction alive.
   */
  const shutdownListeners = new Set<() => void>();
  function abandonFlights(): void {
    for (const listener of [...shutdownListeners]) listener();
  }

  /** The port's answer, cut off after {@link PRESENCE_ENGINE_TIMEOUT_MS} (rejects "timeout") or at shutdown ({@link ABANDONED}). */
  async function proveWithin(request: Parameters<PresencePort["prove"]>[0]): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cutoff = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), PRESENCE_ENGINE_TIMEOUT_MS);
    });
    let listener: (() => void) | undefined;
    // Aborted at shutdown or at the cutoff, so the adapter kills the helper and its prompt (FIX15 m4).
    const controller = new AbortController();
    const abandoned = new Promise<typeof ABANDONED>((resolve) => {
      listener = () => {
        controller.abort();
        resolve(ABANDONED);
      };
      shutdownListeners.add(listener);
    });
    try {
      return await Promise.race([
        presence.prove(request, { signal: controller.signal }),
        cutoff,
        abandoned,
      ]);
    } catch (error) {
      controller.abort();
      throw error;
    } finally {
      clearTimeout(timer);
      if (listener !== undefined) shutdownListeners.delete(listener);
    }
  }

  /**
   * The presence part to store for a `proved` answer: `ok` with the part, `no-pin` when no pin can be read now,
   * or `bad` when the answer does not hold up (no signature, a scheme the recorded custody does not produce, or a
   * signature that does not verify against the pin over this approval's message).
   */
  async function verifiedPresencePart(
    current: StoredProposal,
    approvedAt: string,
    result: Extract<PresenceResult, { kind: "proved" }>,
  ): Promise<
    { readonly kind: "ok"; readonly part: PresencePart } | { readonly kind: "bad" | "no-pin" }
  > {
    if (result.scheme !== "p256" || typeof result.signature !== "string") return { kind: "bad" };
    const pin = await pinOrNull();
    if (pin === null) return { kind: "no-pin" };
    const message = presenceMessage({
      proposalId: current.proposalId,
      operation: current.operation,
      payloadHash: current.payloadHash,
      approvedAt,
    });
    return verifyPresenceSignature(pin, message, result.signature)
      ? { kind: "ok", part: { scheme: "p256", sig: result.signature } }
      : { kind: "bad" };
  }

  /**
   * The answer to give instead of prompting, when the request is no longer one the owner should be asked about
   * after the pin lookup: shutting down, no longer pending (denied, withdrawn, expired, decided), past its
   * deadline on a clock read that is never earlier than the instant of the ask, a payload that is not the one
   * the caller saw, or a denial cooldown. Null when the prompt may go ahead.
   */
  function refusalAfterLookup(
    current: StoredProposal,
    callerHash: string,
    askedAt: string,
  ): DecideResponse | null {
    if (stopping) return { outcome: "operation-reserved" };
    const proposalId = current.proposalId;
    const row = store.get(proposalId);
    if (row === null) return { outcome: "not-found" };
    const settledAs = (state: StoredProposal["state"]): DecideResponse =>
      state === "expired" ? { outcome: "expired" } : { outcome: "already-decided", state };
    if (row.state !== "pending") return settledAs(row.state);
    // A clock that stepped back is clamped to the ask: the test can only be stricter than before.
    const later = clock.now();
    const strict = later > askedAt ? later : askedAt;
    if (strict >= row.expiresAt) {
      expireDueRows(strict);
      const after = store.get(proposalId);
      return after === null ? { outcome: "not-found" } : settledAs(after.state);
    }
    if (row.payloadHash !== callerHash || row.payloadHash !== current.payloadHash) {
      return { outcome: "hash-mismatch" };
    }
    const cooledUntil = deniedUntil.get(proposalId);
    if (cooledUntil !== undefined && Date.parse(strict) < cooledUntil) {
      return refuseApprove(current, "presence-denied", "presence-cooldown");
    }
    return null;
  }

  /**
   * Asks the presence port BEFORE the store is asked to decide, never inside its transaction, so no
   * database lock is held across a prompt (D-01). Only a `proved` answer reaches `store.decide`; a
   * refusal stays on the record and leaves the request pending.
   */
  async function runPresenceCheck(
    current: StoredProposal,
    callerHash: string,
    askedAt: string,
  ): Promise<DecideResponse> {
    const proposalId = current.proposalId;
    const startedAt = Date.parse(askedAt);
    // The budget is looked at BEFORE the pin is (09-FIX9): a spent budget costs no `security` spawn. A slot is
    // reserved here, synchronously, so ten concurrent approves cannot all start a lookup; it is handed back
    // below whenever the check ends without a prompt (no pin, or the request changed during the lookup), so a
    // refusal that never asked the owner spends nothing.
    presenceStarts = presenceStarts.filter((started) => startedAt - started < PRESENCE_WINDOW_MS);
    if (presenceStarts.length >= PRESENCE_PROMPTS_PER_MINUTE) {
      return refuseApprove(current, "presence-unavailable", "presence-budget");
    }
    presenceStarts.push(startedAt);
    let prompting = false;
    try {
      // The pin comes before the prompt: with no pin the signature could never be checked, so the owner is not
      // asked for a Touch ID that cannot count and the port is not called.
      const pinBefore = await pinOrNull();
      if (pinBefore === null) {
        return refuseApprove(
          current,
          "presence-unavailable",
          undefined,
          "presence-pin-unavailable",
        );
      }
      // The lookup took time. The request may have been denied, withdrawn or expired meanwhile, and the
      // owner must not be asked about one that is no longer open (Codex, FIX9).
      const changed = refusalAfterLookup(current, callerHash, askedAt);
      if (changed !== null) return changed;
      prompting = true;
    } finally {
      if (!prompting) {
        const slot = presenceStarts.lastIndexOf(startedAt);
        if (slot >= 0) presenceStarts.splice(slot, 1);
      }
    }

    const approvedAt = askedAt;
    let answer: unknown;
    try {
      answer = await proveWithin({
        proposalId,
        operation: current.operation,
        payloadHash: current.payloadHash,
        approvedAt,
      });
    } catch (error) {
      // A port that fails or never answers is a port that proved nothing; never log the error text.
      log.warn({
        proposalId,
        code:
          error instanceof Error && error.message === "timeout"
            ? "presence-check-timeout"
            : "presence-check-failed",
      });
      answer = undefined;
    }
    // Shutdown began while the prompt was up: the request stays pending for the next boot, nothing is recorded.
    if (answer === ABANDONED) return { outcome: "operation-reserved" };
    const result = presenceResultOf(answer);
    if (result.kind !== "proved") {
      if (result.kind === "denied" && result.cause === "timeout") {
        // A prompt nobody answered is not a decision (FIX15 m3): its own record, and no cooldown.
        return refuseApprove(current, "presence-denied", "presence-timeout");
      }
      if (result.kind === "denied") {
        // The cooldown runs from when the denial arrives, so an owner who deliberates before denying still
        // gets the full cooldown; a clock that stepped back is clamped to the ask, so it is never shorter
        // than the ask plus the cooldown.
        const receivedMs = Math.max(Date.parse(clock.now()), Date.parse(askedAt));
        for (const [id, expiresAtMs] of deniedUntil) {
          if (expiresAtMs <= receivedMs) deniedUntil.delete(id);
        }
        deniedUntil.set(proposalId, receivedMs + PRESENCE_DENIED_COOLDOWN_MS);
        return refuseApprove(current, "presence-denied");
      }
      return refuseApprove(current, "presence-unavailable");
    }
    deniedUntil.delete(proposalId);
    // Shutting down mid-prompt: the request stays pending for the next boot.
    if (stopping) return { outcome: "operation-reserved" };
    // The helper's word is not enough (D-03, R-02): its signature must verify, against the pinned public key,
    // over the exact message of THIS approval. Nothing is decided on a signature that does not, a scheme the
    // recorded custody does not produce, or a pin that cannot be read.
    const checked = await verifiedPresencePart(current, approvedAt, result);
    if (checked.kind !== "ok") {
      return refuseApprove(
        current,
        "presence-unavailable",
        undefined,
        checked.kind === "no-pin" ? "presence-pin-unavailable" : "presence-proof-invalid",
      );
    }
    const presencePart = checked.part;
    if (stopping) return { outcome: "operation-reserved" };
    // The store re-checks the deadline against this later instant, so a request that lapsed while the
    // prompt was up is expired. A wall clock that stepped back during the prompt is clamped to the
    // instant the owner vouched for: the deadline test is only ever MORE conservative, and the store
    // is never handed an approvedAt after its now (m2).
    const read = clock.now();
    const decidedAt = read < approvedAt ? approvedAt : read;
    return settleDecision(
      proposalId,
      store.decide({
        proposalId,
        decision: "approve",
        expectedHash: callerHash,
        now: decidedAt,
        approvedAt,
        via: "presence",
        decisionProof: signApproval(current, approvedAt, "presence", presencePart),
      }),
    );
  }

  /**
   * Puts a refused presence-required approve on the record and answers in the closed vocabulary. The
   * store bounds the record (one row per reason per window, a cap per proposal); this warn is bounded
   * the same way, by logging only a refusal the store actually recorded (09-FIX6A, M1).
   */
  function refuseApprove(
    current: StoredProposal,
    outcome: "presence-denied" | "presence-unavailable",
    reason: "presence-cooldown" | "presence-budget" | "presence-timeout" | undefined = undefined,
    warnCode: "presence-proof-invalid" | "presence-pin-unavailable" | undefined = undefined,
  ): DecideResponse {
    const proposalId = current.proposalId;
    // The client is told the closed outcome; the record keeps the finer reason when there is one.
    const detail = reason ?? outcome;
    const recorded = store.recordDecisionRefusal({
      proposalId,
      at: clock.now(),
      payloadHash: current.payloadHash,
      detail,
    });
    if (recorded === "recorded") {
      if (reason === "presence-budget") log.warn({ proposalId, code: "presence-rate-limited" });
      if (reason === "presence-cooldown") log.warn({ proposalId, code: "presence-cooldown" });
      if (warnCode !== undefined) log.warn({ proposalId, code: warnCode });
      log.warn({ proposalId, code: "presence-refused", detail });
    }
    if (recorded === "not-pending") {
      // Decided, expired or withdrawn while the prompt was up: say what happened, not the refusal.
      const now = store.get(proposalId);
      return now === null
        ? { outcome: "not-found" }
        : { outcome: "already-decided", state: now.state };
    }
    return { outcome };
  }

  /** Claim, then start the effect WITHOUT awaiting it: decide returns once the request is `executing` (D-14). */
  async function approvedFlow(approved: StoredProposal): Promise<DecideResponse> {
    const definition = registry.lookup(approved.operation);
    if (definition === undefined) {
      // Cannot happen with a fail-closed registry; leave the request approved for recovery to lapse.
      log.error({ proposalId: approved.proposalId, code: "operation-unregistered" });
      return decided(approved);
    }
    const claimed = await claimAndStart(approved, definition);
    if (claimed === null) return decided(store.get(approved.proposalId) ?? approved);
    return decided(claimed);
  }

  /**
   * Gathers the operation's claim facts (an aid, never a gate), claims the request and starts the
   * effect WITHOUT awaiting it. Returns the claimed row, or null when another caller claimed first.
   */
  async function claimAndStart(
    approved: StoredProposal,
    definition: RegisteredDefinition,
  ): Promise<StoredProposal | null> {
    // The request stays approved; startup recovery picks it up on the next boot.
    if (stopping) return null;
    // Another caller (a concurrent recovery, say) is already carrying this row through the claim: leave it to
    // them. The mark is set BEFORE the awaited pin read below, so a second caller cannot slip in during it
    // (09-FIX9) and this caller can only ever release a mark it set itself.
    if (active.has(approved.proposalId)) return null;
    active.add(approved.proposalId);
    // Once the attempt has started, `startAttempt` owns the mark and clears it when the run ends.
    let handedOver = false;
    try {
      // A row whose proof is missing, malformed or not its own is never started (R-05): claimed so it
      // can be finished, and failed, never silently repaired.
      const verdict = await proofVerifies(approved);
      if (verdict === "invalid") {
        refuseUnproved(approved);
        return null;
      }
      if (verdict === "pin-unavailable") {
        // Sound, but the pin could not be read now (09-FIX9). Nothing runs without a verifying signature, and
        // nothing waits for a restart either (FIX15 M1): the row is claimed so it can be finished `failed`
        // with its own code, and the owner sees that nothing ran.
        log.warn({ proposalId: approved.proposalId, code: "approval-proof-pin-unavailable" });
        const claim = store.claim(approved.proposalId, {}, clock.now());
        if (claim.kind === "claimed") {
          announce(claim.proposal);
          finishWith(claim.proposal, keyUnreadableDecision(claim.proposal));
        }
        return null;
      }
      // The pin read above took time; a shutdown that began meanwhile leaves the row approved for the next boot.
      if (stopping) return null;
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
      if (stopping) return null;
      const claim = store.claim(approved.proposalId, facts, clock.now());
      if (claim.kind === "lost") return null;
      announce(claim.proposal);
      handedOver = true;
      startAttempt(claim.proposal);
      return claim.proposal;
    } finally {
      if (!handedOver) active.delete(approved.proposalId);
    }
  }

  /**
   * Claims an approved row that has no valid proof and finishes it `failed` / `proof-invalid`; it never runs.
   * Returns true when the refusal was written. One implementation, used by the claim and by recovery.
   */
  function refuseUnproved(approved: StoredProposal): boolean {
    log.warn({ proposalId: approved.proposalId, code: "approval-proof-invalid" });
    const claim = store.claim(approved.proposalId, {}, clock.now());
    if (claim.kind !== "claimed") return false;
    announce(claim.proposal);
    return finishWith(claim.proposal, PROOF_INVALID_FAILED) !== null;
  }

  function keyUnreadableDecision(claimed: StoredProposal): FinishDecision {
    return claimed.attempts < 2
      ? {
          state: "failed",
          code: PRESENCE_KEY_UNREADABLE,
          note: null,
          evidence: null,
          reconciled: false,
        }
      : unknownDecision(PRESENCE_KEY_UNREADABLE, null);
  }

  /** Runs one claimed attempt without awaiting it; `settled()` waits for it. */
  function startAttempt(proposal: StoredProposal): void {
    active.add(proposal.proposalId);
    const run: Promise<void> = runAttempt(proposal)
      .catch(() => {
        log.error({ proposalId: proposal.proposalId, code: "engine-fault" });
      })
      .finally(() => {
        inflight.delete(run);
        active.delete(proposal.proposalId);
      });
    inflight.add(run);
  }

  // --- execute --------------------------------------------------------------

  /** Records an attempt's outcome and publishes it. Returns the finished row, or null when none was written. */
  function finishWith(proposal: StoredProposal, initial: FinishDecision): StoredProposal | null {
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
        return null;
      }
    }
    if (finished === null) {
      log.warn({ proposalId: proposal.proposalId, code: "finish-lost" });
      return null;
    }
    log.info({ proposalId: proposal.proposalId, state: finished.state, code: decision.code });
    announce(finished);
    return finished;
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

  /** The stored payload, re-hashed against the stored hash (integrity) and parsed against the operation's strict schema. */
  function verifiedPayload(
    definition: RegisteredDefinition,
    stored: StoredProposal,
  ):
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly code: string } {
    if (recomputeFromStored(stored) !== stored.payloadHash) {
      log.error({ proposalId: stored.proposalId, code: "stored-hash-mismatch" });
      return { ok: false, code: "integrity-check-failed" };
    }
    const parsed = parseStoredPayload(definition, stored.payloadJson);
    return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, code: "payload-invalid" };
  }

  /** Carries out one attempt of a claimed request and records the outcome. */
  async function runAttempt(proposal: StoredProposal): Promise<void> {
    // The last gate before any effect (09-FIX8): `proposal` is the row the store returned from `claim` or
    // `beginRetry`, so it is the row that is about to run. A check made on an earlier snapshot is not
    // enough, because the row can change while the engine awaits claim facts or a reconcile answer.
    // First attempt: nothing ran, `failed`; a retry: an earlier attempt may have run, `unknown`.
    const verdict = await proofVerifies(proposal);
    if (verdict === "pin-unavailable") {
      // Nothing ran (FIX15 M1): the row is finished now, not left `executing` until a restart. First attempt:
      // `failed`; a retry may follow an attempt that ran, so `unknown`.
      log.warn({ proposalId: proposal.proposalId, code: "approval-proof-pin-unavailable" });
      failBeforeExecute(proposal, PRESENCE_KEY_UNREADABLE);
      return;
    }
    if (verdict !== "valid") {
      log.warn({ proposalId: proposal.proposalId, code: "approval-proof-invalid" });
      failBeforeExecute(proposal, "proof-invalid");
      return;
    }
    const definition = registry.lookup(proposal.operation);
    const row = approvalRowOf(registry.table, proposal.operation);
    if (definition === undefined || row === undefined || proposal.approvedAt === null) {
      failBeforeExecute(proposal, "capability-refused");
      return;
    }
    const parsed = verifiedPayload(definition, proposal);
    if (!parsed.ok) {
      failBeforeExecute(proposal, parsed.code);
      return;
    }

    // D-18: the earlier of the proposal's own expiry and approval time plus the operation's age.
    const expiresMs = tokenExpiryMs(proposal, row.maxApprovalAgeMs);
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
    while (inflight.size > 0 || presenceFlights.size > 0) {
      await Promise.allSettled([...inflight, ...presenceFlights.values()]);
    }
  }

  const recovery = createRecovery({
    store,
    registry,
    clock,
    log,
    expireDue: expireDueRows,
    lapseStale: lapseStaleRows,
    announce,
    isActive: (proposalId) => active.has(proposalId),
    verifiedPayload,
    verifyProof: (proposal) => proofVerifies(proposal),
    refuseUnproved,
    finish: finishWith,
    startAttempt,
    claimAndStart: async (approved, definition) =>
      (await claimAndStart(approved, definition)) !== null,
  });

  return {
    submit,
    decide,
    withdraw,
    get,
    list,
    snapshot,
    sweepExpired,
    recover: recovery.recover,
    settled,
    shutdownSubscriptions: () => shutdownListeners.size,
    beginShutdown: () => {
      stopping = true;
      abandonFlights();
    },
  };
}
