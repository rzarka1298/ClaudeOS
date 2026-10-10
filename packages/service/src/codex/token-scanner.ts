import { createHash } from "node:crypto";
import { basename } from "node:path";
import {
  type CodexRecognitionVerdict,
  EMPTY_CARRY,
  evaluateCliRecognition,
  parseRolloutChunk,
  type RolloutFact,
  type TranscriptCarry,
  UNVERSIONED,
} from "@ccc/collectors";
import { type CodexTokenSummary, CodexTokensUpdatedPayloadSchema } from "@ccc/domain";
import {
  analysisOffIntervals,
  type CodexRecognitionTally,
  countLegacyUsageThreads,
  getCollectorSetting,
  isCodexCursorStale,
  listToggleLog,
  markCodexCursorStale,
  markCodexDayCovered,
  prepareCodexParserUpgrade,
  readCodexCursor,
  readCodexCursorMtime,
  readCodexRecognition,
  readCodexRolloutTally,
  replaceCodexRolloutTally,
  replaceRolloutUsage,
  setCollectorSetting,
  writeCodexCursor,
} from "@ccc/operational-store";
import type Database from "better-sqlite3";
import { addDays, localDayOf } from "../claude/usage-summary.js";
import {
  CodexHomeAccessError,
  type CodexHomePort,
  MAX_ROLLOUT_LIST,
  type RolloutRef,
} from "./codex-home.js";
import { tokensForRollout } from "./token-count.js";
import { buildCodexTokenSummary } from "./token-summary.js";

/**
 * The Codex token scanner (plan 05.1-23, D-17, D-24, CODEX-04, CODEX-07,
 * CODEX-10), redesigned so a rollout's stored usage is a pure function of its
 * content (see token-count.ts):
 *
 * - Gate: nothing is listed, statted, opened or parsed unless transcript
 *   analysis is on (the one shared toggle, D-17). The check runs before every
 *   file and every chunk, and again after a chunk's read, so switching
 *   analysis off stops a scan at the next chunk boundary and writes nothing.
 * - Access: every file operation goes through the allowlisted CODEX_HOME port
 *   with a reference the port itself listed; the scanner never opens a path it
 *   computed.
 * - What it decides: only WHICH rollouts changed. A rollout is unchanged when
 *   its cursor (keyed by the SHA-256 of its path, with a content fingerprint of
 *   the file's first bytes standing in for an inode) records the same size.
 * - What it does for a changed rollout: re-reads it FULLY through the port (in
 *   bounded chunks, bounded in total: a rollout above MAX_ROLLOUT_BYTES is
 *   skipped and reported not-scanned, never counted from a partial read), counts
 *   it with the pure function and REPLACES that rollout's rows, its recognition
 *   tally and its cursor in ONE transaction. A rollout that cannot be read again
 *   (deleted, outside the listing, refused, too large) keeps its rows untouched.
 * - Parser version: a version change drops cursors and derived state only; no
 *   counted row is deleted. Rows are replaced rollout by rollout when a rollout
 *   is read again, so usage that cannot be rebuilt survives the upgrade.
 * - Format: per-CLI-version recognition tallies persist per parser version; a
 *   read that would make the verdict unavailable records its tallies but no
 *   usage and no cursor, and from then on nothing is read (held).
 * - Coverage: a day is marked covered only by a complete, uncapped, uncancelled
 *   sweep in which every listed rollout was read; single-file scans count tokens
 *   but never coverage.
 * - Bounds: a sweep reads at most a fixed number of files and bytes and carries
 *   the rest to the next sweep; the timer reads only while the event stream has
 *   subscribers.
 * - Privacy: only the pure parser's token facts (six counters, ids, times) are
 *   used; the parsed lines are dropped. Logs carry reason codes and counts.
 */

/**
 * The parser version the cursors, coverage and tallies were built by. Bump it with ANY
 * change to what token-count.ts counts (see token-count-version.guard.test.ts): stores
 * written by an older version are rebuilt rollout by rollout on the next sweep.
 */
