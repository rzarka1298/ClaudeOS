// Outcome derivation for a finished research run (plan 07-05, D-10, research
// Pattern 1). Pure and Node-free.
//
//   failure  no source succeeded, or any stage error occurred
//   partial  at least one source succeeded and at least one failed
//   success  otherwise
//
// `partial` is never a failure: it is a completed run that lost a source
// (ADR-0002: partiality is a flag beside the state). `skipped` and `missed` are
// reserved for milestone 2 and are never returned here.

import type { JobRunOutcome, RunErrorCode } from "@ccc/domain";

export interface OutcomeInput {
  /** Sources that contributed text. */
  readonly succeeded: number;
  /** Sources that could not contribute. */
  readonly failed: number;
  /** The typed error of a stage that failed after the fetch (summariser, vault write), or null. */
  readonly stageError: RunErrorCode | null;
}

function requireCount(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
}

export function deriveOutcome(input: OutcomeInput): JobRunOutcome {
  requireCount(input.succeeded, "succeeded");
  requireCount(input.failed, "failed");
  if (input.stageError !== null) return "failure";
  if (input.succeeded === 0) return "failure";
  if (input.failed > 0) return "partial";
  return "success";
}
