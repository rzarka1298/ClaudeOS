import type { CodexRecognitionVerdict } from "@ccc/collectors";
import type { CodexTokenSummary } from "@ccc/domain";
import type Database from "better-sqlite3";
import type { CodexHomePort, RolloutRef } from "./codex-home.js";
import { buildCodexTokenSummary } from "./token-summary.js";

/**
 * The Codex token scanner (plan 05.1-23, D-17, D-24, CODEX-10). Opt-in behind the
 * one shared transcript-analysis toggle, bounded, deduplicated per thread and
 * turn, counters only.
 */

/** The parser version the cursors, coverage and tallies were built by. */
export const CODEX_TOKEN_PARSER_VERSION = 1;
export const CODEX_TOKEN_PARSER_VERSION_SETTING = "codex_token_parser_version";
export const CODEX_TOKEN_HORIZON_SETTING = "codex_token_horizon_day";
export const CODEX_TOKEN_FIRST_SCAN_SETTING = "codex_token_first_scan_done";
export const DEFAULT_CODEX_SWEEP_MS = 300_000;
export const CODEX_TOKEN_CHUNK_BYTES = 256 * 1024;
export const DEFAULT_MAX_FILES_PER_SWEEP = 200;
export const DEFAULT_MAX_BYTES_PER_SWEEP = 64 * 1024 * 1024;
/** How far back the sweep lists rollouts. */
export const CODEX_LISTING_DAYS = 31;

export interface TokenScannerTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface TokenScannerLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface TokenScannerDeps {
  readonly db: Database.Database;
  readonly port: Pick<CodexHomePort, "listRolloutFiles" | "statRollout" | "readRolloutRange">;
  readonly logger: TokenScannerLogger;
  readonly now: () => Date;
  readonly timeZone: string;
  /** The shared toggle, read before every file and every chunk. */
  readonly isAnalysisOn: () => boolean;
  readonly subscribers: () => number;
  readonly publish: (type: "codex.tokens.updated", payload: CodexTokenSummary) => void;
  readonly timers: TokenScannerTimers;
  readonly sweepIntervalMs?: number;
  readonly chunkBytes?: number;
  readonly maxFilesPerSweep?: number;
  readonly maxBytesPerSweep?: number;
  readonly yieldNow?: () => Promise<void>;
}

export type ScanOutcome =
  | { readonly kind: "scanned"; readonly counted: number; readonly bytes: number }
  | { readonly kind: "unchanged" }
  | { readonly kind: "skipped" }
  | { readonly kind: "refused" }
  | { readonly kind: "missing" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "held" }
  | { readonly kind: "capped" };

export interface SweepOutcome {
  readonly completed: boolean;
  readonly files: number;
  readonly failedFiles: number;
  readonly held: boolean;
  readonly capped: boolean;
}

export interface TokenScanner {
  sweep(): Promise<SweepOutcome>;
  scanFile(ref: RolloutRef): Promise<ScanOutcome>;
  summary(): CodexTokenSummary;
  refreshIfStale(): void;
  start(): void;
  stop(): void;
  onAnalysisChanged(enabled: boolean): void;
  cancel(): void;
  reset(): void;
  idle(): Promise<void>;
  recognition(): CodexRecognitionVerdict;
}

export function createTokenScanner(deps: TokenScannerDeps): TokenScanner {
  const inert: SweepOutcome = {
    completed: false,
    files: 0,
    failedFiles: 0,
    held: false,
    capped: false,
  };
  return {
    sweep: async () => inert,
    scanFile: async () => ({ kind: "skipped" }),
    summary: () =>
      buildCodexTokenSummary({
        db: deps.db,
        now: deps.now(),
        timeZone: deps.timeZone,
        analysisOn: deps.isAnalysisOn(),
        firstScanPending: false,
        recognition: { kind: "ok" },
      }),
    refreshIfStale: () => undefined,
    start: () => undefined,
    stop: () => undefined,
    onAnalysisChanged: () => undefined,
    cancel: () => undefined,
    reset: () => undefined,
    idle: async () => undefined,
    recognition: () => ({ kind: "ok" }),
  };
}
