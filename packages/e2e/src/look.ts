import type { LookHandoff, LookPendingItem } from "./run-uat.js";

/** The state file the run leaves in the shots folder for the look command (05.2-09, D-11). */
export const LOOK_PENDING_FILE = "look-pending.json";

export interface LookState {
  runId: string;
  reportPath: string | null;
  items: LookPendingItem[];
}

export interface VerdictInput {
  shotsDir: string;
  item: number;
  verdict: "pass" | "fail";
  /** The number of images the caller says it looked at. */
  images: number;
}

export interface VerdictResult {
  item: number;
  status: "pass" | "fail";
  remaining: number;
}

export function writeLookHandoff(_input: LookHandoff): void {
  throw new Error("writeLookHandoff is not implemented yet (typed skeleton)");
}

export function listPending(_shotsDir: string): LookState {
  throw new Error("listPending is not implemented yet (typed skeleton)");
}

export function recordVerdict(_input: VerdictInput): VerdictResult {
  throw new Error("recordVerdict is not implemented yet (typed skeleton)");
}
