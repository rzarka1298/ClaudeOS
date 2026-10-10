import { createHash } from "node:crypto";
import { basename } from "node:path";
import {
  type CodexRecognitionVerdict,
  EMPTY_CARRY,
  evaluateCliRecognition,
  foldCumulativeDeltas,
  parseRolloutChunk,
  type RolloutFact,
  type TranscriptCarry,
  UNVERSIONED,
} from "@ccc/collectors";
import {
  type CodexTokenCounters,
  type CodexTokenSummary,
  CodexTokensUpdatedPayloadSchema,
} from "@ccc/domain";
import {
  addCodexRecognition,
  addCumulativeDelta,
  analysisOffIntervals,
  type CodexRecognitionTally,
  codexBucketStart,
  getCollectorSetting,
  listToggleLog,
  markCodexDayCovered,
  readCodexCursor,
  readCodexRecognition,
  readCumulativeBaseline,
  resetCodexScanState,
  setCollectorSetting,
  setTurnContribution,
  writeCodexCursor,
  writeCumulativeBaseline,
} from "@ccc/operational-store";
import type Database from "better-sqlite3";
import { addDays, localDayOf } from "../claude/usage-summary.js";
import {
  CodexHomeAccessError,
  type CodexHomePort,
  MAX_ROLLOUT_LIST,
  type RolloutRef,
} from "./codex-home.js";
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
 * - Counting: ONE precedence rule per thread (see reconcileTurns). The
 *   thread-cumulative `token_count` is authoritative up to its last timestamp;
 *   per-turn usage counts only beyond it, as the growth of the turn's
 *   within-turn counter past the value it had at that cut. Per-turn state is
 *   replayed idempotently, so no chunk size or cursor reset changes a total.
 * - Cursors: keyed by the SHA-256 of the rollout path (no path is stored),
 *   with a content fingerprint of the file's first bytes standing in for an
 *   inode (the port offers none). A changed fingerprint or a shrunk file
 *   restarts at zero; the store's primary key keeps the rescan from double
 *   counting.
 * - Cumulative usage: non-negative per-counter deltas against a durable
 *   per-thread high-water mark (D-24). A lower value never lowers the mark and
 *   is never read as a new counting epoch, so a replayed prefix changes nothing.
 * - Transaction: a chunk's counters, high-water marks, cursor advance and
 *   recognition tallies are written in ONE transaction.
 * - Format: per-CLI-version recognition tallies persist per parser version; a
 *   chunk that would make the verdict unavailable records its tallies but no
 *   usage and no cursor, and from then on nothing is read (held).
 * - Coverage: a day is marked covered only by a complete, uncapped, uncancelled
 *   sweep; single-file scans count tokens but never coverage.
 * - Bounds: a sweep reads at most a fixed number of files and bytes and carries
 *   the rest to the next sweep; the timer reads only while the event stream has
 *   subscribers.
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
/** The days one sweep may mark covered, whatever the listing says. */
const MAX_COVERED_DAYS = 400;
/** Bounds on the in-memory maps (a scanner restart simply rebuilds them). */
const MAX_REMEMBERED = 10_000;

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
  readonly setTurnContribution: typeof setTurnContribution;
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

/** Settings key prefix of the per-turn precedence state (`<thread>:<turn>`). */
const TURN_STATE_PREFIX = "codex_token_turn:";
/** Settings key prefix of the per-thread last cumulative timestamp. */
const CUM_AT_PREFIX = "codex_token_cumat:";

const ZERO_COUNTERS: CodexTokenCounters = {
  input: 0,
  cachedInput: 0,
  cacheWrite: 0,
  output: 0,
  reasoningOutput: 0,
  total: 0,
};

const COUNTER_KEYS = [
  "input",
  "cachedInput",
  "cacheWrite",
  "output",
  "reasoningOutput",
  "total",
] as const satisfies readonly (keyof CodexTokenCounters)[];

/**
 * What the precedence rule keeps per (thread, turn). All counters are
 * high-waters or sums of increments, so replaying absorbed records changes
 * nothing.
 */
