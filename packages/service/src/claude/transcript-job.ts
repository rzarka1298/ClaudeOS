import { constants } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  EMPTY_CARRY,
  evaluateRecognition,
  type parseTranscriptChunk,
  type RecognitionVerdict,
  type RecognizedUsageRecord,
  TRANSCRIPT_PARSER_VERSION,
  type TranscriptCarry,
  type VersionRecognition,
} from "@ccc/collectors";
import {
  addRecognitionStats,
  getCollectorSetting,
  getSessionOverride,
  latestRunBySession,
  markDayCovered,
  type RecognitionTally,
  readCursor,
  readRecognitionStats,
  recordUsage,
  resetTranscriptScanState,
  setCollectorSetting,
  type UsageRecordInput,
  writeCursor,
} from "@ccc/operational-store";
import type Database from "better-sqlite3";
import type { Logger } from "pino";
import { assertTranscriptPath, TranscriptPathRefusedError } from "./transcript-path.js";
import { addDays, type TranscriptFacts } from "./usage-summary.js";

/**
 * The opt-in transcript scanner (D-40, D-41, D-55, USAGE-01, USAGE-05).
 *
 * - Gate: nothing is listed, statted, opened or parsed unless `isEnabled()`
 *   says transcript analysis is on (D-03, USAGE-07). The check runs before
 *   every file and every chunk, so switching analysis off stops a scan at
 *   the next chunk boundary (D-47).
 * - Containment: only `.jsonl` files resolving (symlinks included) under
 *   `<claude-config>/projects` are ever opened (PR-28); the check runs
 *   before any stat or open.
 * - Cursors: each file has an (inode, size, offset) cursor. A scan reads
 *   from the offset in chunks of at most {@link TRANSCRIPT_CHUNK_BYTES},
 *   hands the parser raw bytes plus the previous carry, and advances the
 *   cursor only by `bytesConsumed`, so a partial last line is never
 *   consumed. A changed inode or a shrunk file restarts at 0; the store's
 *   message-id dedup keeps a rescan from counting anything twice.
 * - Coverage: a day is marked covered only by a full sweep that visited and
 *   read every listed file without cancellation (D-44, wave 4 review);
 *   single-file scans on Stop/SessionEnd count tokens but never coverage,
 *   and a reset or delete starts coverage over.
 * - Format recognition (D-41, PR-11, wave 4 review): per-Claude-version
 *   tallies are persisted per {@link TRANSCRIPT_PARSER_VERSION} in the same
 *   transaction that advances the cursor. The chunk that would make the
 *   verdict unavailable records its tallies but no usage and no cursor, and
 *   from then on nothing is read (outcome `held`): cursors and coverage stay
 *   put, so a format-changed period can never read as complete, across
 *   restarts too. A new parser version drops every cursor, the coverage
 *   ledger and the old tallies, and the next sweep rereads from zero.
 * - Privacy: only counters, ids, model, version and timestamps leave the
 *   parser (D-49); the path lives only in `transcript_cursors`.
 * - Scans are serialized on one promise chain and yield to the event loop
 *   between chunks and files; they never run on the ingest path (D-55).
 */

/** The largest chunk ever read at once (D-55); a larger `chunkBytes` is capped to this. */
export const TRANSCRIPT_CHUNK_BYTES = 256 * 1024;

/** The sweep never lists more files than this in one pass (T-05-52). */
const MAX_SWEEP_FILES = 20_000;

/** Records without a model id are counted under this key (unpriced, so the cost reads partial). */
export const UNKNOWN_MODEL = "(unknown)";
/** Records without a session id and no file-derived one are counted under this key. */
const UNKNOWN_SESSION = "(unknown)";

const DAY_MS = 86_400_000;
/** The covered-days span a sweep marks is bounded, whatever the retention setting says. */
const MAX_COVERED_DAYS = 3660;

export interface TranscriptFileStat {
  /** Text, so a 64-bit inode survives (the store keeps it as text). */
  readonly ino: string;
  readonly size: number;
  readonly birthtimeMs: number;
}

