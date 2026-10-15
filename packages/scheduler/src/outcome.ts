// RED STUB (07-05 task 2): signatures only. The green commit implements it.

import type { JobRunOutcome, RunErrorCode } from "@ccc/domain";

export interface OutcomeInput {
  readonly succeeded: number;
  readonly failed: number;
  readonly stageError: RunErrorCode | null;
}

export function deriveOutcome(_input: OutcomeInput): JobRunOutcome {
  return "success";
}
