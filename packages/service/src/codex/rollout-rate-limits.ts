import {
  type NewestRolloutRateLimits,
  newestRolloutRateLimits,
  parseRolloutChunk,
  ROLLOUT_FALLBACK_WINDOW_MS,
  rolloutFallbackSnapshot,
} from "@ccc/collectors";
import type { CodexUsageSnapshot } from "@ccc/domain";
import type { CodexHomePort, RolloutRef } from "./codex-home.js";

/**
 * The rollout rate-limit fallback reader (plan 05.1-33, OQ-3, owner decision
 * 2026-10-10, CODEX-08, CODEX-09).
 *
 * When the live `account/rateLimits/read` is unavailable, the plan-usage bar
 * may show the newest `rate_limits` figure Codex wrote into a rollout. This
 * reader finds that figure and nothing else: DISPLAY ONLY. It yields a
 * snapshot whose source is `rollout-fallback`, which the guard never allows
 * from, so the headroom gate and the 80 percent reserve keep requiring a live
 * read.
 *
 * Reads go through the allowlisted CODEX_HOME port only (rollout files under
 * the dated sessions folders), bounded three ways: the newest
 * {@link MAX_STAT_CANDIDATES} files of the 31-day window are statted, at most
 * {@link MAX_FILES_READ} are read, and each read is the last
 * {@link TAIL_READ_BYTES} bytes. Selection and normalisation are the pure
 * collectors functions; this module owns the file access and the clock.
 *
 * Failure posture: this never throws. A listing failure is `null`; an
 * unreadable file is skipped; each failure logs a fixed reason code and never
 * a path or an error message. The answer (including `null`) is cached for a
 * few seconds, because the headroom service asks for it on every display.
 */

/** How long one answer is reused. */
export const ROLLOUT_RATE_LIMITS_CACHE_MS = 10_000;
/** Newest-by-name rollouts of the window that are statted. */
export const MAX_STAT_CANDIDATES = 120;
/** Rollouts actually read, newest modification first. */
export const MAX_FILES_READ = 8;
/** Bytes read from the end of each rollout. */
export const TAIL_READ_BYTES = 256 * 1024;

const NEWLINE = 0x0a;

export interface RolloutRateLimitsReader {
  /** The newest rollout figure as a display-only snapshot, or null. Never throws. */
  read(): CodexUsageSnapshot | null;
}

export interface RolloutRateLimitsDeps {
  readonly port: Pick<CodexHomePort, "listRolloutFiles" | "statRollout" | "readRolloutRange">;
  readonly now: () => number;
  /** Reason codes only. */
  readonly logger?: { warn(fields: { readonly reason: string }, message: string): void };
  /** Test seam; default {@link ROLLOUT_RATE_LIMITS_CACHE_MS}. */
  readonly cacheMs?: number;
}

interface Candidate {
  readonly ref: RolloutRef;
  readonly size: number;
  readonly mtimeMs: number;
}

export function createRolloutRateLimitsReader(
  deps: RolloutRateLimitsDeps,
): RolloutRateLimitsReader {
  const cacheMs = deps.cacheMs ?? ROLLOUT_RATE_LIMITS_CACHE_MS;
  let cached: { readonly atMs: number; readonly value: CodexUsageSnapshot | null } | null = null;

  function warn(reason: string): void {
    try {
      deps.logger?.warn({ reason }, "codex rollout rate limits");
    } catch {
      // A logger must never turn a display read into a failure.
    }
  }

  function candidates(nowMs: number): readonly Candidate[] | null {
    let refs: readonly RolloutRef[];
    try {
      refs = deps.port.listRolloutFiles({ from: nowMs - ROLLOUT_FALLBACK_WINDOW_MS, to: nowMs });
    } catch {
      warn("rollout-list-failed");
      return null;
    }
    const found: Candidate[] = [];
    // The listing is oldest day first, names sorted: the tail is the newest.
    for (const ref of refs.slice(-MAX_STAT_CANDIDATES)) {
      try {
        const stat = deps.port.statRollout(ref);
        if (stat !== null && stat.mtimeMs >= nowMs - ROLLOUT_FALLBACK_WINDOW_MS) {
          found.push({ ref, size: stat.size, mtimeMs: stat.mtimeMs });
        }
      } catch {
        warn("rollout-stat-failed");
      }
    }
    return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  function tailOf(candidate: Candidate, nowMs: number): NewestRolloutRateLimits | null {
    const offset = Math.max(0, candidate.size - TAIL_READ_BYTES);
    let bytes: Uint8Array;
    try {
      bytes = deps.port.readRolloutRange(candidate.ref, offset, TAIL_READ_BYTES).bytes;
    } catch {
      warn("rollout-read-failed");
      return null;
    }
    if (offset > 0) {
      // The window began mid-file: drop everything up to the first line break.
      const newline = bytes.indexOf(NEWLINE);
      bytes = newline < 0 ? new Uint8Array(0) : bytes.subarray(newline + 1);
    }
    return newestRolloutRateLimits(parseRolloutChunk(bytes).facts, { nowMs });
  }

  function compute(nowMs: number): CodexUsageSnapshot | null {
    const list = candidates(nowMs);
    if (list === null) return null;
    let best: NewestRolloutRateLimits | null = null;
    let read = 0;
    for (const candidate of list) {
      // A record is never newer than its file's last write: nothing further down can win.
      if (best !== null && candidate.mtimeMs < best.observedAtMs) break;
      if (read >= MAX_FILES_READ) break;
      read += 1;
      const found = tailOf(candidate, nowMs);
      if (found !== null && (best === null || found.observedAtMs > best.observedAtMs)) {
        best = found;
      }
    }
    return rolloutFallbackSnapshot(best, nowMs);
  }

  return {
    read() {
      const nowMs = deps.now();
      if (cached !== null && nowMs >= cached.atMs && nowMs - cached.atMs < cacheMs) {
        return cached.value;
      }
      let value: CodexUsageSnapshot | null;
      try {
        value = compute(nowMs);
      } catch {
        warn("rollout-fallback-failed");
        value = null;
      }
      cached = { atMs: nowMs, value };
      return value;
    },
  };
}