interface TurnState {
  /** The thread id the state belongs to (guards the key-prefix scan). */
  thread: string;
  /** The highest within-turn counters seen, counted or not. */
  hw: CodexTokenCounters;
  /** The value hw had at the thread's last cumulative timestamp. */
  cut: CodexTokenCounters;
  /** The usage that arrived while analysis was off, in total. */
  off: CodexTokenCounters;
  /** The part of `off` that arrived at or before the cut. */
  offCut: CodexTokenCounters;
  /**
   * The enabled (on-period) usage of windows an analysis-off cumulative record
   * superseded: the cumulative record's own increment is not counted, so the
   * turn keeps what it saw while analysis was on.
   */
  kept: CodexTokenCounters;
  /** The bucket of the turn's earliest record. */
  first: string | null;
  /** The bucket of the earliest record after the cut, or null. */
  anchor: string | null;
  /** The latest record time, in ms. */
  latestMs: number | null;
}

function freshTurn(): TurnState {
  return {
    thread: "",
    hw: ZERO_COUNTERS,
    cut: ZERO_COUNTERS,
    off: ZERO_COUNTERS,
    offCut: ZERO_COUNTERS,
    kept: ZERO_COUNTERS,
    first: null,
    anchor: null,
    latestMs: null,
  };
}

function turnStateKey(threadId: string, turnId: string): string {
  return `${TURN_STATE_PREFIX}${threadId}:${turnId}`;
}

/**
 * A turn's counted usage: growth beyond the cut, less the off-period growth after
 * it, plus the enabled usage an analysis-off cumulative record superseded.
 */
function contributionOf(state: TurnState): CodexTokenCounters {
  return combine(state.hw, state.cut, (hw, cut, index) =>
    Math.max(
      0,
      hw -
        cut -
        Math.max(0, counterAt(state.off, index) - counterAt(state.offCut, index)) +
        counterAt(state.kept, index),
    ),
  );
}

function counterAt(counters: CodexTokenCounters, index: number): number {
  const key = COUNTER_KEYS[index];
  return key === undefined ? 0 : counters[key];
}

function combine(
  left: CodexTokenCounters,
  right: CodexTokenCounters,
  fn: (left: number, right: number, index: number) => number,
): CodexTokenCounters {
  const out = { ...ZERO_COUNTERS };
  COUNTER_KEYS.forEach((key, index) => {
    out[key] = fn(left[key], right[key], index);
  });
  return out;
}

