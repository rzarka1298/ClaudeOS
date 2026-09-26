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

/**
 * The eight {@link RunState} members as a runtime tuple, in lifecycle
 * order, for `z.enum(RUN_STATES)` and for store-side validation. The
 * `satisfies` clause plus {@link MissingRunState} make it a compile error for
 * this list and the union above to disagree in either direction, so the
 * union stays the single declaration and this tuple can never drift from it.
 */
export const RUN_STATES = [
  "queued",
  "starting",
  "running",
  "waiting-for-approval",
  "completed",
  "failed",
  "cancelled",
  "stale",
] as const satisfies readonly RunState[];

/** Resolves to `never` exactly when {@link RUN_STATES} covers every RunState. */
type MissingRunState = Exclude<RunState, (typeof RUN_STATES)[number]>;
const runStatesAreExhaustive: [MissingRunState] extends [never] ? true : never = true;
void runStatesAreExhaustive;

/**
 * The shape {@link newRunId} mints: a 9-character base-36 millisecond prefix
 * followed by 16 lowercase hex characters. Used to validate a RunId that
 * crosses a process boundary (a hook's `CCC_RUN_ID` hint, a session-action
 * body) without ever minting one from outside input (ADR-0006).
 */
export const RUN_ID_PATTERN = /^[0-9a-z]{25}$/;
