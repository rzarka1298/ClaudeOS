import type {
  ApprovalLog,
  ApprovalStorePort,
  ClassificationTable,
  Clock,
  ExecuteContext,
  StoredProposal,
} from "@ccc/domain";
import type { OperationRegistry, RegisteredDefinition } from "./engine.js";
import { consultReconcile, type FinishDecision, unknownDecision } from "./outcome.js";

/**
 * Startup recovery (APPR-10, D-17, D-19, A-3, research Pattern 4). After a
 * restart every in-flight request is brought to an honest state from evidence,
 * never from assumption:
 *
 * 1. Pending requests past their expiry become `expired`.
 * 2. Every `executing` request is reconciled BEFORE anything else is decided:
 *    - the effect is proven: `executed`, flagged reconciled, with the evidence;
 *    - the effect is provably absent, the operation is idempotent, only one
 *      attempt is recorded and the approval has not aged out: ONE retry with the
 *      same idempotency key and a freshly minted token (the engine runs it, so a
 *      refusal or failure on the retry goes back through `reconcile` and is never
 *      recorded as plain `failed`);
 *    - anything else (unknown, a throw, a retry-never operation, attempts used up,
 *      too old): `unknown`. `unknown` is terminal and is never retried.
 * 3. Approved requests that were never claimed are claimed and run while inside
 *    their maximum approval age, and `lapsed` after it.
 * 4. A request whose operation is reserved or no longer registered is finished
 *    `failed` with a reserved code and never executed (D-04, T-06-15).
 * 5. Payload columns of decided requests older than thirty days are purged; audit
 *    rows are never touched (D-19).
 *
 * It is idempotent (a second run finds nothing to do) and it returns once every
 * state change is persisted, without waiting for a retried effect to finish, so
 * the socket can open (D-17). Retry runs are registered with the engine, whose
 * `settled()` waits for them. Ordering relative to the Phase 5 spool drain and
 * revival sweep (A-3: `reconcile` reads Run state) is wired by the composition
 * root (06-21).
 *
 * Element: `approval`. Imports `@ccc/domain` and files in this folder only.
 */

/** Decided requests keep their payload for thirty days (D-19). */
export const PAYLOAD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** What one recovery pass did. Counts only: never an id or a word of text. */
export interface RecoverySummary {
  /** Pending requests past their expiry, denied automatically. */
  readonly expired: number;
  /** Executing requests finished `executed` because `reconcile` proved the effect. */
  readonly reconciled: number;
  /** Executing requests given their one retry. */
  readonly retried: number;
  /** Executing requests finished `unknown` (the retried run's own outcome is not counted here). */
  readonly unknown: number;
  /** Approved requests never claimed within their maximum approval age. */
  readonly lapsed: number;
  /** Approved requests claimed and started now. */
  readonly claimed: number;
  /** Requests of a reserved or unregistered operation, finished `failed` without running. */
  readonly failed: number;
  /** Decided requests whose payload text was cleared. */
  readonly purged: number;
}

/** The part of the engine recovery needs. Everything here is the engine's own, so recovery reaches no private state. */
export interface RecoveryHost {
  readonly store: ApprovalStorePort;
  readonly registry: OperationRegistry;
  readonly clock: Clock;
  readonly log: ApprovalLog;
  /** Denies pending requests past their expiry and publishes each; returns how many. */
  expireDue(now: string): number;
  /** Lapses approved requests never claimed within their age and publishes each; returns how many. */
  lapseStale(now: string): number;
  /** Publishes a changed request. */
  announce(stored: StoredProposal): void;
  /** True while this engine is itself carrying the request out. */
  isActive(proposalId: string): boolean;
  /** The stored payload, parsed against the operation's strict schema and re-hashed; the failing check's fixed code otherwise. */
  verifiedPayload(
    definition: RegisteredDefinition,
    stored: StoredProposal,
  ): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly code: string };
  /** Records an executing request's outcome and publishes it. */
  finish(proposal: StoredProposal, decision: FinishDecision): StoredProposal | null;
  /** Runs one claimed attempt WITHOUT awaiting it; registered for `settled()`. */
  startAttempt(proposal: StoredProposal): void;
  /** Gathers claim facts, claims, publishes and starts the run. False when the claim was lost. */
  claimAndStart(approved: StoredProposal, definition: RegisteredDefinition): Promise<boolean>;
}

/**
 * The instant a capability token for `proposal` stops being valid (D-18): the
 * earlier of the proposal's own expiry and its approval time plus the
 * operation's maximum approval age. NaN when the proposal was never approved.
 */
export function tokenExpiryMs(
  proposal: Pick<StoredProposal, "expiresAt" | "approvedAt">,
  maxApprovalAgeMs: number,
): number {
  if (proposal.approvedAt === null) return Number.NaN;
  return Math.min(
    Date.parse(proposal.expiresAt),
    Date.parse(proposal.approvedAt) + maxApprovalAgeMs,
  );
}

/** The approval row of `operation` when it is enabled; undefined for a reserved, unclassified or unknown name. */
function enabledApprovalRow(table: ClassificationTable, operation: string) {
  const row = Object.hasOwn(table, operation) ? table[operation] : undefined;
  return row?.class === "approval-required" && row.status === "enabled" ? row : undefined;
}

