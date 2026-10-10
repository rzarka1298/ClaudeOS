import type { CodexTokenCounters } from "@ccc/domain";
import type Database from "better-sqlite3";
import { USAGE_BUCKET_MS } from "./usage-store.js";

/**
 * Codex persistence (Phase 05.1, D-15, D-24, CODEX-08, CODEX-10): per-turn
 * token counters, additive deltas, durable cumulative high-water marks, hashed
 * rollout cursors, the coverage ledger, recognition tallies and the last
 * normalised rate-limit snapshot. Counters, hashed keys and identifiers only:
 * nothing here accepts or stores a prompt, a reply, a title, a path or an account.
 */

/** Thrown before any write when a Codex record is malformed. */
export class InvalidCodexRecordError extends Error {
  constructor(reason: string) {
    super(`Codex record is invalid: ${reason}`);
    this.name = "InvalidCodexRecordError";
  }
}

export interface TurnTokensInput {
  readonly threadId: string;
  readonly turnId: string;
  readonly bucketStart: string;
  readonly counters: CodexTokenCounters;
  readonly observedAt: string;
}

export interface CumulativeDeltaInput {
  readonly threadId: string;
  readonly bucketStart: string;
  readonly delta: CodexTokenCounters;
}

export interface CodexTokenRangeQuery {
  readonly start: string;
  readonly end: string;
}

export interface CodexTokenTotals {
  readonly counters: CodexTokenCounters;
  readonly rows: number;
}

void USAGE_BUCKET_MS;

export function codexBucketStart(_timestamp: string): string | null {
  throw new Error("not implemented");
}
export function upsertTurnTokens(_db: Database.Database, _input: TurnTokensInput): void {
  throw new Error("not implemented");
}
export function addCumulativeDelta(_db: Database.Database, _input: CumulativeDeltaInput): void {
  throw new Error("not implemented");
}
export function readCumulativeBaseline(
  _db: Database.Database,
  _threadId: string,
): CodexTokenCounters | null {
  throw new Error("not implemented");
}
export function writeCumulativeBaseline(
  _db: Database.Database,
  _threadId: string,
  _counters: CodexTokenCounters,
  _at: string,
): void {
  throw new Error("not implemented");
}
export function queryCodexTokenTotals(
  _db: Database.Database,
  _query: CodexTokenRangeQuery,
): CodexTokenTotals | null {
  throw new Error("not implemented");
}
