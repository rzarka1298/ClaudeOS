import { createHash } from "node:crypto";
import { basename } from "node:path";
import {
  type CodexRecognitionVerdict,
  EMPTY_CARRY,
  foldTurnTokens,
  parseRolloutChunk,
  type TranscriptCarry,
} from "@ccc/collectors";
import type { CodexTokenSummary } from "@ccc/domain";
import {
  type addCodexRecognition,
  type addCumulativeDelta,
  codexBucketStart,
  markCodexDayCovered,
  readCodexCursor,
  type readCumulativeBaseline,
  upsertTurnTokens,
  writeCodexCursor,
  type writeCumulativeBaseline,
} from "@ccc/operational-store";
import type Database from "better-sqlite3";
import { addDays, localDayOf } from "../claude/usage-summary.js";
import { CodexHomeAccessError, type CodexHomePort, type RolloutRef } from "./codex-home.js";
import { buildCodexTokenSummary } from "./token-summary.js";

/**
 * The Codex token scanner (plan 05.1-23, D-17, D-24, CODEX-04, CODEX-07,
 * CODEX-10). It mirrors the Phase 5 transcript scanner:
 *
 * - Gate: nothing is listed, statted, opened or parsed unless transcript
 *   analysis is on (the one shared toggle, D-17). The check runs before every
 *   file and every chunk, and again after a chunk's read, so switching
 *   analysis off stops a scan at the next chunk boundary.
 * - Access: every file operation goes through the allowlisted CODEX_HOME port
 *   with a reference the port itself listed; the scanner never opens a path it
 *   computed.
 * - Counting: the per-turn usage record keeps the LATEST cumulative value per
 *   (thread, turn) and the quarter hour of the turn's first record (the store
 *   takes the per-counter maximum, so a replay never lowers or doubles it).
 * - Cursors: keyed by the SHA-256 of the rollout path (no path is stored),
 *   with a content fingerprint of the file's first bytes standing in for an
 *   inode (the port offers none). A changed fingerprint or a shrunk file
 *   restarts at zero; the store's primary key keeps the rescan from double
 *   counting.
 * - Transaction: a chunk's counters, cursor advance and (later) high-water
 *   marks and recognition tallies are written in ONE transaction.
 * - Privacy: only the pure parser's token facts (six counters, ids, times) are
 *   used; the parsed lines are dropped. Logs carry reason codes and counts.
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

const DAY_MS = 86_400_000;
/** Bytes of a file's head that make up its identity. */
const IDENTITY_BYTES = 256;

export interface TokenScannerTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface TokenScannerLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

/**
 * The store functions the chunk transaction calls. Injectable so a test can
 * make one of them fail between the delta, high-water-mark and cursor writes.
 */
export interface TokenStoreOps {
  readonly upsertTurnTokens: typeof upsertTurnTokens;
  readonly addCumulativeDelta: typeof addCumulativeDelta;
  readonly readCumulativeBaseline: typeof readCumulativeBaseline;
  readonly writeCumulativeBaseline: typeof writeCumulativeBaseline;
  readonly writeCodexCursor: typeof writeCodexCursor;
  readonly addCodexRecognition: typeof addCodexRecognition;
}

export interface TokenScannerDeps {
  readonly db: Database.Database;
  readonly port: Pick<CodexHomePort, "listRolloutFiles" | "statRollout" | "readRolloutRange">;
  readonly logger: TokenScannerLogger;
  readonly now: () => Date;
  /** The local time zone ranges and covered days are computed in (D-45). */
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
  /** Overrides the parser version (tests simulate a parser upgrade). */
  readonly parserVersion?: number;
  /** Overrides store functions in the chunk transaction (tests inject a failure). */
  readonly ops?: Partial<TokenStoreOps>;
}

export type ScanOutcome =
  | { readonly kind: "scanned"; readonly counted: number; readonly bytes: number }
  | { readonly kind: "unchanged" }
  /** Analysis is off: nothing was touched. */
  | { readonly kind: "skipped" }
  /** The port refused the reference: nothing was opened. */
  | { readonly kind: "refused" }
  | { readonly kind: "missing" }
  /** Analysis was switched off (or the scanner cancelled) mid-scan. */
  | { readonly kind: "cancelled" }
  /** The recognition verdict is unavailable: nothing read, no cursor or coverage moved. */
  | { readonly kind: "held" }
  /** The sweep's file or byte budget ran out; the rest carries to the next sweep. */
  | { readonly kind: "capped" };

