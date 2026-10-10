/**
 * Synthetic Codex rollout line builders, shaped like the line types recorded
 * in RESEARCH R3 (`session_meta`, `turn_context`, `event_msg` with
 * `task_started`, `task_complete`, `turn_aborted`, `token_count` and `error`,
 * the top-level `token_usage_record`, and `response_item`). Every value is
 * synthetic: thread and turn ids like `thread-aaaa1111`, cwd values under
 * `/Users/USERNAME/...`, and decoy sentinels where a parser must NOT copy
 * something out (PRIV-04). No real rollout is ever read or copied.
 */

/** Planted as the creator user id in session meta; no parser output may contain it. */
export const DECOY_CREATOR_USER = "creator-user-DECOY0001";
/** Planted as the creator account id in session meta; no parser output may contain it. */
export const DECOY_CREATOR_ACCOUNT = "creator-account-DECOY0002";
/** Planted as the base instructions text in session meta. */
export const DECOY_INSTRUCTIONS = "BASE-INSTRUCTIONS-DECOY-TEXT";
/** Planted in every content-bearing field (prompts, replies, error text). */
export const CODEX_CONTENT_SENTINEL = "CCC-CODEX-CONTENT-SENTINEL";

export const SYNTHETIC_THREAD_ID = "thread-aaaa1111";
export const SYNTHETIC_CWD = "/Users/USERNAME/repo";
export const SYNTHETIC_CLI_VERSION = "0.159.2";
/** The fixed base instant; every builder defaults to an offset from it. */
export const ROLLOUT_BASE_TIME = "2026-10-10T10:00:00.000Z";

export function turnId(n: number): string {
  return `turn-${String(n).padStart(4, "0")}`;
}

/** An ISO time `seconds` after {@link ROLLOUT_BASE_TIME}. */
export function at(seconds: number): string {
  return new Date(Date.parse(ROLLOUT_BASE_TIME) + seconds * 1000).toISOString();
}

/** Counters in the snake-case shape Codex writes. */
export interface RawCounters {
  readonly input_tokens?: number;
  readonly cached_input_tokens?: number;
  readonly cache_write_input_tokens?: number;
  readonly output_tokens?: number;
  readonly reasoning_output_tokens?: number;
  readonly total_tokens?: number;
}

/** A full six-counter usage object; `total` defaults to input + output. */
export function rawCounters(
  input: number,
  output: number,
  extra: Partial<RawCounters> = {},
): RawCounters {
  return {
    input_tokens: input,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
    ...extra,
  };
}

export interface SessionMetaOptions {
  readonly id?: string;
  readonly cwd?: string;
  readonly cliVersion?: string;
  readonly originator?: string;
  readonly source?: unknown;
  readonly timestamp?: string;
}

/** The session_meta line, carrying creator identifiers and instructions that must be dropped. */
export function sessionMetaLine(options: SessionMetaOptions = {}): string {
  const timestamp = options.timestamp ?? at(0);
  return JSON.stringify({
    timestamp,
    type: "session_meta",
    payload: {
      id: options.id ?? SYNTHETIC_THREAD_ID,
      timestamp,
      cwd: options.cwd ?? SYNTHETIC_CWD,
      originator: options.originator ?? "codex_cli_rs",
      cli_version: options.cliVersion ?? SYNTHETIC_CLI_VERSION,
      source: options.source ?? "cli",
      creator_user_id: DECOY_CREATOR_USER,
      creator_account_id: DECOY_CREATOR_ACCOUNT,
      base_instructions: { text: DECOY_INSTRUCTIONS },
      runtime_workspace_roots: ["/Users/USERNAME/repo"],
    },
  });
}

export function turnContextLine(turn: string, timestamp = at(1)): string {
  return JSON.stringify({
    timestamp,
    type: "turn_context",
    payload: { turn_id: turn, cwd: SYNTHETIC_CWD, model: "gpt-synthetic", effort: "medium" },
  });
}

function eventLine(timestamp: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp, type: "event_msg", payload });
}

export function taskStartedLine(turn: string, timestamp = at(2), rootTurn = turn): string {
  return eventLine(timestamp, { type: "task_started", turn_id: turn, root_turn_id: rootTurn });
}

export function taskCompleteLine(turn: string, timestamp = at(60)): string {
  return eventLine(timestamp, {
    type: "task_complete",
    turn_id: turn,
    last_agent_message: `${CODEX_CONTENT_SENTINEL} final words`,
  });
}

export function turnAbortedLine(turn: string, timestamp = at(30)): string {
  return eventLine(timestamp, { type: "turn_aborted", turn_id: turn, reason: "interrupted" });
}

