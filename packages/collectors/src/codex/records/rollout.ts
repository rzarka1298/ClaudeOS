import type { CodexTokenCounters } from "@ccc/domain";
import { EMPTY_CARRY, splitLines, type TranscriptCarry } from "../../transcripts/split-lines.js";

/**
 * The pure Codex rollout line walker (CODEX-05, CODEX-10, D-17, D-18).
 *
 * A rollout is Codex's private JSONL session log. It is third-party,
 * drifting and full of things the product must never keep: the prompt and
 * reply text, tool arguments, the creator's user and account ids and the
 * base instructions (RESEARCH Pitfall 10). So every fact below is built by
 * picking named keys from the parsed line and the parsed object is dropped
 * the moment the line is done: nothing here retains, spreads or copies a
 * line object.
 *
 * This module does no I/O and reads no clock; the service owns the file
 * cursor and passes the previous call's `carry`, exactly as the Claude
 * transcript parser does (it shares the same byte-exact splitter).
 */

/**
 * The default inactivity window of the lifecycle rule: a `task_started` with
 * no activity for this long is stale (unknown), never completed.
 *
 * Assumption A5 (RESEARCH): 30 minutes, the same default Phase 5 uses for
 * pid-less Runs (`CCC_PIDLESS_INACTIVITY_MS`); that it suits Codex is
 * assumed, not verified. The service allows an environment override.
 */
export const CODEX_INACTIVITY_MS = 30 * 60 * 1000;

/** The only rollout events that decide lifecycle. */
export const LIFECYCLE_EVENTS = ["task_started", "task_complete", "turn_aborted"] as const;
export type LifecycleEvent = (typeof LIFECYCLE_EVENTS)[number];

/** One rollout rate-limit window (snake-case keys renamed; values untouched). */
export interface RolloutLimitWindow {
  readonly usedPercent: number;
  readonly windowMinutes: number | null;
  readonly resetsAt: number | null;
}

/**
 * The allowlisted part of a rollout `rate_limits` object. The rollout also
 * carries `credits`, `individual_limit`, `spend_control_reached` and
 * `plan_type`; those are account facts (CODEX-09) and are dropped here.
 */
export interface RolloutRateLimits {
  readonly limitId: string | null;
  readonly limitName: string | null;
  readonly primary: RolloutLimitWindow | null;
  readonly secondary: RolloutLimitWindow | null;
  readonly reachedType: string | null;
}

/** Every fact a line can yield. All allowlisted; none carries content. */
export type RolloutFact =
  | {
      readonly kind: "meta";
      readonly id: string | null;
      readonly cwd: string | null;
      readonly cliVersion: string | null;
      readonly originator: string | null;
      readonly source: string | null;
      readonly time: string | null;
    }
  | {
      readonly kind: "lifecycle";
      readonly event: LifecycleEvent;
      readonly turnId: string | null;
      readonly time: string | null;
    }
  | {
      /** Cumulative-within-turn usage from the top-level `token_usage_record` (has a turn id). */
      readonly kind: "tokens-turn";
      readonly threadId: string | null;
      readonly turnId: string;
      readonly time: string | null;
      readonly counters: CodexTokenCounters | null;
    }
  | {
      /** Cumulative-within-thread usage from `token_count` (no turn id); null counters for `info: null`. */
      readonly kind: "tokens-cumulative";
      readonly time: string | null;
      readonly counters: CodexTokenCounters | null;
    }
  | {
      readonly kind: "rate-limits";
      readonly time: string | null;
      readonly limits: RolloutRateLimits;
    }
  | {
      /** A boolean fact: the message that said so is matched and then dropped. */
      readonly kind: "limit-hit";
      readonly time: string | null;
    };

export interface RolloutStats {
  /** Complete, non-empty lines examined (oversized lines are not counted here). */
  readonly lines: number;
  /** Lines that were a JSON object with a known `type`. */
  readonly recognized: number;
  /** Lines dropped for exceeding the per-line cap. */
  readonly oversized: number;
  /** Lines that were not JSON, not an object, or had an unknown `type`. */
  readonly unrecognized: number;
}

