import type { RolloutFact, TranscriptCarry } from "@ccc/collectors";
import type { CodexHomePort, RolloutRef } from "./codex-home.js";

/** RED stub (plan 05.1-22 task 1): signatures only. */

export const FIRST_SIGHT_BYTES = 256 * 1024;
export const DEFAULT_TAIL_READ_BYTES = 1024 * 1024;

export type RolloutTailPort = Pick<CodexHomePort, "statRollout" | "readRolloutRange">;

export interface RolloutTailEntry {
  readonly size: number;
  readonly mtimeMs: number;
  readonly readTo: number;
  readonly carry: TranscriptCarry;
  readonly retained: readonly RolloutFact[];
  readonly lines: number;
  readonly recognized: number;
}

export interface RolloutTailOptions {
  readonly firstSightBytes?: number;
  readonly maxBytes?: number;
}

export type RolloutTailResult =
  | { readonly kind: "missing" }
  | { readonly kind: "failed" }
  | { readonly kind: "deferred" }
  | {
      readonly kind: "ok";
      readonly entry: RolloutTailEntry;
      readonly bytesRead: number;
      readonly fresh: boolean;
      readonly caughtUp: boolean;
    };

export function readRolloutTail(
  _port: RolloutTailPort,
  _ref: RolloutRef,
  _previous: RolloutTailEntry | undefined,
  _options?: RolloutTailOptions,
): RolloutTailResult {
  throw new Error("not implemented");
}