/** A tool call or message line: content that must never reach a fact. */
export function responseItemLine(timestamp = at(10)): string {
  return JSON.stringify({
    timestamp,
    type: "response_item",
    payload: {
      type: "function_call",
      name: "shell",
      arguments: `{"command":["echo","${CODEX_CONTENT_SENTINEL}"]}`,
    },
  });
}

export interface RawRateLimits {
  readonly limit_id?: string;
  readonly limit_name?: string | null;
  readonly primary?: {
    readonly used_percent: number;
    readonly window_minutes: number | null;
    readonly resets_at: number | null;
  } | null;
  readonly secondary?: {
    readonly used_percent: number;
    readonly window_minutes: number | null;
    readonly resets_at: number | null;
  } | null;
  readonly rate_limit_reached_type?: string | null;
}

/** The default rollout rate limits, with a decoy plan, credits and individual limit. */
export function rateLimitsWithDecoys(over: RawRateLimits = {}): Record<string, unknown> {
  return {
    limit_id: "codex",
    limit_name: null,
    primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1_791_000_000 },
    secondary: { used_percent: 7, window_minutes: 10_080, resets_at: 1_791_500_000 },
    credits: { has_credits: true, balance: "DECOY-CREDITS-BALANCE" },
    individual_limit: { decoy: "DECOY-INDIVIDUAL-LIMIT" },
    spend_control_reached: false,
    plan_type: "DECOY-PLAN-TYPE",
    rate_limit_reached_type: null,
    ...over,
  };
}

export interface TokenCountOptions {
  readonly timestamp?: string;
  /** `null` writes `info: null`, as older Codex versions do. */
  readonly total?: RawCounters | null;
  readonly last?: RawCounters;
  readonly rateLimits?: Record<string, unknown> | null;
}

/** An `event_msg` `token_count` line (no turn id; cumulative `total_token_usage`). */
export function tokenCountLine(options: TokenCountOptions = {}): string {
  const total = options.total === undefined ? rawCounters(100, 20) : options.total;
  const info =
    total === null
      ? null
      : {
          total_token_usage: total,
          last_token_usage: options.last ?? total,
          model_context_window: 200_000,
        };
  return eventLine(options.timestamp ?? at(20), {
    type: "token_count",
    info,
    rate_limits: options.rateLimits === undefined ? rateLimitsWithDecoys() : options.rateLimits,
  });
}

export interface TokenUsageRecordOptions {
  readonly threadId?: string;
  readonly turn: string;
  readonly timestamp?: string;
  /** The cumulative usage of the turn so far (`turn_token_usage`). */
  readonly turnUsage: RawCounters;
  readonly threadUsage?: RawCounters;
}

/** A top-level `token_usage_record` line (has a turn id). */
export function tokenUsageRecordLine(options: TokenUsageRecordOptions): string {
  return JSON.stringify({
    timestamp: options.timestamp ?? at(21),
    type: "token_usage_record",
    thread_id: options.threadId ?? SYNTHETIC_THREAD_ID,
    session_id: options.threadId ?? SYNTHETIC_THREAD_ID,
    turn_id: options.turn,
    root_turn_id: options.turn,
    response_id: "resp-synthetic0001",
    usage: options.turnUsage,
    turn_token_usage: options.turnUsage,
    thread_token_usage: options.threadUsage ?? options.turnUsage,
  });
}

/** An `error` event_msg whose message carries content that must be dropped. */
export function errorLine(message: string, timestamp = at(40), type = "error"): string {
  return eventLine(timestamp, { type, message });
}

/** An error whose only limit signal is the structured usage_limit_reached marker. */
export function structuredLimitErrorLine(timestamp = at(41)): string {
  return eventLine(timestamp, {
    type: "error",
    message: `${CODEX_CONTENT_SENTINEL} please try later`,
    codex_error_info: "usage_limit_reached",
  });
}

/** Lines to a rollout text, each newline-terminated. */
export function rolloutText(lines: readonly string[]): string {
  return `${lines.join("\n")}\n`;
}

/** A completed single-turn rollout. */
export function completedRollout(): string {
  return rolloutText([
    sessionMetaLine(),
    turnContextLine(turnId(1)),
    taskStartedLine(turnId(1), at(2)),
    responseItemLine(at(10)),
    taskCompleteLine(turnId(1), at(60)),
  ]);
}

/**
 * A sub-agent rollout: its FIRST lifecycle event is the parent's root
 * `task_started` (a different root turn id), then its own turn starts and
 * completes. Pairing by turn id would report the parent's turn as still open.
 */
export function subAgentRollout(): string {
  return rolloutText([
    sessionMetaLine({ id: "thread-bbbb2222", source: { subagent: "review" } }),
    taskStartedLine(turnId(90), at(1), turnId(90)),
    taskStartedLine(turnId(91), at(2), turnId(90)),
    responseItemLine(at(10)),
    taskCompleteLine(turnId(91), at(50)),
  ]);
}