export interface RolloutParseResult {
  readonly facts: readonly RolloutFact[];
  /** The trailing partial line, to pass back with the next chunk. */
  readonly carry: TranscriptCarry;
  /** Bytes of `carry.bytes + chunk` consumed: every complete line plus any over-long line being skipped. */
  readonly bytesConsumed: number;
  readonly stats: RolloutStats;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when the text holds an ASCII control character (C0 or DEL). */
function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** A non-empty string within `max` characters with no control character, else null. */
function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > max) return null;
  return hasControl(value) ? null : value;
}

/** A parseable timestamp string, else null (so a caller's day function never sees garbage). */
function timeOf(value: unknown): string | null {
  const text = boundedString(value, 64);
  return text !== null && Number.isFinite(Date.parse(text)) ? text : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const MAX_ID = 128;
const MAX_CWD = 4096;
const MAX_VERSION = 64;
const MAX_ORIGINATOR = 64;
const MAX_SOURCE = 256;
const MAX_LIMIT_LABEL = 64;
const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,32}$/;
const VERSION_SHAPE = /^[0-9A-Za-z.+-]{1,64}$/;

/**
 * Reduces a `source` value to a canonical string built from an allowlist, so
 * the identifiers a spawned child carries (its parent thread) never reach a
 * fact. A string passes through bounded; an object keeps only the subagent
 * kind. Anything else is null.
 */
function canonicalSource(value: unknown): string | null {
  if (typeof value === "string") return boundedString(value, MAX_SOURCE);
  if (!isObject(value)) return null;
  const sub = value.subagent;
  if (typeof sub === "string") {
    return IDENTIFIER.test(sub) ? JSON.stringify({ subagent: sub }) : null;
  }
  if (isObject(sub)) {
    if ("thread_spawn" in sub) return JSON.stringify({ subagent: { thread_spawn: {} } });
    const other = sub.other;
    if (typeof other === "string" && IDENTIFIER.test(other)) {
      return JSON.stringify({ subagent: { other } });
    }
  }
  return null;
}

/** The snake-case member names of the six counters, in domain order. */
const COUNTER_KEYS = [
  ["input", "input_tokens"],
  ["cachedInput", "cached_input_tokens"],
  ["cacheWrite", "cache_write_input_tokens"],
  ["output", "output_tokens"],
  ["reasoningOutput", "reasoning_output_tokens"],
  ["total", "total_tokens"],
] as const;

/**
 * The six counters of a usage object. One missing member falls back to zero
 * for that member only (older Codex versions have no cache-write counter);
 * two or more missing, or any member that is not a non-negative integer,
 * makes the whole record unrecognisable (null). The total is the
 * Codex-reported one, never recomputed.
 */
function readCounters(raw: unknown): CodexTokenCounters | null {
  if (!isObject(raw)) return null;
  const out: Record<string, number> = {};
  let missing = 0;
  for (const [name, key] of COUNTER_KEYS) {
    const member = raw[key];
    if (member === undefined || member === null) {
      missing += 1;
      out[name] = 0;
      continue;
    }
    const value = count(member);
    if (value === null) return null;
    out[name] = value;
  }
  if (missing > 1) return null;
  return {
    input: out.input ?? 0,
    cachedInput: out.cachedInput ?? 0,
    cacheWrite: out.cacheWrite ?? 0,
    output: out.output ?? 0,
    reasoningOutput: out.reasoningOutput ?? 0,
    total: out.total ?? 0,
  };
}

function readWindow(raw: unknown): RolloutLimitWindow | null {
  if (!isObject(raw)) return null;
  const usedPercent = finiteNumber(raw.used_percent);
  if (usedPercent === null || usedPercent < 0) return null;
  const windowMinutes = finiteNumber(raw.window_minutes);
  const resetsAt = finiteNumber(raw.resets_at);
  return {
    usedPercent,
    windowMinutes: windowMinutes !== null && windowMinutes > 0 ? windowMinutes : null,
    resetsAt,
  };
}

