import type { z } from "zod";
import type { Requester } from "./approval.js";
import type { DiffLineKind } from "./approval-view.js";
import type { CapabilityToken } from "./capability.js";
import type { EnabledOperation } from "./classification.js";

/**
 * The contract between the approval engine and each operation it can carry out
 * (D-17, D-43, research Pattern 4). Types only: no runtime export, no `node:`
 * import. An operation is registered with the engine as an
 * {@link OperationDefinition}; the engine owns the state machine, the token,
 * the claim and crash recovery, and the operation owns what it does.
 *
 * The definition is constrained to {@link EnabledOperation}, so an operation
 * that needs no approval, or one that is classified but reserved, cannot have a
 * definition at all.
 */

/** JSON-safe facts read before the claim and recorded with it (for force-terminate: the pid and process start). */
export type ClaimFacts = Readonly<Record<string, string | number | boolean | null>>;

/** Why an operation refused before doing anything. Nothing was done, so `failed` with this code is truthful on a first attempt. */
export type RefusalCode = "process-ended" | "identity-mismatch" | "run-not-found";

/** Why an attempted operation definitively did not apply. */
export type FailureCode = "execution-failed" | "capability-refused" | "payload-invalid";

/**
 * What `execute` reports. `executed` means the effect was performed (an
 * `awaiting-exit` style note may qualify it). A refusal or failure is
 * definitive only on a first attempt; after a restart the engine asks
 * `reconcile` before recording anything (D-17).
 *
 * An `execute` that REJECTS (throws) is treated by the engine as an unknown
 * outcome, never as a failure, because an effect may already have started. An
 * executor must therefore not swallow an exception after the effect could have
 * begun; it lets the exception propagate or returns `failed` only when it can
 * prove nothing was done.
 */
export type ExecuteOutcome =
  | { readonly kind: "executed"; readonly note?: string }
  | { readonly kind: "refused"; readonly reason: RefusalCode }
  | { readonly kind: "failed"; readonly reason: FailureCode };

/**
 * What `reconcile` finds. It is read-only and never has an effect. It is asked
 * before any retry or failure is recorded after a restart, and it answers
 * `effect-proven` only on correlated durable evidence. `effect-absent` allows a
 * retry only when the operation's row says `idempotent`.
 */
export type ReconcileVerdict =
  | { readonly kind: "effect-proven"; readonly evidence: string }
  | { readonly kind: "effect-absent" }
  | { readonly kind: "unknown"; readonly reason: string };

/** Handed to `execute` and `reconcile`: enough for the operation to find its own effect by key. */
export interface ExecuteContext {
  /** The proposal id, never regenerated: an operation that records an effect keys it by this. */
  readonly idempotencyKey: string;
  /** The facts recorded at claim time. */
  readonly claimFacts: ClaimFacts;
  /** 1 on the first attempt, 2 on the single retry after a restart. */
  readonly attempt: number;
}

/** What `render` may depend on besides the stored payload. Engine-held data only. */
export interface RenderContext {
  /** Engine-assigned kind and requester-supplied label. */
  readonly requester: Requester;
}

export interface DraftTargetRow {
  readonly label: string;
  readonly value: string;
  /** Show the value in a monospace face (a process, an id). */
  readonly mono: boolean;
}

export interface DraftDiffLineInput {
  readonly kind: DiffLineKind;
  readonly text: string;
  readonly count?: number;
}

export type DraftChange =
  | { readonly type: "diff"; readonly lines: readonly DraftDiffLineInput[] }
  | {
      readonly type: "payload";
      readonly fields: readonly { readonly label: string; readonly value: string }[];
    }
  | { readonly type: "none" };

/**
 * What `render` returns, before the engine neutralises and caps it into an
 * `ApprovalItemView`. `render` is synchronous and pure over the stored payload:
 * everything the owner is shown is captured in the payload at submit time, so
 * what is displayed is what is hashed.
 */
export interface ApprovalItemDraft {
  readonly title: string;
  readonly destructive: boolean;
  /** The sentence under Approve once for a destructive request, or null. */
  readonly effect: string | null;
  /** The engine-templated "what will happen" sentence. */
  readonly action: string;
  /** The run's display name, or null when the request is not part of a run. */
  readonly runName: string | null;
  readonly target: readonly DraftTargetRow[];
  readonly change: DraftChange;
  /** True when the change text came from the requester rather than the engine. */
  readonly changeFromRequester: boolean;
  readonly risks: readonly string[];
  /** The fixed "what to check" line, or null. */
  readonly checkHint: string | null;
}

export interface OperationDefinition<Op extends EnabledOperation, Payload> {
  readonly operation: Op;
  /** Strict. Validated at submit and validated again at execute, from the stored row. */
  readonly payload: z.ZodType<Payload>;
  /**
   * The subject the payload targets (for force-terminate, the run id). When
   * present the engine requires a request's `subject` to equal it, so the
   * subject a capability token covers is the target the owner was shown.
   */
  subjectOf?(payload: Payload): string;
  /** Read-only facts gathered before the claim transaction. */
  claimFacts?(payload: Payload): Promise<ClaimFacts>;
  /** Carries the approved action out. Reads the payload from the stored row, never from a request. */
  execute(
    token: CapabilityToken<Op>,
    payload: Payload,
    context: ExecuteContext,
  ): Promise<ExecuteOutcome>;
  /** Read-only: has the effect happened? Never has an effect of its own. */
  reconcile(payload: Payload, context: ExecuteContext): Promise<ReconcileVerdict>;
  /** Pure and synchronous: the owner-facing description of this payload. */
  render(payload: Payload, context: RenderContext): ApprovalItemDraft;
}