export interface SweepOutcome {
  /** True only when every listed file was visited without cancellation, cap or failure. */
  readonly completed: boolean;
  readonly files: number;
  /** Files whose stat or read failed unexpectedly; logged by code and skipped. */
  readonly failedFiles: number;
  readonly held: boolean;
  readonly capped: boolean;
}

export interface TokenScanner {
  /** Scans every listed rollout of the last 31 days, then marks the covered days. */
  sweep(): Promise<SweepOutcome>;
  /** Scans one rollout from its cursor (never marks coverage). */
  scanFile(ref: RolloutRef): Promise<ScanOutcome>;
  /** The current summary, computed synchronously from the store. */
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

function defaultYield(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** The cursor key: the SHA-256 hex of the rollout path. The path itself is never stored. */
function cursorKeyOf(path: string): string {
  return createHash("sha256").update(path).digest("hex");
}

/** A file's identity: a hash of its first bytes (the port offers no inode). */
function identityOf(head: Uint8Array): string {
  return createHash("sha256").update(head).digest("hex").slice(0, 32);
}

const ROLLOUT_THREAD =
  /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([A-Za-z0-9][A-Za-z0-9_-]{0,126})\.jsonl$/;

/** The thread id in a rollout's file name, or null for any other shape. The name is never stored. */
function threadIdFromName(path: string): string | null {
  const match = ROLLOUT_THREAD.exec(basename(path));
  return match?.[1] ?? null;
}

const ROLLOUT_DAY = /\/(\d{4})\/(\d{2})\/(\d{2})\/rollout-[^/]*$/;

/** The dated folder's day of a rollout path, or null. */
function dayOfPath(path: string): string | null {
  const match = ROLLOUT_DAY.exec(path);
  return match === null ? null : `${match[1]}-${match[2]}-${match[3]}`;
}

function errorCode(err: unknown): unknown {
  return (err as { code?: unknown } | null)?.code;
}

export function createTokenScanner(deps: TokenScannerDeps): TokenScanner {
  const { db, logger, port } = deps;
  const chunkBytes = Math.max(
    1,
    Math.min(deps.chunkBytes ?? CODEX_TOKEN_CHUNK_BYTES, CODEX_TOKEN_CHUNK_BYTES),
  );
  const yieldNow = deps.yieldNow ?? defaultYield;
  let generation = 0;
  let chain: Promise<unknown> = Promise.resolve();
  let lastScanAt: string | null = null;

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = chain.then(work, work);
    chain = next.catch(() => undefined);
    return next;
  }

  function summary(): CodexTokenSummary {
    return buildCodexTokenSummary({
      db,
      now: deps.now(),
      timeZone: deps.timeZone,
      analysisOn: deps.isAnalysisOn(),
      firstScanPending: false,
      recognition: { kind: "ok" },
      horizonDay: null,
      lastScanAt,
    });
  }

  async function scanOne(ref: RolloutRef, gen: number): Promise<ScanOutcome> {
    const alive = () => gen === generation && deps.isAnalysisOn();
    if (!alive()) return { kind: "skipped" };

    let size: number;
    try {
      const stat = port.statRollout(ref);
      if (stat === null) return { kind: "missing" };
      size = stat.size;
    } catch (err: unknown) {
      if (err instanceof CodexHomeAccessError) {
        logger.warn({ reason: err.code }, "codex rollout refused");
        return { kind: "refused" };
      }
      throw err;
    }
    if (size === 0) return { kind: "unchanged" };

    const key = cursorKeyOf(ref.path);
    const cursor = readCodexCursor(db, key);
    // Fully consumed and the same size: nothing to read, not even the identity head.
    if (cursor !== null && cursor.offset === size && cursor.size === size) {
      return { kind: "unchanged" };
    }
    const head = port.readRolloutRange(ref, 0, IDENTITY_BYTES).bytes;
    const identity = identityOf(head);
    const resume = cursor !== null && cursor.inode === identity && cursor.offset <= size;
    let position = resume ? cursor.offset : 0;
    if (resume && position === size) return { kind: "unchanged" };

    const fallbackThreadId = threadIdFromName(ref.path) ?? undefined;
    let carry: TranscriptCarry = EMPTY_CARRY;
    let counted = 0;
    let bytes = 0;
    while (position + carry.bytes.length < size) {
      if (!alive()) return { kind: "cancelled" };
      const readAt = position + carry.bytes.length;
      const length = Math.min(chunkBytes, size - readAt);
      const chunk = port.readRolloutRange(ref, readAt, length).bytes;
      // Re-checked after the read: a switch-off during it writes nothing.
      if (!alive()) return { kind: "cancelled" };
      if (chunk.length === 0) break;
      const result = parseRolloutChunk(chunk, carry);
      const fold = foldTurnTokens(result.facts, {
        dayOf: (iso) => codexBucketStart(iso) ?? "",
        ...(fallbackThreadId === undefined ? {} : { fallbackThreadId }),
      });
      const nextPosition = position + result.bytesConsumed;
      const at = deps.now().toISOString();
      db.transaction(() => {
        for (const entry of fold.entries.values()) {
          if (entry.day === "") continue;
          upsertTurnTokens(db, {
            threadId: entry.threadId,
            turnId: entry.turnId,
            bucketStart: entry.day,
            counters: entry.counters,
            observedAt: new Date(Date.parse(entry.at)).toISOString(),
          });
          counted += 1;
        }
        writeCodexCursor(db, key, { inode: identity, size, offset: nextPosition }, at);
      })();
      bytes += chunk.length;
      position = nextPosition;
      carry = result.carry;
      await yieldNow();
    }
    return { kind: "scanned", counted, bytes };
  }

  /** Every day from the oldest rollout day to today is covered once a full sweep completes. */
  function markCoveredDays(oldestDay: string | null): void {
    const nowMs = deps.now().getTime();
    const at = new Date(nowMs).toISOString();
    const today = localDayOf(nowMs, deps.timeZone);
    db.transaction(() => {
      let day = oldestDay ?? today;
      for (let i = 0; day <= today && i < CODEX_LISTING_DAYS + 2; i += 1) {
        markCodexDayCovered(db, day, at);
        day = addDays(day, 1);
      }
    })();
  }

  async function sweepAll(gen: number): Promise<SweepOutcome> {
    const alive = () => gen === generation && deps.isAnalysisOn();
    const none: SweepOutcome = {
      completed: false,
      files: 0,
      failedFiles: 0,
      held: false,
      capped: false,
    };
    if (!alive()) return none;
    const nowMs = deps.now().getTime();
    const refs = port.listRolloutFiles({ from: nowMs - CODEX_LISTING_DAYS * DAY_MS, to: nowMs });
    let scanned = 0;
    let failedFiles = 0;
    let oldest: string | null = null;
    for (const ref of refs) {
      if (!alive()) return { ...none, files: scanned, failedFiles };
      const day = dayOfPath(ref.path);
      if (day !== null && (oldest === null || day < oldest)) oldest = day;
      try {
        const outcome = await scanOne(ref, gen);
        if (outcome.kind === "cancelled" || outcome.kind === "skipped") {
          return { ...none, files: scanned, failedFiles };
        }
      } catch (err: unknown) {
        logger.warn({ code: errorCode(err) }, "codex token scan failed; skipped");
        failedFiles += 1;
        await yieldNow();
        continue;
      }
      scanned += 1;
      await yieldNow();
    }
    if (!alive()) return { ...none, files: scanned, failedFiles };
    if (failedFiles === 0) markCoveredDays(oldest);
    lastScanAt = deps.now().toISOString();
    return { ...none, completed: failedFiles === 0, files: scanned, failedFiles };
  }

  return {
    scanFile(ref) {
      const gen = generation;
      return enqueue(() => scanOne(ref, gen));
    },
    sweep() {
      const gen = generation;
      return enqueue(() => sweepAll(gen));
    },
    summary,
    refreshIfStale: () => undefined,
    start: () => undefined,
    stop: () => undefined,
    onAnalysisChanged: () => undefined,
    cancel() {
      generation += 1;
    },
    reset() {
      generation += 1;
      lastScanAt = null;
    },
    async idle() {
      await chain;
    },
    recognition: () => ({ kind: "ok" }),
  };
}