const LABEL = /^[A-Za-z0-9_. -]{1,64}$/;

function readRateLimits(raw: unknown): RolloutRateLimits | null {
  if (!isObject(raw)) return null;
  const limitId = boundedString(raw.limit_id, MAX_LIMIT_LABEL);
  const limitName = boundedString(raw.limit_name, MAX_LIMIT_LABEL);
  const reached = boundedString(raw.rate_limit_reached_type, MAX_LIMIT_LABEL);
  const limits: RolloutRateLimits = {
    limitId: limitId !== null && LABEL.test(limitId) ? limitId : null,
    limitName: limitName !== null && LABEL.test(limitName) ? limitName : null,
    primary: readWindow(raw.primary),
    secondary: readWindow(raw.secondary),
    reachedType: reached !== null && LABEL.test(reached) ? reached : null,
  };
  return limits.primary === null && limits.secondary === null ? null : limits;
}

/** The wrapper's own limit expression (scripts/codex/codex.mjs `LIMIT_RE`). */
const LIMIT_RE = /usage[ _-]?limit/i;
const LIMIT_MARKER = /usage_limit_reached/i;

/** Only error-class events can be a limit hit. */
const ERROR_EVENTS = new Set(["error", "stream_error"]);

const KNOWN_LINE_TYPES = new Set([
  "session_meta",
  "turn_context",
  "event_msg",
  "response_item",
  "token_usage_record",
  "world_state",
  "compacted",
  "inter_agent_communication_metadata",
]);

function isLifecycleEvent(value: unknown): value is LifecycleEvent {
  return (LIFECYCLE_EVENTS as readonly unknown[]).includes(value);
}

/** The facts of one parsed line. The line object is not retained. */
function factsOf(line: Json): readonly RolloutFact[] {
  const time = timeOf(line.timestamp);
  const payload = isObject(line.payload) ? line.payload : null;

  if (line.type === "session_meta") {
    if (payload === null) return [];
    const version = boundedString(payload.cli_version, MAX_VERSION);
    return [
      {
        kind: "meta",
        id: boundedString(payload.id, MAX_ID),
        cwd: boundedString(payload.cwd, MAX_CWD),
        cliVersion: version !== null && VERSION_SHAPE.test(version) ? version : null,
        originator: boundedString(payload.originator, MAX_ORIGINATOR),
        source: canonicalSource(payload.source),
        time: timeOf(payload.timestamp) ?? time,
      },
    ];
  }

  if (line.type === "token_usage_record") {
    const body = payload !== null && "turn_id" in payload ? payload : line;
    const turnId = boundedString(body.turn_id, MAX_ID);
    if (turnId === null) return [];
    return [
      {
        kind: "tokens-turn",
        threadId: boundedString(body.thread_id, MAX_ID),
        turnId,
        time,
        counters: readCounters(body.turn_token_usage),
      },
    ];
  }

  if (line.type !== "event_msg" || payload === null) return [];
  const eventType = payload.type;

  if (isLifecycleEvent(eventType)) {
    return [
      { kind: "lifecycle", event: eventType, turnId: boundedString(payload.turn_id, MAX_ID), time },
    ];
  }

  if (eventType === "token_count") {
    const facts: RolloutFact[] = [];
    const info = isObject(payload.info) ? payload.info : null;
    facts.push({
      kind: "tokens-cumulative",
      time,
      counters: info === null ? null : readCounters(info.total_token_usage),
    });
    const limits = readRateLimits(payload.rate_limits);
    if (limits !== null) facts.push({ kind: "rate-limits", time, limits });
    return facts;
  }

  if (typeof eventType === "string" && ERROR_EVENTS.has(eventType)) {
    const message = typeof payload.message === "string" ? payload.message.slice(0, 4096) : "";
    if (LIMIT_RE.test(message) || LIMIT_MARKER.test(JSON.stringify(payload))) {
      return [{ kind: "limit-hit", time }];
    }
  }
  return [];
}

