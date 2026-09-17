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
 * The approval engine that issues real tokens is Phase 6.
 */
export interface CapabilityToken<TOperation extends string> {
  readonly proposalId: string;
  readonly operation: TOperation;
  readonly expiresAt: string;
  readonly [capabilityOperation]: TOperation;
}