export const CODEX_TOKEN_PARSER_VERSION = 4;
export const CODEX_TOKEN_PARSER_VERSION_SETTING = "codex_token_parser_version";
export const CODEX_TOKEN_HORIZON_SETTING = "codex_token_horizon_day";
export const CODEX_TOKEN_FIRST_SCAN_SETTING = "codex_token_first_scan_done";
export const DEFAULT_CODEX_SWEEP_MS = 300_000;
export const CODEX_TOKEN_CHUNK_BYTES = 256 * 1024;
export const DEFAULT_MAX_FILES_PER_SWEEP = 200;
export const DEFAULT_MAX_BYTES_PER_SWEEP = 64 * 1024 * 1024;
/**
 * The largest rollout the scanner reads in full. A larger one is skipped and
 * reported not-scanned: its rows (if any) stay, and no partial read is ever
 * counted as complete.
 */
export const MAX_ROLLOUT_BYTES = 64 * 1024 * 1024;
/** How far back the sweep lists rollouts. */
export const CODEX_LISTING_DAYS = 31;

const DAY_MS = 86_400_000;
/** Bytes of a file's head that make up its identity. */
const IDENTITY_BYTES = 256;
/** The days one sweep may mark covered, whatever the listing says. */
const MAX_COVERED_DAYS = 400;

export interface TokenScannerTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface TokenScannerLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

/**
 * The store functions the rollout transaction calls. Injectable so a test can
 * make one of them fail between the rows, tally and cursor writes.
 */
export interface TokenStoreOps {
  readonly replaceRolloutUsage: typeof replaceRolloutUsage;
  readonly replaceCodexRolloutTally: typeof replaceCodexRolloutTally;
  readonly writeCodexCursor: typeof writeCodexCursor;
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
  /** Overrides the per-rollout size bound (tests use a small one). */
  readonly maxRolloutBytes?: number;
  readonly maxFilesPerSweep?: number;
  readonly maxBytesPerSweep?: number;
  readonly yieldNow?: () => Promise<void>;
  /** Overrides the parser version (tests simulate a parser upgrade). */
  readonly parserVersion?: number;
  /** Overrides store functions in the rollout transaction (tests inject a failure). */
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
  | { readonly kind: "capped" }
  /** The rollout exceeds the size bound: not read, rows and cursor untouched, never counted partially. */
  | { readonly kind: "not-scanned"; readonly reason: "too-large" | "source-truncated" };

export interface SweepOutcome {
  /** True only when every listed file was visited without cancellation, cap or failure. */
  readonly completed: boolean;
  readonly files: number;
  /** Files whose stat or read failed unexpectedly; logged by code and skipped. */
  readonly failedFiles: number;
  readonly held: boolean;
  readonly capped: boolean;
  /** Listed rollouts skipped without a read (too large): their days are not claimed covered. */
  readonly notScanned: number;
  /**
   * Thread ids whose usage was counted by the previous scanner and has not been
   * rebuilt: its rollout was deleted, aged out of the listing or not reached. The
   * rows are kept and still counted; only the rebuild is missing.
   */
  readonly notRescanned: number;
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
  const parserVersion = deps.parserVersion ?? CODEX_TOKEN_PARSER_VERSION;
  const ops: TokenStoreOps = {
    replaceRolloutUsage,
    replaceCodexRolloutTally,
    writeCodexCursor,
    ...deps.ops,
  };
  const maxRolloutBytes = deps.maxRolloutBytes ?? MAX_ROLLOUT_BYTES;
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
   * A parser-version change keeps every cursor (the stored read extent still guards
   * against a rollout truncated before the upgrade) and marks it stale so the rollout
   * is read again; it drops what the previous parser derived (the tallies of that version; its per-turn
   * precedence settings and cumulative marks) and NOTHING that was counted. The
   * counted rows, the coverage ledger and the horizon stay, and each rollout's
   * rows are replaced only when that rollout is successfully read again. Usage
   * whose rollout was deleted, aged out of the listing, is refused or is too large
   * is never lost to an upgrade. The marker itself is configuration and survives
   * "Delete cached usage analytics".
   */
  function ensureParserVersion(): void {
    const current = String(parserVersion);
    if (getCollectorSetting(db, CODEX_TOKEN_PARSER_VERSION_SETTING) === current) return;
    db.transaction(() => {
      prepareCodexParserUpgrade(db);
      setCollectorSetting(db, CODEX_TOKEN_PARSER_VERSION_SETTING, current, nowIso());
    })();
    logger.info({ parserVersion }, "codex token parser changed; rescanning");
  }