/** The file IO the job uses; tests wrap each in a spy. */
export interface TranscriptIo {
  readChunk(path: string, position: number, length: number): Promise<Uint8Array>;
  stat(path: string): Promise<TranscriptFileStat>;
  listFiles(root: string): Promise<string[]>;
  parse: typeof parseTranscriptChunk;
}

export interface TranscriptJobDeps extends TranscriptIo {
  readonly db: Database.Database;
  readonly logger: Logger;
  /** `<claude-config>/projects`: the only root a transcript may resolve under. */
  readonly claudeProjectsRoot: string;
  readonly now: () => Date;
  /** Whether transcript analysis is on right now (read before every file and chunk). */
  readonly isEnabled: () => boolean;
  /** The local calendar day of an ISO instant (D-45). */
  readonly dayOf: (iso: string) => string;
  /** Claude Code's transcript retention, for the sweep's covered-days span (D-44). */
  readonly cleanupPeriodDays: () => number;
  /** The chunk size; capped at {@link TRANSCRIPT_CHUNK_BYTES}. */
  readonly chunkBytes?: number;
  /** Yields between chunks and files; defaults to `setImmediate`. */
  readonly yieldNow?: () => Promise<void>;
}

export type ScanOutcome =
  | { readonly kind: "scanned"; readonly counted: number; readonly bytes: number }
  | { readonly kind: "unchanged" }
  /** Analysis is off: nothing was touched. */
  | { readonly kind: "skipped" }
  /** The path failed containment or is not a `.jsonl` file: nothing was opened. */
  | { readonly kind: "refused" }
  | { readonly kind: "missing" }
  /** Analysis was switched off (or the job cancelled) mid-scan. */
  | { readonly kind: "cancelled" }
  /** The recognition verdict is unavailable: nothing read, no cursor or coverage moved. */
  | { readonly kind: "held" };

export interface SweepOutcome {
  /** True only when every listed file was visited without cancellation. */
  readonly completed: boolean;
  readonly files: number;
  /** Files whose stat or read failed with anything but ENOENT; logged and skipped. */
  readonly failedFiles: number;
  /** The sweep stopped because the format-recognition verdict is unavailable. */
  readonly held: boolean;
}

/** The collector setting recording which parser version the cursors were built by. */
export const TRANSCRIPT_PARSER_VERSION_SETTING = "transcript_parser_version";

export interface TranscriptJob {
  /** Scans one transcript from its cursor. Queued behind any scan in flight. */
  scanFile(path: string): Promise<ScanOutcome>;
  /** Scans every transcript under the root, then marks the retained days covered. */
  sweep(): Promise<SweepOutcome>;
  /** Stops in-flight work at its next chunk boundary. */
  cancel(): void;
  /** Forgets first timestamps and the last scan (after usage analytics are deleted). */
  reset(): void;
  /** Resolves once no scan is queued or running. */
  idle(): Promise<void>;
  recognition(): RecognitionVerdict;
  facts(): TranscriptFacts;
}

function errorCode(err: unknown): unknown {
  return (err as { code?: unknown }).code;
}

