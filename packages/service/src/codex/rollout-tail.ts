import {
  EMPTY_CARRY,
  parseRolloutChunk,
  type RolloutFact,
  type TranscriptCarry,
} from "@ccc/collectors";
import type { CodexHomePort, RolloutRef } from "./codex-home.js";

/**
 * The bounded, incremental rollout tail reader (CODEX-04, CODEX-05, D-15,
 * D-18, T-05.1-12).
 *
 * A Codex rollout can be many megabytes and grows while a session runs. The
 * session mirror only needs its lifecycle, so the reader:
 *
 *   - reads the LAST 256 KiB on first sight (dropping the partial first
 *     line), never the whole file,
 *   - afterwards reads only the bytes past an in-memory cursor, carrying a
 *     partial trailing line to the next call,
 *   - caps the bytes of every call so a large backlog is worked off over
 *     several polls,
 *   - keeps only the LAST lifecycle fact (and one limit-hit that follows it)
 *     rather than every fact, so the per-thread cache stays tiny, and
 *   - goes through the allowlisted port (`statRollout`, `readRolloutRange`)
 *     and nothing else: no direct file-system call on the Codex home.
 *
 * Identity: the port reports size and modification time but no inode, so a
 * file that SHRANK or whose modification time went BACKWARDS is treated as a
 * different file and read as a first sight. (A same-size in-place rewrite
 * with a newer mtime is indistinguishable from growth; Codex only appends.)
 *
 * Nothing here logs and no error text is kept: the port's refusals carry a
 * fixed code, but a read error can name a path, so every failure collapses to
 * `{ kind: "failed" }`.
 */

/** The window read on first sight of a rollout (R3). */
export const FIRST_SIGHT_BYTES = 256 * 1024;
/** The default per-call cap; the port caps a single range read at 1 MiB anyway. */
export const DEFAULT_TAIL_READ_BYTES = 1024 * 1024;

const NEWLINE = 0x0a;

export type RolloutTailPort = Pick<CodexHomePort, "statRollout" | "readRolloutRange">;

/** Service-private per-rollout cursor; never leaves the mirror. */
export interface RolloutTailEntry {
  /** The file size at the last stat. */
  readonly size: number;
  /** The file modification time at the last stat. */
  readonly mtimeMs: number;
  /** The file offset up to which bytes have been read (the carry is the tail of those). */
  readonly readTo: number;
  readonly carry: TranscriptCarry;
  /**
   * At most the last lifecycle fact followed by at most one limit-hit that
   * came after it (or a lone limit-hit when no lifecycle event was seen).
   */
  readonly retained: readonly RolloutFact[];
  /** Complete lines examined since the entry began (cumulative). */
  readonly lines: number;
  /** Lines that were a JSON object with a known `type` (cumulative). */
  readonly recognized: number;
}

export interface RolloutTailOptions {
  /** The window read on first sight; default {@link FIRST_SIGHT_BYTES}. */
  readonly firstSightBytes?: number;
  /** The byte budget of this call; 0 or less defers any read. Default {@link DEFAULT_TAIL_READ_BYTES}. */
  readonly maxBytes?: number;
}

export type RolloutTailResult =
  /** The rollout does not exist (or is not openable through the port). */
  | { readonly kind: "missing" }
  /** The port refused or the read failed; nothing about the cause is kept. */
  | { readonly kind: "failed" }
  /** A read was needed but the call had no byte budget; the previous entry stands. */
  | { readonly kind: "deferred" }
  | {
      readonly kind: "ok";
      readonly entry: RolloutTailEntry;
      readonly bytesRead: number;
      /** True when the read began a new cursor (first sight, shrink or identity change). */
      readonly fresh: boolean;
      /** True when the cursor reached the end of the file as of the read. */
      readonly caughtUp: boolean;
    };

/** Keeps the last lifecycle fact and at most one limit-hit after it. */
function compact(facts: readonly RolloutFact[]): readonly RolloutFact[] {
  let lastLifecycle = -1;
  for (let i = facts.length - 1; i >= 0; i -= 1) {
    if (facts[i]?.kind === "lifecycle") {
      lastLifecycle = i;
      break;
    }
  }
  const after = facts.slice(lastLifecycle + 1).find((fact) => fact.kind === "limit-hit");
  const kept: RolloutFact[] = [];
  const lifecycle = lastLifecycle >= 0 ? facts[lastLifecycle] : undefined;
  if (lifecycle !== undefined) kept.push(lifecycle);
  if (after !== undefined) kept.push(after);
  return kept;
}

function startingPoint(size: number, firstSightBytes: number): number {
  return size > firstSightBytes ? size - firstSightBytes : 0;
}

/**
 * Reads what is new in one rollout. `previous` is the entry returned by the
 * last call for the same thread (or undefined on first sight).
 */
export function readRolloutTail(
  port: RolloutTailPort,
  ref: RolloutRef,
  previous: RolloutTailEntry | undefined,
  options: RolloutTailOptions = {},
): RolloutTailResult {
  const firstSightBytes = options.firstSightBytes ?? FIRST_SIGHT_BYTES;
  const budget = options.maxBytes ?? DEFAULT_TAIL_READ_BYTES;

  let stat: { readonly size: number; readonly mtimeMs: number } | null;
  try {
    stat = port.statRollout(ref);
  } catch {
    return { kind: "failed" };
  }
  if (stat === null) return { kind: "missing" };

  const fresh =
    previous === undefined || stat.size < previous.readTo || stat.mtimeMs < previous.mtimeMs;
  const base = fresh ? undefined : previous;

  if (base !== undefined && stat.size === base.readTo) {
    // Nothing new. Refresh only the stat so the identity check keeps working.
    if (stat.size === base.size && stat.mtimeMs === base.mtimeMs) {
      return { kind: "ok", entry: base, bytesRead: 0, fresh: false, caughtUp: true };
    }
    const entry: RolloutTailEntry = { ...base, size: stat.size, mtimeMs: stat.mtimeMs };
    return { kind: "ok", entry, bytesRead: 0, fresh: false, caughtUp: true };
  }

  if (budget <= 0) return { kind: "deferred" };

  const offset = base === undefined ? startingPoint(stat.size, firstSightBytes) : base.readTo;
  const want = base === undefined ? Math.min(budget, firstSightBytes) : budget;

  let read: { readonly bytes: Buffer; readonly size: number };
  try {
    read = port.readRolloutRange(ref, offset, want);
  } catch {
    return { kind: "failed" };
  }

  let bytes: Uint8Array = read.bytes;
  let carry: TranscriptCarry = base?.carry ?? EMPTY_CARRY;
  if (base === undefined && offset > 0) {
    // The window began mid-file: drop everything up to the first line break.
    const newline = bytes.indexOf(NEWLINE);
    bytes = newline < 0 ? new Uint8Array(0) : bytes.subarray(newline + 1);
    carry = EMPTY_CARRY;
  }

  const parsed = parseRolloutChunk(bytes, carry);
  const readTo = offset + read.bytes.length;
  const entry: RolloutTailEntry = {
    size: read.size,
    mtimeMs: stat.mtimeMs,
    readTo,
    carry: parsed.carry,
    retained: compact([...(base?.retained ?? []), ...parsed.facts]),
    lines: (base?.lines ?? 0) + parsed.stats.lines,
    recognized: (base?.recognized ?? 0) + parsed.stats.recognized,
  };
  return {
    kind: "ok",
    entry,
    bytesRead: read.bytes.length,
    fresh,
    // An empty read below the reported size cannot make progress; treat it as the end.
    caughtUp: readTo >= read.size || read.bytes.length === 0,
  };
}
