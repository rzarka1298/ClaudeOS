import type { ApprovalRequiredOperation } from "./classification.js";

declare const capabilityOperation: unique symbol;

/**
 * A single-use, single-operation authorization per ADR-0012. `APPR-01`
 * requires the approval engine to be a choke point enforced at the import
 * boundary rather than by convention: a write method typed to require a
 * CapabilityToken cannot be called without one, and nothing in this
 * package can construct one, so forgetting to require it does not compile
 * rather than silently drifting.
 *
 * This module defines the type shape only. No issuing function, no
 * verification function, and no always-allow or blanket-scope value exists
 * here — per CONTEXT.md, an Approval is "never persistent, never blanket."
 * The approval engine's single minter module (in the service package) is the
 * only place a token is constructed; the grep backstop and the import
 * boundary confine it there.
 *
 * The operation is constrained to the approval-required rows of the static
 * classification table (`classification.ts`): a token for a no-approval or
 * direct-gesture operation, or for a name the table does not know, does not
 * compile (D-02, T-06-01).
 *
 * `subject` names the one thing the approval covers (for
 * `session.force-terminate`, the RunId). A capability-typed executor still
 * compares `operation`, `subject` and `expiresAt` itself at run time and
 * refuses a mismatch or an expired token: the type proves a token was
 * required, not that this token was issued for this call.
 */
export interface CapabilityToken<TOperation extends ApprovalRequiredOperation> {
  readonly proposalId: string;
  readonly operation: TOperation;
  /** The id of the single target the approval covers (a RunId for force-terminate). */
  readonly subject: string;
  readonly expiresAt: string;
  readonly [capabilityOperation]: TOperation;
}