function defaultYield(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * The real file IO. `readChunk` opens with `O_NOFOLLOW` (the path it gets
 * is already resolved and contained) and closes after each chunk, so no
 * descriptor outlives a chunk. `listFiles` walks only
 * `<root>/<project>/*.jsonl` and `<root>/<project>/<session>/subagents/*.jsonl`,
 * never following a symlinked entry.
 */
export function nodeTranscriptIo(): Omit<TranscriptIo, "parse"> {
  return {
    async readChunk(path, position, length) {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        return buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    },
    async stat(path) {
      const info = await stat(path, { bigint: true });
      return {
        ino: info.ino.toString(),
        size: Number(info.size),
        birthtimeMs: Number(info.birthtimeMs),
      };
    },
    async listFiles(root) {
      const files: string[] = [];
      const entries = async (dir: string) => {
        try {
          return await readdir(dir, { withFileTypes: true });
        } catch {
          return [];
        }
      };
      for (const project of await entries(root)) {
        if (!project.isDirectory()) continue;
        const projectDir = join(root, project.name);
        for (const entry of await entries(projectDir)) {
          if (files.length >= MAX_SWEEP_FILES) return files;
          if (entry.isFile() && entry.name.endsWith(".jsonl")) {
            files.push(join(projectDir, entry.name));
          } else if (entry.isDirectory()) {
            const subagents = join(projectDir, entry.name, "subagents");
            for (const sub of await entries(subagents)) {
              if (sub.isFile() && sub.name.endsWith(".jsonl"))
                files.push(join(subagents, sub.name));
            }
          }
        }
      }
      return files;
    },
  };
}

function isCountable(record: RecognizedUsageRecord): boolean {
  const { input, output, cacheWrite, cacheRead } = record.counters;
  return (
    record.timestamp !== null &&
    !Number.isNaN(Date.parse(record.timestamp)) &&
    [input, output, cacheWrite, cacheRead].every((n) => Number.isSafeInteger(n) && n >= 0)
  );
}

/** A main transcript is `<session-id>.jsonl`; a subagent file names its agent, not the session. */
function sessionIdFromPath(path: string): string | null {
  if (path.includes("/subagents/")) return null;
  const name = basename(path, ".jsonl");
  return /^[A-Za-z0-9_-]{1,128}$/.test(name) ? name : null;
}

export function createTranscriptJob(deps: TranscriptJobDeps): TranscriptJob {
  const { db, logger, now } = deps;
  const chunkBytes = Math.max(
    1,
    Math.min(deps.chunkBytes ?? TRANSCRIPT_CHUNK_BYTES, TRANSCRIPT_CHUNK_BYTES),
  );
  const yieldNow = deps.yieldNow ?? defaultYield;
  let generation = 0;
  let chain: Promise<unknown> = Promise.resolve();
  let lastScanAt: string | null = null;
  /** The earliest record timestamp (or creation time) per resolved transcript path. */
  const firstSeen = new Map<string, number>();

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = chain.then(work, work);
    chain = next.catch(() => undefined);
    return next;
  }

  function storedStats(): Record<string, RecognitionTally> {
    return readRecognitionStats(db, TRANSCRIPT_PARSER_VERSION);
  }

  function verdict(): RecognitionVerdict {
    return evaluateRecognition(storedStats());
  }

  /** The stored tallies plus one chunk's, as the verdict would see them once committed. */
  function withChunk(
    stats: Readonly<Record<string, VersionRecognition>>,
  ): Record<string, RecognitionTally> {
    const merged: Record<string, RecognitionTally> = { ...storedStats() };
    for (const [version, tally] of Object.entries(stats)) {
      const total = merged[version] ?? { assistant: 0, recognized: 0 };
      merged[version] = {
        assistant: total.assistant + tally.assistant,
        recognized: total.recognized + tally.recognized,
      };
    }
    return merged;
  }

  /**
   * Cursors built by another parser version are thrown away with the
   * coverage ledger and every tally, so the next sweep rereads from zero
   * (message-id dedup keeps that from counting twice).
   */
  function ensureParserVersion(): void {
    const current = String(TRANSCRIPT_PARSER_VERSION);
    if (getCollectorSetting(db, TRANSCRIPT_PARSER_VERSION_SETTING) === current) return;
    db.transaction(() => {
      resetTranscriptScanState(db);
      setCollectorSetting(db, TRANSCRIPT_PARSER_VERSION_SETTING, current, now().toISOString());
    })();
    firstSeen.clear();
    logger.info(
      { parserVersion: TRANSCRIPT_PARSER_VERSION },
      "transcript parser changed; rescanning",
    );
  }

  function noteFirstSeen(path: string, ms: number): void {
    const known = firstSeen.get(path);
    if (known === undefined || ms < known) firstSeen.set(path, ms);
  }

  /** The Run's project for a Claude session: the owner's override, else the attributed one. */
  function projectKeyResolver(): (claudeSessionId: string) => string | null {
    const cache = new Map<string, string | null>();
    return (claudeSessionId) => {
      if (!cache.has(claudeSessionId)) {
        const key =
          getSessionOverride(db, claudeSessionId) ??
          latestRunBySession(db, claudeSessionId)?.projectId ??
          null;
        cache.set(claudeSessionId, key);
      }
      return cache.get(claudeSessionId) ?? null;
    };
  }

  async function scanOne(path: string, gen: number, seen?: Set<string>): Promise<ScanOutcome> {
    const alive = () => gen === generation && deps.isEnabled();
    if (!alive()) return { kind: "skipped" };
    ensureParserVersion();
    if (verdict().kind === "unavailable") return { kind: "held" };
    let resolved: string;
    try {
      resolved = assertTranscriptPath(path, deps.claudeProjectsRoot);
    } catch (err: unknown) {
      if (err instanceof TranscriptPathRefusedError) {
        logger.warn({ reason: err.reason }, "transcript path refused");
        return { kind: "refused" };
      }
      if (errorCode(err) === "ENOENT") return { kind: "missing" };
      throw err;
    }
    if (!resolved.endsWith(".jsonl")) {
      logger.warn({ reason: "not-jsonl" }, "transcript path refused");
      return { kind: "refused" };
    }
    seen?.add(resolved);

    let info: TranscriptFileStat;
    try {
      info = await deps.stat(resolved);
    } catch (err: unknown) {
      if (errorCode(err) === "ENOENT") return { kind: "missing" };
      throw err;
    }
    const cursor = readCursor(db, resolved);
    const resume = cursor !== null && cursor.inode === info.ino && cursor.offset <= info.size;
    let position = resume ? cursor.offset : 0;
    if (position > 0 && !firstSeen.has(resolved) && info.birthtimeMs > 0) {
      noteFirstSeen(resolved, info.birthtimeMs);
    }
    if (resume && position === info.size) return { kind: "unchanged" };

    const fileSessionId = sessionIdFromPath(resolved);
    const projectKeyOf = projectKeyResolver();
    let carry: TranscriptCarry = EMPTY_CARRY;
    let counted = 0;
    let bytes = 0;
    while (position + carry.bytes.length < info.size) {
      if (!alive()) return { kind: "cancelled" };
      const readAt = position + carry.bytes.length;
      const length = Math.min(chunkBytes, info.size - readAt);
      let chunk: Uint8Array;
      try {
        chunk = await deps.readChunk(resolved, readAt, length);
      } catch (err: unknown) {
        // Deleted between stat and read: Claude Code's own cleanup, not a failure.
        if (errorCode(err) === "ENOENT") return { kind: "missing" };
        throw err;
      }
      // Re-checked after the await: a switch-off during the read writes nothing.
      if (!alive()) return { kind: "cancelled" };
      if (chunk.length === 0) break;
      const result = deps.parse(chunk, carry);
      const records: UsageRecordInput[] = [];
      for (const record of result.records) {
        if (!isCountable(record) || record.timestamp === null) continue;
        const timestamp = new Date(record.timestamp).toISOString();
        const claudeSessionId = record.sessionId ?? fileSessionId ?? UNKNOWN_SESSION;
        records.push({
          messageId: record.messageId,
          claudeSessionId,
          timestamp,
          model: record.model ?? UNKNOWN_MODEL,
          skillKey: null,
          projectKey: projectKeyOf(claudeSessionId),
          counters: record.counters,
        });
        noteFirstSeen(resolved, Date.parse(timestamp));
      }
      const nextPosition = position + result.bytesConsumed;
      const at = now().toISOString();
      if (evaluateRecognition(withChunk(result.stats.byVersion)).kind === "unavailable") {
        // This chunk changes the verdict: keep its tallies (so the verdict
        // survives a restart) but count nothing and leave the cursor, so the
        // period is reread once a new parser recognizes it.
        addRecognitionStats(db, TRANSCRIPT_PARSER_VERSION, result.stats.byVersion, at);
        logger.warn({}, "transcript format not recognized; scanning held");
        return { kind: "held" };
      }
      db.transaction(() => {
        counted += recordUsage(db, records, at);
        writeCursor(db, resolved, { inode: info.ino, size: info.size, offset: nextPosition }, at);
        addRecognitionStats(db, TRANSCRIPT_PARSER_VERSION, result.stats.byVersion, at);
      })();
      if (result.stats.oversized > 0 || result.stats.unparsable > 0) {
        logger.info(
          { oversized: result.stats.oversized, unparsable: result.stats.unparsable },
          "transcript lines skipped",
        );
      }
      bytes += chunk.length;
      position = nextPosition;
      carry = result.carry;
      await yieldNow();
    }
    lastScanAt = now().toISOString();
    return { kind: "scanned", counted, bytes };
  }

  /** Every retained day up to today is covered once a full sweep completes (D-44). */
  function markRetainedDaysCovered(): void {
    const nowMs = now().getTime();
    const retention = Math.max(1, Math.floor(deps.cleanupPeriodDays()));
    const oldest = Math.min(...firstSeen.values());
    const fromMs = Number.isFinite(oldest) ? Math.max(oldest, nowMs - retention * DAY_MS) : nowMs;
    const at = new Date(nowMs).toISOString();
    const today = deps.dayOf(at);
    db.transaction(() => {
      let day = deps.dayOf(new Date(fromMs).toISOString());
      for (let i = 0; day <= today && i < MAX_COVERED_DAYS; i += 1) {
        markDayCovered(db, day, at);
        day = addDays(day, 1);
      }
    })();
  }

  async function sweepAll(gen: number): Promise<SweepOutcome> {
    const alive = () => gen === generation && deps.isEnabled();
    if (!alive()) return { completed: false, files: 0, failedFiles: 0, held: false };
    ensureParserVersion();
    if (verdict().kind === "unavailable") {
      return { completed: false, files: 0, failedFiles: 0, held: true };
    }
    const files = await deps.listFiles(deps.claudeProjectsRoot);
    const present = new Set<string>();
    let scanned = 0;
    let failedFiles = 0;
    for (const file of files) {
      if (!alive()) return { completed: false, files: scanned, failedFiles, held: false };
      let outcome: ScanOutcome;
      try {
        outcome = await scanOne(file, gen, present);
      } catch (err: unknown) {
        // One unreadable file (EACCES, EIO…) never aborts the sweep (wave 4
        // review). The errno code only: the path never reaches a log (D-49).
        logger.warn({ code: errorCode(err) }, "transcript scan failed; skipped");
        failedFiles += 1;
        await yieldNow();
        continue;
      }
      if (outcome.kind === "cancelled" || outcome.kind === "skipped") {
        return { completed: false, files: scanned, failedFiles, held: false };
      }
      if (outcome.kind === "held") {
        return { completed: false, files: scanned, failedFiles, held: true };
      }
      scanned += 1;
      await yieldNow();
    }
    if (!alive()) return { completed: false, files: scanned, failedFiles, held: false };
    // Files Claude Code deleted no longer hold back the retention horizon.
    for (const path of firstSeen.keys()) {
      if (!present.has(path)) firstSeen.delete(path);
    }
    // Coverage comes only from a full sweep that read every file (wave 4
    // review): a single-file scan (a Stop or SessionEnd) must never make one
    // session's tokens read as a complete day, and an unreadable file leaves
    // the days honestly not-scanned.
    if (failedFiles === 0) markRetainedDaysCovered();
    lastScanAt = now().toISOString();
    return { completed: true, files: scanned, failedFiles, held: false };
  }

  return {
    // The generation is captured at call time, so work queued before a
    // cancel never runs after it.
    scanFile(path) {
      const gen = generation;
      return enqueue(() => scanOne(path, gen));
    },
    sweep() {
      const gen = generation;
      return enqueue(() => sweepAll(gen));
    },
    cancel() {
      generation += 1;
    },
    reset() {
      generation += 1;
      firstSeen.clear();
      lastScanAt = null;
    },
    async idle() {
      await chain;
    },
    recognition() {
      return verdict();
    },
    facts() {
      const oldest = Math.min(...firstSeen.values());
      return {
        verdict: verdict(),
        oldestTranscriptAt: Number.isFinite(oldest) ? new Date(oldest).toISOString() : null,
        lastScanAt,
      };
    },
  };
}