function parseTurnState(text: string | null): TurnState | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as Partial<Record<keyof TurnState, unknown>>;
    const counters = (c: unknown): c is CodexTokenCounters =>
      typeof c === "object" &&
      c !== null &&
      COUNTER_KEYS.every((key) => Number.isFinite((c as Record<string, unknown>)[key]));
    const optionalText = (v: unknown): v is string | null => v === null || typeof v === "string";
    if (
      typeof value.thread === "string" &&
      counters(value.hw) &&
      counters(value.cut) &&
      counters(value.off) &&
      counters(value.offCut) &&
      counters(value.kept) &&
      optionalText(value.first) &&
      optionalText(value.anchor) &&
      (value.latestMs === null || Number.isFinite(value.latestMs))
    ) {
      return {
        thread: value.thread,
        hw: value.hw,
        cut: value.cut,
        off: value.off,
        offCut: value.offCut,
        kept: value.kept,
        first: value.first,
        anchor: value.anchor,
        latestMs: value.latestMs as number | null,
      };
    }
    return null;
  } catch {
    return null;
  }
}

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
  const parserVersion = deps.parserVersion ?? CODEX_TOKEN_PARSER_VERSION;
  const ops: TokenStoreOps = {
    setTurnContribution,
    addCumulativeDelta,
    readCumulativeBaseline,
    writeCumulativeBaseline,
    writeCodexCursor,
    addCodexRecognition,
    ...deps.ops,
  };
  const chunkBytes = Math.max(
    1,
    Math.min(deps.chunkBytes ?? CODEX_TOKEN_CHUNK_BYTES, CODEX_TOKEN_CHUNK_BYTES),
  );
  const sweepIntervalMs = deps.sweepIntervalMs ?? DEFAULT_CODEX_SWEEP_MS;
  const maxFilesPerSweep = deps.maxFilesPerSweep ?? DEFAULT_MAX_FILES_PER_SWEEP;
  const maxBytesPerSweep = deps.maxBytesPerSweep ?? DEFAULT_MAX_BYTES_PER_SWEEP;
  const yieldNow = deps.yieldNow ?? defaultYield;

  let generation = 0;
  let chain: Promise<unknown> = Promise.resolve();
  let inflight: Promise<void> | null = null;
  let timerHandle: unknown = null;
  let lastScanAt: string | null = null;
  let lastSweepAtMs: number | null = null;
  let lastPublishedKey: string | null = null;
  /** The CLI version a rollout's session_meta named, by cursor key (memory only). */
  const versionByKey = new Map<string, string>();

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = chain.then(work, work);
    chain = next.catch(() => undefined);
    return next;
  }

  function nowIso(): string {
    return deps.now().toISOString();
  }

  // --- State shared with the summary ----------------------------------------

  function verdict(): CodexRecognitionVerdict {
    return evaluateCliRecognition(readCodexRecognition(db, parserVersion));
  }

  function firstScanDone(): boolean {
    return getCollectorSetting(db, CODEX_TOKEN_FIRST_SCAN_SETTING) === String(parserVersion);
  }

  function horizonDay(): string | null {
    const value = getCollectorSetting(db, CODEX_TOKEN_HORIZON_SETTING);
    return value === null || value === "" ? null : value;
  }

  function summary(): CodexTokenSummary {
    const analysisOn = deps.isAnalysisOn();
    return buildCodexTokenSummary({
      db,
      now: deps.now(),
      timeZone: deps.timeZone,
      analysisOn,
      firstScanPending: analysisOn && !firstScanDone(),
      recognition: verdict(),
      horizonDay: horizonDay(),
      lastScanAt,
    });
  }

  /** The summary without the times that move on every observation: what a viewer would see change. */
  function changeKey(current: CodexTokenSummary): string {
    const mask = (range: CodexTokenSummary["ranges"]["today"]) =>
      range.kind === "available"
        ? { ...range, observedAt: "", bounds: { start: range.bounds.start, end: "" } }
        : range;
    return JSON.stringify({
      ranges: {
        today: mask(current.ranges.today),
        "last-7-days": mask(current.ranges["last-7-days"]),
        "this-month": mask(current.ranges["this-month"]),
      },
      firstScanPending: current.firstScanPending,
    });
  }

  function publishIfChanged(): void {
    let current: CodexTokenSummary;
    try {
      current = summary();
    } catch (err: unknown) {
      logger.warn({ reason: "summary-failed", code: errorCode(err) }, "codex token summary failed");
      return;
    }
    const key = changeKey(current);
    if (key === lastPublishedKey) return;
    const payload = CodexTokensUpdatedPayloadSchema.safeParse(current);
    if (!payload.success) {
      logger.warn({ reason: "payload-invalid" }, "codex token event not published");
      return;
    }
    lastPublishedKey = key;
    deps.publish("codex.tokens.updated", payload.data);
  }

  // --- Parser version and recognition ----------------------------------------

  /**
   * Cursors built by another parser version are dropped with the coverage
   * ledger and every tally, so the next sweep rereads from zero. The counted
   * rows and the cumulative high-water marks are kept: they are what stops the
   * reread from counting anything twice.
   */
  function ensureParserVersion(): void {
    const current = String(parserVersion);
    if (getCollectorSetting(db, CODEX_TOKEN_PARSER_VERSION_SETTING) === current) return;
    db.transaction(() => {
      resetCodexScanState(db);
      setCollectorSetting(db, CODEX_TOKEN_PARSER_VERSION_SETTING, current, nowIso());
      setCollectorSetting(db, CODEX_TOKEN_HORIZON_SETTING, "", nowIso());
    })();
    versionByKey.clear();
    logger.info({ parserVersion }, "codex token parser changed; rescanning");
  }

  /** The stored tallies plus one chunk's, as the verdict would see them once committed. */
  function withChunk(
    chunk: Readonly<Record<string, CodexRecognitionTally>>,
  ): Record<string, CodexRecognitionTally> {
    const merged: Record<string, CodexRecognitionTally> = {
      ...readCodexRecognition(db, parserVersion),
    };
    for (const [version, tally] of Object.entries(chunk)) {
      const total = merged[version] ?? { sessions: 0, recognized: 0 };
      merged[version] = {
        sessions: total.sessions + tally.sessions,
        recognized: total.recognized + tally.recognized,
      };
    }
    return merged;
  }

  /**
   * The recognition tally of one chunk's token lines. A per-turn record whose
   * counters cannot be read is an unrecognised token line. A cumulative event
   * with no counters is `info: null` (older Codex versions write it) and is
   * not evidence either way; the parser cannot tell it from a malformed one.
   */
  function tallyOf(
    facts: readonly RolloutFact[],
    version: string,
  ): Record<string, CodexRecognitionTally> {
    let sessions = 0;
    let recognized = 0;
    for (const fact of facts) {
      if (fact.kind === "tokens-turn") {
        sessions += 1;
        if (fact.counters !== null) recognized += 1;
      } else if (fact.kind === "tokens-cumulative" && fact.counters !== null) {
        sessions += 1;
        recognized += 1;
      }
    }
    return sessions === 0 ? {} : { [version]: { sessions, recognized } };
  }

  function chunkVersion(facts: readonly RolloutFact[], key: string): string {
    let named: string | null = null;
    for (const fact of facts) {
      if (fact.kind === "meta" && fact.cliVersion !== null) named = fact.cliVersion;
    }
    if (named !== null) {
      if (versionByKey.size >= MAX_REMEMBERED) versionByKey.clear();
      versionByKey.set(key, named);
      return named;
    }
    return versionByKey.get(key) ?? UNVERSIONED;
  }

  // --- Analysis-off periods ---------------------------------------------------

  /** Whether an instant fell inside a period analysis was switched off (D-47). */
  function offPeriodTest(): (ms: number) => boolean {
    const intervals = analysisOffIntervals(listToggleLog(db)).map((interval) => ({
      start: Date.parse(interval.start),
      end: interval.end === null ? Number.POSITIVE_INFINITY : Date.parse(interval.end),
    }));
    return (ms) => intervals.some((interval) => ms >= interval.start && ms < interval.end);
  }

  const bucketOf = (iso: string): string => codexBucketStart(iso) ?? "";

  interface CumulativeResult {
    readonly deltas: ReadonlyMap<string, CodexTokenCounters>;
    readonly next: CodexTokenCounters | null;
    readonly touched: boolean;
    readonly skipped: number;
  }

  /**
   * Folds a thread's cumulative events against its durable mark. Events
   * timestamped inside an analysis-off period raise the mark WITHOUT adding a
   * delta, so the tokens used while analysis was off are never attributed to
   * the first record after it came back on.
   */
  function foldCumulative(
    facts: readonly RolloutFact[],
    previous: CodexTokenCounters | null,
    wasOff: (ms: number) => boolean,
  ): CumulativeResult {
    let mark = previous;
    let touched = false;
    let skipped = 0;
    const deltas = new Map<string, CodexTokenCounters>();
    let run: RolloutFact[] = [];
    let runOff = false;
    const flush = (): void => {
      if (run.length === 0) return;
      const fold = foldCumulativeDeltas(run, mark, { dayOf: bucketOf });
      mark = fold.next;
      skipped += fold.skipped;
      if (!runOff) {
        for (const [bucket, delta] of fold.deltas) {
          const known = deltas.get(bucket);
          deltas.set(
            bucket,
            known === undefined
              ? delta
              : {
                  input: known.input + delta.input,
                  cachedInput: known.cachedInput + delta.cachedInput,
                  cacheWrite: known.cacheWrite + delta.cacheWrite,
                  output: known.output + delta.output,
                  reasoningOutput: known.reasoningOutput + delta.reasoningOutput,
                  total: known.total + delta.total,
                },
          );
        }
      }
      run = [];
    };
    for (const fact of facts) {
      if (fact.kind !== "tokens-cumulative" || fact.counters === null) continue;
      if (fact.time !== null) touched = true;
      const off = fact.time !== null && wasOff(Date.parse(fact.time));
      if (run.length > 0 && off !== runOff) flush();
      runOff = off;
      run.push(fact);
    }
    flush();
    return { deltas, next: mark, touched, skipped };
  }

  // --- Scanning one rollout ---------------------------------------------------

  interface Budget {
    filesLeft: number;
    bytesLeft: number;
  }

  async function scanOne(ref: RolloutRef, gen: number, budget?: Budget): Promise<ScanOutcome> {
    const alive = () => gen === generation && deps.isAnalysisOn();
    if (!alive()) return { kind: "skipped" };
    ensureParserVersion();
    if (verdict().kind === "unavailable") return { kind: "held" };

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
    const identity = identityOf(port.readRolloutRange(ref, 0, IDENTITY_BYTES).bytes);
    const resume = cursor !== null && cursor.inode === identity && cursor.offset <= size;
    let position = resume ? cursor.offset : 0;
    const startPosition = position;
    if (resume && position === size) return { kind: "unchanged" };

    if (budget !== undefined) {
      if (budget.filesLeft <= 0) return { kind: "capped" };
      budget.filesLeft -= 1;
    }

    const fileThreadId = threadIdFromName(ref.path);
    const wasOff = offPeriodTest();
    let carry: TranscriptCarry = EMPTY_CARRY;
    let counted = 0;
    let bytes = 0;
    while (position + carry.bytes.length < size) {
      if (!alive()) return { kind: "cancelled" };
      // The cursor only moves past whole lines and the carry lives in memory, so a sweep
      // that has not yet consumed a line keeps reading: stopping would reread the same
      // bytes next sweep and never advance.
      if (budget !== undefined && budget.bytesLeft <= 0 && position > startPosition) {
        return { kind: "capped" };
      }
      const readAt = position + carry.bytes.length;
      const length = Math.min(chunkBytes, size - readAt);
      const chunk = port.readRolloutRange(ref, readAt, length).bytes;
      // Re-checked after the read: a switch-off during it writes nothing.
      if (!alive()) return { kind: "cancelled" };
      if (chunk.length === 0) break;
      if (budget !== undefined) budget.bytesLeft -= chunk.length;

      const result = parseRolloutChunk(chunk, carry);
      const at = nowIso();
      const tallies = tallyOf(result.facts, chunkVersion(result.facts, key));
      if (evaluateCliRecognition(withChunk(tallies)).kind === "unavailable") {
        // This chunk changes the verdict: keep its tallies (so the verdict survives
        // a restart) but count nothing and leave the cursor, so the period is reread
        // once a new parser recognises it.
        ops.addCodexRecognition(db, parserVersion, tallies, at);
        logger.warn({ reason: "format-not-recognised" }, "codex token format not recognised; held");
        return { kind: "held" };
      }

      const nextPosition = position + result.bytesConsumed;
      let skipped = 0;
      db.transaction(() => {
        // One precedence rule per thread (see reconcileTurns): thread-cumulative records
        // first for everything up to their last timestamp, per-turn records only beyond it.
        const turns = reconcileTurns(result.facts, fileThreadId, wasOff, at);
        skipped += turns.skipped;
        counted = turns.counted;
        if (fileThreadId !== null) {
          const previous = ops.readCumulativeBaseline(db, fileThreadId);
          const fold = foldCumulative(result.facts, previous, wasOff);
          skipped += fold.skipped;
          for (const [bucket, raw] of fold.deltas) {
            if (bucket === "") {
              skipped += 1;
              continue;
            }
            const cover = turns.offCover.get(bucket);
            const delta =
              cover === undefined
                ? raw
                : combine(raw, cover, (value, off) => Math.max(0, value - off));
            ops.addCumulativeDelta(db, { threadId: fileThreadId, bucketStart: bucket, delta });
            counted += 1;
          }
          if (fold.touched && fold.next !== null) {
            ops.writeCumulativeBaseline(db, fileThreadId, fold.next, at);
          }
        }
        ops.writeCodexCursor(db, key, { inode: identity, size, offset: nextPosition }, at);
        ops.addCodexRecognition(db, parserVersion, tallies, at);
      })();
      if (result.stats.oversized > 0 || skipped > 0) {
        logger.info({ oversized: result.stats.oversized, skipped }, "codex token lines skipped");
      }
      bytes += chunk.length;
      position = nextPosition;
      carry = result.carry;
      await yieldNow();
    }
    return { kind: "scanned", counted, bytes };
  }

  /**
   * The one precedence rule between a thread's two token sources, applied to one
   * chunk's facts IN FILE ORDER inside the chunk's transaction:
   *
   * - A thread-cumulative record is authoritative for everything up to and
   *   including its timestamp. Its usage is the positive delta against the durable
   *   high-water mark (foldCumulative); the latest such timestamp per thread, L,
   *   persists under `codex_token_cumat:<thread>` and only ever moves forward.
   * - A per-turn record counts only for usage AFTER L. Per turn the scanner keeps,
   *   under `codex_token_turn:<thread>:<turn>`: `hw` (the high-water of the
   *   within-turn counters), `cut` (the value hw had at L), `off`/`offCut` (the
   *   usage that arrived while analysis was off, in total and as of L), the first
   *   record's bucket and the first bucket after the cut. The turn's counted
   *   contribution is max(0, hw - cut - (off - offCut)), stored as the turn's row
   *   (replaced, never maxed, so it falls again when a later cumulative record
   *   covers the turn; an all-zero contribution deletes the row).
   * - When L advances to a later cumulative timestamp, every turn of the thread
   *   whose latest record is not after it is cut at its current hw (its earlier
   *   contribution is superseded); a record at or before L only raises `cut`.
   *
   * Every field is a maximum or a sum of increments over hw, so replaying records
   * the state already absorbed changes nothing: a cursor reset, a restart and any
   * chunk size reproduce identical totals. Timestamps in one rollout are taken to
   * be non-decreasing in file order (the file is append-only); a turn record
   * timestamped after a later-in-file cumulative record cannot be cut and keeps its
   * previous cut.
   */
  function reconcileTurns(
    facts: readonly RolloutFact[],
    fileThreadId: string | null,
    wasOff: (ms: number) => boolean,
    at: string,
  ): {
    readonly counted: number;
    readonly skipped: number;
    /** Off-period turn usage a counted cumulative record must not also count, by its bucket. */
    readonly offCover: ReadonlyMap<string, CodexTokenCounters>;
  } {
    interface ThreadCtx {
      cumAtMs: number | null;
      cumAtDirty: boolean;
      readonly turns: Map<string, TurnState>;
      readonly dirty: Set<string>;
      allLoaded: boolean;
    }
    const threads = new Map<string, ThreadCtx>();
    const offCover = new Map<string, CodexTokenCounters>();
    let skipped = 0;

    const ctxOf = (threadId: string): ThreadCtx => {
      let ctx = threads.get(threadId);
      if (ctx === undefined) {
        const stored = Date.parse(getCollectorSetting(db, `${CUM_AT_PREFIX}${threadId}`) ?? "");
        ctx = {
          cumAtMs: Number.isNaN(stored) ? null : stored,
          cumAtDirty: false,
          turns: new Map(),
          dirty: new Set(),
          allLoaded: false,
        };
        threads.set(threadId, ctx);
      }
      return ctx;
    };
    const turnOf = (threadId: string, ctx: ThreadCtx, turnId: string): TurnState => {
      let state = ctx.turns.get(turnId);
      if (state === undefined) {
        state =
          parseTurnState(getCollectorSetting(db, turnStateKey(threadId, turnId))) ?? freshTurn();
        ctx.turns.set(turnId, state);
      }
      return state;
    };
    const loadAll = (threadId: string, ctx: ThreadCtx): void => {
      if (ctx.allLoaded) return;
      ctx.allLoaded = true;
      const prefix = `${TURN_STATE_PREFIX}${threadId}:`;
      const rows = db
        .prepare("SELECT key, value FROM collector_settings WHERE key >= ? AND key < ?")
        .all(prefix, `${prefix.slice(0, -1)};`) as Array<{ key: string; value: string }>;
      for (const row of rows) {
        const turnId = row.key.slice(prefix.length);
        if (ctx.turns.has(turnId)) continue;
        const state = parseTurnState(row.value);
        // A thread id that is a prefix of another's cannot claim the other's turns.
        if (state !== null && state.thread === threadId) ctx.turns.set(turnId, state);
      }
    };

    for (const fact of facts) {
      if (fact.kind === "tokens-cumulative") {
        if (fileThreadId === null || fact.counters === null || fact.time === null) continue;
        const tcMs = Date.parse(fact.time);
        if (Number.isNaN(tcMs)) continue;
        const ctx = ctxOf(fileThreadId);
        if (ctx.cumAtMs !== null && tcMs <= ctx.cumAtMs) continue;
        loadAll(fileThreadId, ctx);
        const cumOff = wasOff(tcMs);
        const cumBucket = bucketOf(fact.time);
        for (const [turnId, state] of ctx.turns) {
          if (state.latestMs === null || state.latestMs > tcMs) continue;
          // The window this cumulative record supersedes, split by period.
          const offWindow = combine(state.off, state.offCut, (total, atCut) =>
            Math.max(0, total - atCut),
          );
          if (cumOff) {
            // Its own increment is not counted, so the turn keeps its enabled usage.
            const onWindow = combine(
              combine(state.hw, state.cut, (a, b) => Math.max(0, a - b)),
              offWindow,
              (all, off) => Math.max(0, all - off),
            );
            state.kept = combine(state.kept, onWindow, (known, add) => known + add);
          } else if (cumBucket !== "") {
            // Its increment includes the turn's off-period usage, which is never counted.
            const known = offCover.get(cumBucket) ?? ZERO_COUNTERS;
            offCover.set(
              cumBucket,
              combine(known, offWindow, (a, b) => a + b),
            );
          }
          state.cut = state.hw;
          state.offCut = state.off;
          state.anchor = null;
          ctx.dirty.add(turnId);
        }
        ctx.cumAtMs = tcMs;
        ctx.cumAtDirty = true;
        continue;
      }
      if (fact.kind !== "tokens-turn") continue;
      const threadId = fact.threadId ?? fileThreadId;
      const tMs = fact.time === null ? Number.NaN : Date.parse(fact.time);
      const bucket = fact.time === null ? "" : bucketOf(fact.time);
      if (fact.counters === null || threadId === null || Number.isNaN(tMs) || bucket === "") {
        skipped += 1;
        continue;
      }
      const ctx = ctxOf(threadId);
      const state = turnOf(threadId, ctx, fact.turnId);
      const value = fact.counters;
      const increment = combine(state.hw, value, (known, incoming) =>
        Math.max(0, incoming - known),
      );
      const off = wasOff(tMs);
      if (off) state.off = combine(state.off, increment, (total, add) => total + add);
      state.hw = combine(state.hw, value, (known, incoming) => Math.max(known, incoming));
      state.latestMs = state.latestMs === null ? tMs : Math.max(state.latestMs, tMs);
      if (state.first === null || bucket < state.first) state.first = bucket;
      if (ctx.cumAtMs !== null && tMs <= ctx.cumAtMs) {
        state.cut = combine(state.cut, value, (known, incoming) => Math.max(known, incoming));
        if (off) state.offCut = combine(state.offCut, increment, (total, add) => total + add);
      } else if (state.anchor === null || bucket < state.anchor) {
        state.anchor = bucket;
      }
      ctx.dirty.add(fact.turnId);
    }

    let counted = 0;
    for (const [threadId, ctx] of threads) {
      if (ctx.cumAtDirty && ctx.cumAtMs !== null) {
        setCollectorSetting(
          db,
          `${CUM_AT_PREFIX}${threadId}`,
          new Date(ctx.cumAtMs).toISOString(),
          at,
        );
      }
      for (const turnId of ctx.dirty) {
        const state = ctx.turns.get(turnId);
        if (state === undefined) continue;
        state.thread = threadId;
        setCollectorSetting(db, turnStateKey(threadId, turnId), JSON.stringify(state), at);
        const bucketStart = state.anchor ?? state.first;
        if (bucketStart === null || state.latestMs === null) continue;
        ops.setTurnContribution(db, {
          threadId,
          turnId,
          bucketStart,
          counters: contributionOf(state),
          observedAt: new Date(state.latestMs).toISOString(),
        });
        counted += 1;
      }
    }
    return { counted, skipped, offCover };
  }

  // --- Sweeping ----------------------------------------------------------------

  /** Marks the days a complete sweep covered and records that the first scan is done. */
  function markCoveredDays(oldestDay: string | null): void {
    const nowMs = deps.now().getTime();
    const at = new Date(nowMs).toISOString();
    const today = localDayOf(nowMs, deps.timeZone);
    const windowStart = localDayOf(nowMs - CODEX_LISTING_DAYS * DAY_MS, deps.timeZone);
    const horizon = oldestDay === null ? today : oldestDay < windowStart ? windowStart : oldestDay;
    db.transaction(() => {
      let day = horizon;
      for (let i = 0; day <= today && i < MAX_COVERED_DAYS; i += 1) {
        markCodexDayCovered(db, day, at);
        day = addDays(day, 1);
      }
      setCollectorSetting(db, CODEX_TOKEN_HORIZON_SETTING, horizon, at);
      setCollectorSetting(db, CODEX_TOKEN_FIRST_SCAN_SETTING, String(parserVersion), at);
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
    ensureParserVersion();
    if (verdict().kind === "unavailable") {
      publishIfChanged();
      return { ...none, held: true };
    }

    const nowMs = deps.now().getTime();
    let refs: readonly RolloutRef[];
    try {
      refs = port.listRolloutFiles({ from: nowMs - CODEX_LISTING_DAYS * DAY_MS, to: nowMs });
    } catch (err: unknown) {
      logger.warn(
        { reason: err instanceof CodexHomeAccessError ? err.code : "list-failed" },
        "codex rollouts could not be listed; coverage held",
      );
      return none;
    }
    const truncated = refs.length >= MAX_ROLLOUT_LIST;
    if (truncated)
      logger.warn({ cap: refs.length }, "codex rollout listing truncated; coverage held");

    const budget: Budget = { filesLeft: maxFilesPerSweep, bytesLeft: maxBytesPerSweep };
    let scanned = 0;
    let failedFiles = 0;
    let oldest: string | null = null;
    let held = false;
    let capped = false;
    let stopped = false;
    for (const ref of refs) {
      if (!alive()) {
        stopped = true;
        break;
      }
      const day = dayOfPath(ref.path);
      if (day !== null && (oldest === null || day < oldest)) oldest = day;
      let outcome: ScanOutcome;
      try {
        outcome = await scanOne(ref, gen, budget);
      } catch (err: unknown) {
        // One unreadable file never aborts the sweep. The error class and errno code
        // only: its message can carry the rollout path.
        logger.warn(
          { errorName: err instanceof Error ? err.name : "non-error", code: errorCode(err) },
          "codex token scan failed; skipped",
        );
        failedFiles += 1;
        await yieldNow();
        continue;
      }
      if (outcome.kind === "cancelled" || outcome.kind === "skipped") {
        stopped = true;
        break;
      }
      if (outcome.kind === "held") {
        held = true;
        break;
      }
      if (outcome.kind === "capped") {
        capped = true;
        break;
      }
      if (outcome.kind === "refused") {
        // A rollout the port refused was never read: it is a scan failure, so this
        // sweep claims neither coverage nor first-scan completion.
        failedFiles += 1;
        await yieldNow();
        continue;
      }
      scanned += 1;
      await yieldNow();
    }
    lastSweepAtMs = deps.now().getTime();
    const complete = !stopped && !held && !capped && !truncated && failedFiles === 0 && alive();
    // Coverage comes only from a full sweep that read every file: a capped, held,
    // cancelled or partly failed one leaves the days honestly not-scanned.
    if (complete) {
      markCoveredDays(oldest);
      lastScanAt = nowIso();
    }
    if (!stopped) publishIfChanged();
    return { completed: complete, files: scanned, failedFiles, held, capped };
  }

  function startSweep(): void {
    if (inflight !== null) return;
    const gen = generation;
    const run = enqueue(() => sweepAll(gen)).then(
      () => undefined,
      (err: unknown) => {
        logger.warn(
          { errorName: err instanceof Error ? err.name : "non-error" },
          "codex sweep failed",
        );
      },
    );
    const tracked: Promise<void> = run.finally(() => {
      if (inflight === tracked) inflight = null;
    });
    inflight = tracked;
  }

  return {
    scanFile(ref) {
      const gen = generation;
      return enqueue(async () => {
        const outcome = await scanOne(ref, gen);
        if (outcome.kind === "scanned") publishIfChanged();
        return outcome;
      });
    },
    sweep() {
      const gen = generation;
      return enqueue(() => sweepAll(gen));
    },
    summary,
    refreshIfStale() {
      if (!deps.isAnalysisOn() || inflight !== null) return;
      if (lastSweepAtMs !== null && deps.now().getTime() - lastSweepAtMs <= sweepIntervalMs) return;
      startSweep();
    },
    start() {
      if (timerHandle !== null) return;
      timerHandle = deps.timers.setInterval(() => {
        if (deps.subscribers() > 0 && deps.isAnalysisOn()) startSweep();
      }, sweepIntervalMs);
    },
    stop() {
      if (timerHandle !== null) {
        deps.timers.clearInterval(timerHandle);
        timerHandle = null;
      }
      generation += 1;
    },
    onAnalysisChanged(enabled) {
      if (enabled) {
        // Counted tokens already exist; the pending state shows until the first pass ends.
        publishIfChanged();
        startSweep();
        return;
      }
      generation += 1;
      publishIfChanged();
    },
    cancel() {
      generation += 1;
    },
    reset() {
      generation += 1;
      lastScanAt = null;
      lastSweepAtMs = null;
      versionByKey.clear();
      const at = nowIso();
      setCollectorSetting(db, CODEX_TOKEN_FIRST_SCAN_SETTING, "", at);
      setCollectorSetting(db, CODEX_TOKEN_HORIZON_SETTING, "", at);
      publishIfChanged();
    },
    async idle() {
      await chain;
    },
    recognition: verdict,
  };
}
