// The trusted stage for the summariser's answer (plan 07-07, D-06, D-15, research Pattern 6).
// SIGNATURE STUB for the red commit: the behaviour arrives in the green commit.

import type { ReportItem } from "@ccc/domain";

export interface ClaimCounts {
  readonly droppedItems: number;
  readonly droppedIds: number;
  readonly downgraded: number;
  readonly addressesRemoved: number;
  readonly controlCharsRemoved: number;
  readonly truncated: number;
}

export interface ValidateSummariserOptions {
  /** Each fetched source id mapped to its sanitised text. */
  readonly sources: Readonly<Record<string, string>>;
}

export type SummariserValidation =
  | { readonly ok: true; readonly items: readonly ReportItem[]; readonly counts: ClaimCounts }
  | { readonly ok: false; readonly code: "summariser-invalid-output" };

export function validateSummariserOutput(
  _answer: string,
  _options: ValidateSummariserOptions,
): SummariserValidation {
  return { ok: false, code: "summariser-invalid-output" };
}