const encoder = new TextEncoder();

/**
 * Parses the complete lines of `carry + chunk` into allowlisted facts. The
 * trailing partial line is carried. `chunk` is the file's raw bytes; a string
 * is accepted for tests and encoded as UTF-8. Never throws.
 */
export function parseRolloutChunk(
  chunk: Uint8Array | string,
  carry: TranscriptCarry = EMPTY_CARRY,
): RolloutParseResult {
  const input = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
  const split = splitLines(input, carry);

  const facts: RolloutFact[] = [];
  let lines = 0;
  let recognized = 0;
  let unrecognized = 0;

  for (const raw of split.lines) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    lines += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      unrecognized += 1;
      continue;
    }
    if (
      !isObject(parsed) ||
      typeof parsed.type !== "string" ||
      !KNOWN_LINE_TYPES.has(parsed.type)
    ) {
      unrecognized += 1;
      continue;
    }
    recognized += 1;
    facts.push(...factsOf(parsed));
  }

  return {
    facts,
    carry: split.carry,
    bytesConsumed: carry.bytes.length + input.length - split.carry.bytes.length,
    stats: { lines, recognized, oversized: split.oversized, unrecognized },
  };
}

export type LifecycleState = "running" | "completed" | "cancelled" | "stale" | "none";

export interface LifecycleOptions {
  readonly nowMs: number;
  /** The inactivity window; see {@link CODEX_INACTIVITY_MS}. */
  readonly inactivityMs: number;
  /** The last activity time of the rollout (its file or thread update time), epoch milliseconds. */
  readonly lastActivityMs: number;
}

export interface LifecycleDerivation {
  readonly state: LifecycleState;
  /**
   * What the card shows. A rollout with no lifecycle event is `stale` when old
   * and null (not yet listed) when fresh; every other state shows as itself.
   */
  readonly display: "running" | "completed" | "cancelled" | "stale" | null;
  readonly lastEvent: LifecycleEvent | null;
  readonly lastEventAt: string | null;
  /** True when a limit-hit fact follows the last lifecycle event (or there is no lifecycle event). */
  readonly limitHitAfter: boolean;
}

/**
 * The lifecycle of a rollout: the LAST lifecycle event in file order among
 * `task_started`, `task_complete` and `turn_aborted`, never turn-id pairing
 * (a sub-agent rollout begins with the parent's `task_started`, so pairing
 * would report a false open turn; RESEARCH Pitfall 6). `running` needs the
 * last event to be `task_started` AND activity inside the window; an older
 * `task_started` is stale, never completed (D-18, T-05.1-27).
 */
export function deriveLifecycle(
  facts: readonly RolloutFact[],
  options: LifecycleOptions,
): LifecycleDerivation {
  let lastIndex = -1;
  for (let i = facts.length - 1; i >= 0; i -= 1) {
    if (facts[i]?.kind === "lifecycle") {
      lastIndex = i;
      break;
    }
  }
  const limitHitAfter = facts.slice(lastIndex + 1).some((fact) => fact.kind === "limit-hit");
  const last = lastIndex >= 0 ? facts[lastIndex] : undefined;
  const idleMs = options.nowMs - options.lastActivityMs;
  const outsideWindow = idleMs > options.inactivityMs;

  if (last === undefined || last.kind !== "lifecycle") {
    return {
      state: "none",
      display: outsideWindow ? "stale" : null,
      lastEvent: null,
      lastEventAt: null,
      limitHitAfter,
    };
  }
  const base = { lastEvent: last.event, lastEventAt: last.time, limitHitAfter };
  if (last.event === "task_complete") return { state: "completed", display: "completed", ...base };
  if (last.event === "turn_aborted") return { state: "cancelled", display: "cancelled", ...base };
  return outsideWindow
    ? { state: "stale", display: "stale", ...base }
    : { state: "running", display: "running", ...base };
}
