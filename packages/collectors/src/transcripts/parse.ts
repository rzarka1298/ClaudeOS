import { compareVersions } from "../sessions/capabilities.js";
import type { TokenCounters } from "../usage/pricing.js";

/**
 * The chunked transcript usage parser (USAGE-01, D-40, D-41, PR-11). Pure
 * and stateless: the service owns every file cursor (inode, size, offset),
 * reads a bounded chunk of RAW BYTES, passes the previous call's `carry`,
 * and advances its offset by exactly `bytesConsumed` — never past a partial
 * line (T-05-16). Lines are split on the `0x0A` byte and only complete lines
 * are decoded, so `bytesConsumed` is a byte count of the input itself and
 * never drifts on invalid UTF-8 (wave 2 review). A line longer than
 * {@link MAX_LINE_BYTES} is dropped and the parser skips to the next
 * newline, so the carry stays bounded; its bytes still count as consumed.
 * There is no logger here; skip counts come back in `stats` for the service
 * to log.
 *
 * It extracts counters, ids, model, version and timestamp only. Message
 * content, tool payloads, paths and branch names are never read into the
 * output (D-49, T-05-14).
 *
 * Skill or agent attribution is not extracted: no transcript version seen
 * (2.1.228-2.1.283, RESEARCH Q8) carries an explicit, documented skill or
 * agent-name field, and D-45 attributes "only where named". Subagent usage
 * is still counted; the service knows a subagent file by its path.
 */

/**
 * The parser's own version (wave 4): bump it whenever what this parser
 * recognizes changes. The service keys its persisted recognition tallies by
 * it, and a new value resets every transcript cursor and the coverage ledger
 * so the next sweep rereads everything with the new parser.
 */
export const TRANSCRIPT_PARSER_VERSION = 1;

/** PR-11: once a version has this many assistant records, its recognition ratio is judged. */
export const FORMAT_MIN_SAMPLE = 20;
/** PR-11: below this share of recognized assistant records, the format changed. */
export const FORMAT_MIN_RATIO = 0.9;
/** PR-11: this many assistant records with none recognized is a format change at once. */
export const FORMAT_ZERO_SAMPLE = 5;

/**
 * The longest line kept for parsing. A partial line past this is dropped and
 * the rest of it skipped up to its newline (wave 2 review), so a pathological
 * transcript cannot grow the carry without bound. Generous on purpose: a
 * real assistant record carrying a large tool input is well under it.
 */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

/** Assistant records with no `version` are counted under this key. */
export const UNVERSIONED = "(unversioned)";

/** One recognized assistant record. Dedup by `messageId` is the store's job (05-05). */
export interface RecognizedUsageRecord {
  readonly messageId: string;
  readonly sessionId: string | null;
  readonly timestamp: string | null;
  readonly version: string | null;
  readonly model: string | null;
  readonly counters: TokenCounters;
}

export interface VersionRecognition {
  readonly assistant: number;
  readonly recognized: number;
}

export interface ParseStats {
  /** Lines with `type === "assistant"`. */
  readonly assistant: number;
  readonly recognized: number;
  /** Complete lines that are not a JSON object. */
  readonly unparsable: number;
  /** Lines longer than {@link MAX_LINE_BYTES}, dropped unparsed. */
  readonly oversized: number;
  readonly byVersion: Readonly<Record<string, VersionRecognition>>;
}

/**
 * What one call hands the next: the trailing partial line's bytes, or, while
 * an over-long line is being skipped, no bytes and `skipping: true`.
 */
export interface TranscriptCarry {
  readonly bytes: Uint8Array;
  readonly skipping: boolean;
}

/** The carry of a fresh cursor (offset 0, or a restart at the stored offset). */
export const EMPTY_CARRY: TranscriptCarry = Object.freeze({
  bytes: new Uint8Array(0),
  skipping: false,
});

export interface ParseResult {
  readonly records: readonly RecognizedUsageRecord[];
  /** The trailing partial line (or skip state), to pass back with the next chunk. */
  readonly carry: TranscriptCarry;
  /**
   * Bytes of `carry.bytes + chunk` consumed: every complete line, plus any
   * over-long line being skipped. Always `carry.bytes.length + chunk.length
   * - result.carry.bytes.length`.
   */
  readonly bytesConsumed: number;
  readonly stats: ParseStats;
}

