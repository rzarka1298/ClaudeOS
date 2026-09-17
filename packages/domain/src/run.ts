import type { RunId } from "./ids.js";

/**
 * The normalized lifecycle every Run (Session or Automation Run) carries.
 * Exact eight-member union — `stale` is the state of a Run whose ending was
 * never observed, distinct from a Run known to have `failed` (CONTEXT.md:
 * the difference is between silence and evidence).
 */
export type RunState =
  | "queued"
  | "starting"
  | "running"
  | "waiting-for-approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "stale";

export interface Run {
  readonly runId: RunId;
  readonly state: RunState;
  readonly startedAt: string;
  readonly endedAt: string | null;
}