  /**
   * The stored tallies as the verdict would see them once one rollout's
   * contribution is replaced: its previous tally comes out, its new one goes in.
   */
  function withRollout(
    key: string,
    next: Readonly<Record<string, CodexRecognitionTally>>,
  ): Record<string, CodexRecognitionTally> {
    const merged: Record<string, CodexRecognitionTally> = {
      ...readCodexRecognition(db, parserVersion),
    };
    const previous = readCodexRolloutTally(db, key);
    for (const version of new Set([...Object.keys(previous), ...Object.keys(next)])) {
      const known = merged[version] ?? { sessions: 0, recognized: 0 };
      const before = previous[version] ?? { sessions: 0, recognized: 0 };
      const after = next[version] ?? { sessions: 0, recognized: 0 };
      merged[version] = {
        sessions: Math.max(0, known.sessions - before.sessions + after.sessions),
        recognized: Math.max(0, known.recognized - before.recognized + after.recognized),
      };
    }
    return merged;
  }

  /**
   * The recognition tally of a rollout's token lines. A per-turn record whose
   * counters cannot be read is an unrecognised token line. A cumulative event
   * with no counters is `info: null` (older Codex versions write it) and is
   * not evidence either way; the parser cannot tell it from a malformed one.
   */
  function tallyOf(facts: readonly RolloutFact[]): Record<string, CodexRecognitionTally> {
    let named: string | null = null;
    let sessions = 0;
    let recognized = 0;
    for (const fact of facts) {
      if (fact.kind === "meta" && fact.cliVersion !== null) named = fact.cliVersion;
      else if (fact.kind === "tokens-turn") {
        sessions += 1;
        if (fact.counters !== null) recognized += 1;
      } else if (fact.kind === "tokens-cumulative" && fact.counters !== null) {
        sessions += 1;
        recognized += 1;
      }
    }
    return sessions === 0 ? {} : { [named ?? UNVERSIONED]: { sessions, recognized } };
  }

  // --- Analysis-off periods ---------------------------------------------------