export type RecognitionVerdict =
  | { readonly kind: "ok" }
  /** Token activity reads "unavailable — transcript format changed in v<version>". */
  | { readonly kind: "unavailable"; readonly version: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");
const NEWLINE = 0x0a;

/** Caps on the strings copied out of an untrusted line. */
const MAX_MESSAGE_ID = 256;
const MAX_SESSION_ID = 128;
const MAX_TIMESTAMP = 64;
const MAX_VERSION = 64;
const MAX_MODEL = 128;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** The counters of a recognized record, or null when any of the four is missing or not a count. */
function countersOf(usage: unknown): TokenCounters | null {
  if (!isObject(usage)) return null;
  const input = count(usage.input_tokens);
  const output = count(usage.output_tokens);
  const cacheWrite = count(usage.cache_creation_input_tokens);
  const cacheRead = count(usage.cache_read_input_tokens);
  if (input === null || output === null || cacheWrite === null || cacheRead === null) return null;
  return { input, output, cacheWrite, cacheRead };
}

function concat(head: Uint8Array, tail: Uint8Array): Uint8Array {
  if (head.length === 0) return tail;
  const joined = new Uint8Array(head.length + tail.length);
  joined.set(head, 0);
  joined.set(tail, head.length);
  return joined;
}

interface SplitLines {
  readonly lines: readonly string[];
  readonly carry: TranscriptCarry;
  readonly oversized: number;
}

/** Splits `carry + chunk` on newline bytes, dropping over-long lines; decodes complete lines only. */
function splitLines(chunk: Uint8Array, carry: TranscriptCarry): SplitLines {
  const lines: string[] = [];
  let oversized = 0;
  let prefix = carry.bytes;
  let skipping = carry.skipping;
  let lineStart = 0;
  for (;;) {
    const newline = chunk.indexOf(NEWLINE, lineStart);
    if (newline === -1) break;
    if (skipping) {
      // The over-long line ends here; it was counted when the skip began.
      skipping = false;
    } else if (prefix.length + (newline - lineStart) > MAX_LINE_BYTES) {
      oversized += 1;
    } else {
      lines.push(decoder.decode(concat(prefix, chunk.subarray(lineStart, newline))));
    }
    prefix = EMPTY_CARRY.bytes;
    lineStart = newline + 1;
  }
  if (skipping) return { lines, carry: { bytes: EMPTY_CARRY.bytes, skipping: true }, oversized };
  const tailLength = prefix.length + (chunk.length - lineStart);
  if (tailLength > MAX_LINE_BYTES) {
    return { lines, carry: { bytes: EMPTY_CARRY.bytes, skipping: true }, oversized: oversized + 1 };
  }
  // Copied, so the carry never pins the caller's whole read buffer.
  const bytes = concat(prefix, chunk.slice(lineStart));
  return { lines, carry: { bytes, skipping: false }, oversized };
}

/**
 * Parses the complete lines of `carry + chunk`; the trailing partial line is
 * carried. `chunk` is the file's raw bytes; a string is accepted for tests
 * and encoded as UTF-8.
 */
export function parseTranscriptChunk(
  chunk: Uint8Array | string,
  carry: TranscriptCarry = EMPTY_CARRY,
): ParseResult {
  const input = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
  const split = splitLines(input, carry);

  const records: RecognizedUsageRecord[] = [];
  const byVersion: Record<string, { assistant: number; recognized: number }> = {};
  let assistant = 0;
  let recognized = 0;
  let unparsable = 0;

  for (const line of split.lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      unparsable += 1;
      continue;
    }
    if (!isObject(parsed)) {
      unparsable += 1;
      continue;
    }
    if (parsed.type !== "assistant") continue;

    assistant += 1;
    const version = boundedString(parsed.version, MAX_VERSION);
    const tally = byVersion[version ?? UNVERSIONED] ?? { assistant: 0, recognized: 0 };
    byVersion[version ?? UNVERSIONED] = tally;
    tally.assistant += 1;

    const message = isObject(parsed.message) ? parsed.message : null;
    const messageId = boundedString(message?.id, MAX_MESSAGE_ID);
    const counters = countersOf(message?.usage);
    if (messageId === null || counters === null) continue;

    recognized += 1;
    tally.recognized += 1;
    records.push({
      messageId,
      sessionId: boundedString(parsed.sessionId, MAX_SESSION_ID),
      timestamp: boundedString(parsed.timestamp, MAX_TIMESTAMP),
      version,
      model: boundedString(message?.model, MAX_MODEL),
      counters,
    });
  }

  return {
    records,
    carry: split.carry,
    bytesConsumed: carry.bytes.length + input.length - split.carry.bytes.length,
    stats: { assistant, recognized, unparsable, oversized: split.oversized, byVersion },
  };
}

/**
 * PR-11's per-version format-change rule: a version with at least
 * {@link FORMAT_MIN_SAMPLE} assistant records and a recognition ratio below
 * {@link FORMAT_MIN_RATIO}, or at least {@link FORMAT_ZERO_SAMPLE} with none
 * recognized, marks token activity unavailable. When several versions fail,
 * the newest is named.
 */
export function evaluateRecognition(
  byVersion: Readonly<Record<string, VersionRecognition>>,
): RecognitionVerdict {
  const failing = Object.entries(byVersion)
    .filter(([, { assistant, recognized }]) => {
      if (assistant >= FORMAT_ZERO_SAMPLE && recognized === 0) return true;
      return assistant >= FORMAT_MIN_SAMPLE && recognized / assistant < FORMAT_MIN_RATIO;
    })
    .map(([version]) => version)
    .sort(compareVersions);
  const newest = failing.at(-1);
  return newest === undefined ? { kind: "ok" } : { kind: "unavailable", version: newest };
}