const RESERVED_DECISION: FinishDecision = {
  state: "failed",
  code: "operation-reserved",
  note: null,
  evidence: null,
  reconciled: false,
};

const ZERO: RecoverySummary = {
  expired: 0,
  reconciled: 0,
  retried: 0,
  unknown: 0,
  lapsed: 0,
  claimed: 0,
  failed: 0,
  purged: 0,
};

export interface Recovery {
  recover(): Promise<RecoverySummary>;
}

export function createRecovery(host: RecoveryHost): Recovery {
  const { store, registry, clock, log } = host;

  type Counts = { -readonly [K in keyof RecoverySummary]: number };

  /** Reconciles one executing request first, then retries it once, or records what the evidence supports. */
  async function recoverExecuting(proposal: StoredProposal, counts: Counts): Promise<void> {
    const definition = registry.lookup(proposal.operation);
    const row = enabledApprovalRow(registry.table, proposal.operation);
    if (definition === undefined || row === undefined) {
      // The row was claimed, so an executor may have run before the operation was
      // reserved or unregistered: the only honest state is unknown, never failed.
      if (host.finish(proposal, unknownDecision("operation-unavailable", null)) !== null) {
        counts.unknown += 1;
      }
      return;
    }
    const payload = host.verifiedPayload(definition, proposal);
    if (!payload.ok) {
      // The row cannot be trusted, so nothing is asked of the operation; an effect may have happened.
      if (host.finish(proposal, unknownDecision(payload.code, null)) !== null) counts.unknown += 1;
      return;
    }

    const context: ExecuteContext = {
      idempotencyKey: proposal.proposalId,
      claimFacts: proposal.claimFacts ?? {},
      attempt: proposal.attempts,
    };
    // Reconcile BEFORE anything else (D-17): evidence that the effect happened ends the matter.
    const consulted = await consultReconcile(definition, payload.value, context);
    const mayRetry =
      consulted.verdict?.kind === "effect-absent" &&
      row.retry === "idempotent" &&
      proposal.attempts < 2 &&
      tokenExpiryMs(proposal, row.maxApprovalAgeMs) > Date.parse(clock.now());
    if (!mayRetry) {
      const finished = host.finish(proposal, consulted.decision);
      if (finished?.state === "executed") counts.reconciled += 1;
      else if (finished?.state === "unknown") counts.unknown += 1;
      return;
    }

    const begun = store.beginRetry(proposal.proposalId, clock.now());
    if (begun.kind === "exhausted") {
      if (host.finish(proposal, unknownDecision("outcome-unknown", "effect-absent")) !== null) {
        counts.unknown += 1;
      }
      return;
    }
    // `not-executing` and `lost`: someone else already moved the request; there is nothing to retry.
    if (begun.kind !== "retrying") return;
    counts.retried += 1;
    log.info({
      proposalId: begun.proposal.proposalId,
      state: begun.proposal.state,
      attempt: begun.proposal.attempts,
      code: "retried-after-restart",
    });
    host.announce(begun.proposal);
    // The engine's own runner: a refusal or failure here goes back through `reconcile`.
    host.startAttempt(begun.proposal);
  }

  /** An approved request of a reserved or unregistered operation is claimed so it can be finished, and failed. */
  function failUnexecutable(approved: StoredProposal, counts: Counts): void {
    const claim = store.claim(approved.proposalId, {}, clock.now());
    if (claim.kind !== "claimed") return;
    host.announce(claim.proposal);
    if (host.finish(claim.proposal, RESERVED_DECISION) !== null) counts.failed += 1;
  }

  async function recoverApproved(counts: Counts): Promise<void> {
    for (const approved of store.listApprovedUnclaimed()) {
      if (host.isActive(approved.proposalId)) continue;
      if (enabledApprovalRow(registry.table, approved.operation) === undefined) {
        await guarded(approved, () => failUnexecutable(approved, counts));
      }
    }
    counts.lapsed += host.lapseStale(clock.now());
    for (const approved of store.listApprovedUnclaimed()) {
      if (host.isActive(approved.proposalId)) continue;
      const definition = registry.lookup(approved.operation);
      if (definition === undefined) continue;
      await guarded(approved, async () => {
        if (await host.claimAndStart(approved, definition)) counts.claimed += 1;
      });
    }
  }

  /** One bad row must not stop the rest: it is logged by id and fixed code and left for the next restart. */
  async function guarded(
    proposal: StoredProposal,
    work: () => void | Promise<void>,
  ): Promise<void> {
    try {
      await work();
    } catch {
      // The error text is never read: it could carry a path or a name.
      log.error({ proposalId: proposal.proposalId, code: "recovery-row-failed" });
    }
  }

  async function recover(): Promise<RecoverySummary> {
    const counts: Counts = { ...ZERO };
    counts.expired = host.expireDue(clock.now());

    for (const executing of store.listExecuting()) {
      if (host.isActive(executing.proposalId)) continue;
      await guarded(executing, () => recoverExecuting(executing, counts));
    }
    await recoverApproved(counts);

    const cutoff = new Date(Date.parse(clock.now()) - PAYLOAD_RETENTION_MS).toISOString();
    counts.purged = store.purgeDecidedPayloads(cutoff);

    log.info({ code: "recovered", counts: { ...counts } });
    return { ...counts };
  }

  return { recover };
}
