import type { ItemStatus } from "./results.js";

export interface AutoOutcome {
  readonly item: number;
  readonly status: ItemStatus;
}

export interface ApplyInput {
  readonly text: string;
  readonly outcomes: readonly AutoOutcome[];
  /** Eight lowercase hex characters. */
  readonly runId: string;
  /** An ISO date, YYYY-MM-DD; passed in so the output is deterministic. */
  readonly date: string;
}

export function applyAutoResults(_input: ApplyInput): string {
  throw new Error("applyAutoResults is not implemented yet (typed skeleton)");
}