  /** The periods analysis was switched off (D-47), as instants the pure core compares record times to. */
  function offIntervals(): Array<{ startMs: number; endMs: number }> {
    return analysisOffIntervals(listToggleLog(db)).map((interval) => ({
      startMs: Date.parse(interval.start),
      endMs: interval.end === null ? Number.POSITIVE_INFINITY : Date.parse(interval.end),
    }));
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
    let mtimeMs: number;
    try {
      const stat = port.statRollout(ref);
      if (stat === null) return { kind: "missing" };
      size = stat.size;
      mtimeMs = stat.mtimeMs;
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
    // Same size AND same modification time as the last complete read, computed under
    // this parser: nothing to read. A same-size rewrite changes the mtime; a cursor
    // without a stored mtime (written before it existed) is recomputed once. A cursor
    // kept across a parser upgrade or a truncation is stale and is recomputed.
    if (
      cursor !== null &&
      cursor.size === size &&
      !isCodexCursorStale(db, key) &&
      readCodexCursorMtime(db, key) === mtimeMs
    )
      return { kind: "unchanged" };

    // The file is now smaller than the extent last read in full (truncated or
    // recreated with fewer bytes): replacing the rows from it would erase usage
    // that was already counted. The rows and the cursor (which holds that extent)
    // stay; the rollout is replaced again only once it reaches the extent again.
    if (cursor !== null && size < cursor.size) {
      // Stale: if it later regrows to exactly the saved size, the size alone must not
      // say unchanged. The saved size threshold is kept; a recompute clears the mark.
      markCodexCursorStale(db, key, nowIso());
      logger.warn({ reason: "rollout-source-truncated" }, "codex rollout shrank; rows kept");
      return { kind: "not-scanned", reason: "source-truncated" };
    }

    // Rows of a rollout that cannot be read in full stay as they are.
    if (size > maxRolloutBytes) {
      logger.warn({ reason: "rollout-too-large" }, "codex rollout too large; not scanned");
      return { kind: "not-scanned", reason: "too-large" };
    }
    if (budget !== undefined) {
      if (budget.filesLeft <= 0 || budget.bytesLeft <= 0) return { kind: "capped" };
      budget.filesLeft -= 1;
    }

    // Read the WHOLE rollout, in bounded chunks. Nothing is written until it is all read.
    const facts: RolloutFact[] = [];
    let carry: TranscriptCarry = EMPTY_CARRY;
    let position = 0;
    let consumed = 0;
    let oversized = 0;
    const head = Buffer.alloc(IDENTITY_BYTES);
    let headLength = 0;
    while (position < size) {
      if (!alive()) return { kind: "cancelled" };
      const length = Math.min(chunkBytes, size - position);
      const chunk = port.readRolloutRange(ref, position, length).bytes;
      // Re-checked after the read: a switch-off during it writes nothing.
      if (!alive()) return { kind: "cancelled" };
      // The file shrank under the read: nothing is counted from a partial read.
      if (chunk.length === 0) throw new Error("rollout-short-read");
      if (budget !== undefined) budget.bytesLeft -= chunk.length;
      if (headLength < IDENTITY_BYTES) {
        const take = Math.min(chunk.length, IDENTITY_BYTES - headLength);
        head.set(chunk.subarray(0, take), headLength);
        headLength += take;
      }
      const result = parseRolloutChunk(chunk, carry);
      for (const fact of result.facts) {
        if (
          fact.kind === "meta" ||
          fact.kind === "tokens-turn" ||
          fact.kind === "tokens-cumulative"
        ) {
          facts.push(fact);
        }
      }
      oversized += result.stats.oversized;
      consumed += result.bytesConsumed;
      carry = result.carry;
      position += chunk.length;
      await yieldNow();
    }

    const at = nowIso();
    const tally = tallyOf(facts);
    if (evaluateCliRecognition(withRollout(key, tally)).kind === "unavailable") {
      // This rollout changes the verdict: keep its tallies (so the verdict survives a
      // restart) but count nothing and leave the cursor, so it is read again once a
      // new parser recognises it.
      ops.replaceCodexRolloutTally(db, parserVersion, key, tally, at);
      logger.warn({ reason: "format-not-recognised" }, "codex token format not recognised; held");
      return { kind: "held" };
    }

    const fileThreadId = threadIdFromName(ref.path);
    const usage = tokensForRollout(facts, offIntervals(), fileThreadId);
    const threads = new Set(usage.threads);
    if (fileThreadId !== null) threads.add(fileThreadId);
    if (!alive()) return { kind: "cancelled" };
    db.transaction(() => {
      ops.replaceRolloutUsage(db, {
        rolloutKey: key,
        buckets: usage.buckets,
        supersededThreads: [...threads],
      });
      ops.replaceCodexRolloutTally(db, parserVersion, key, tally, at);
      ops.writeCodexCursor(
        db,
        key,
        { inode: identityOf(head.subarray(0, headLength)), size, offset: consumed, mtimeMs },
        at,
      );
    })();
    if (oversized > 0 || usage.skipped > 0) {
      logger.info({ oversized, skipped: usage.skipped }, "codex token lines skipped");
    }
    return { kind: "scanned", counted: usage.buckets.size, bytes: size };
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
      notScanned: 0,
      notRescanned: 0,
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
    let notScanned = 0;
    let truncatedSources = 0;
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
      if (outcome.kind === "not-scanned") {
        // Too large to read in full: never counted from a partial read, so the sweep
        // claims neither coverage nor first-scan completion.
        notScanned += 1;
        if (outcome.reason === "source-truncated") truncatedSources += 1;
        await yieldNow();
        continue;
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
    const complete =
      !stopped &&
      !held &&
      !capped &&
      !truncated &&
      failedFiles === 0 &&
      notScanned === 0 &&
      alive();
    // Coverage comes only from a full sweep that read every file: a capped, held,
    // cancelled or partly failed one leaves the days honestly not-scanned.
    if (complete) {
      markCoveredDays(oldest);
      lastScanAt = nowIso();
    }
    const notRescanned = countLegacyUsageThreads(db) + truncatedSources;
    if (notRescanned > 0 && !stopped) {
      logger.info({ notRescanned }, "codex usage kept from rollouts that could not be read again");
    }
    if (!stopped) publishIfChanged();
    return {
      completed: complete,
      files: scanned,
      failedFiles,
      held,
      capped,
      notScanned,
      notRescanned,
    };
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
