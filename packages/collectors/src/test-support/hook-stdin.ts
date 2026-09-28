import type { KnownHookEvent } from "@ccc/domain";

/**
 * A seeded builder for hook stdin payloads in their documented input shape
 * (hooks.md, cross-checked against the installed CLI's input schemas). Every
 * sensitive field is filled with {@link SENTINEL}-tagged synthetic text, so a
 * test can prove none of it reaches a record. Never real transcripts.
 */

/** The fixed default seed: the same seed yields the same payload on every machine. */
export const DEFAULT_HOOK_STDIN_SEED = 20260928;

/** Every sensitive value contains this marker; no minimized record may. */
export const SENTINEL = "CCC-SENTINEL";

/** A synthetic secret-shaped environment value that must never ride along. */
export const ENV_SENTINEL = "CCC-ENV-SENTINEL-sk-000";

/** mulberry32: a tiny seeded PRNG (same generator as test-fixtures' synthetic notes). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];

/** Seeded filler text of exactly `bytes` ASCII bytes, with a sentinel every ~200 bytes. */
export function sentinelText(bytes: number, seed = DEFAULT_HOOK_STDIN_SEED): string {
  const next = mulberry32(seed);
  const parts: string[] = [];
  let length = 0;
  while (length < bytes) {
    const word =
      parts.length % 32 === 0
        ? `${SENTINEL}-${parts.length}`
        : (WORDS[Math.floor(next() * 8)] ?? "x");
    parts.push(word);
    length += word.length + 1;
  }
  return parts.join(" ").slice(0, bytes);
}

/** A seeded UUID-shaped session id. */
function seededSessionId(next: () => number): string {
  const hex = (count: number): string =>
    Array.from({ length: count }, () => Math.floor(next() * 16).toString(16)).join("");
  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
}

export interface BuildHookStdinOptions {
  readonly seed?: number;
  /** Size of the tool_input/tool_response filler for tool events (default 64 bytes each). */
  readonly toolPayloadBytes?: number;
  /** Keys merged over the built payload (to exercise caps and odd values). */
  readonly overrides?: Readonly<Record<string, unknown>>;
}

/** The documented common input every event carries, with synthetic values. */
function commonInput(event: KnownHookEvent, sessionId: string): Record<string, unknown> {
  return {
    session_id: sessionId,
    transcript_path: `/Users/USERNAME/.claude/projects/demo/${sessionId}.jsonl`,
    cwd: "/Users/USERNAME/code/demo",
    prompt_id: `${SENTINEL}-prompt-id`,
    scratchpad_dir: `/Users/USERNAME/.claude/scratch/${SENTINEL}`,
    permission_mode: "default",
    effort: { level: "high" },
    hook_event_name: event,
  };
}

/** The event-specific input, sensitive fields sentinel-filled. */
function eventInput(
  event: KnownHookEvent,
  toolBytes: number,
  seed: number,
): Record<string, unknown> {
  const toolInput = { command: sentinelText(toolBytes, seed + 1) };
  switch (event) {
    case "SessionStart":
      return { source: "startup", model: "claude-opus-5-5", session_title: "Demo session" };
    case "SessionEnd":
      return { reason: "prompt_input_exit" };
    case "Stop":
      return { stop_hook_active: false, last_assistant_message: `${SENTINEL} assistant text` };
    case "StopFailure":
      return {
        error: "rate_limit",
        error_details: `${SENTINEL} error details`,
        last_assistant_message: `${SENTINEL} assistant text`,
      };
    case "Notification":
      return {
        message: `${SENTINEL} notification message`,
        title: `${SENTINEL} title`,
        notification_type: "permission_prompt",
      };
    case "SubagentStart":
      return { agent_id: "agent-1", agent_type: "general-purpose" };
    case "SubagentStop":
      return {
        stop_hook_active: false,
        agent_id: "agent-1",
        agent_type: "general-purpose",
        agent_transcript_path: `/Users/USERNAME/.claude/projects/demo/${SENTINEL}.jsonl`,
        last_assistant_message: `${SENTINEL} subagent answer`,
        background_tasks: [{ id: `${SENTINEL}-task` }],
      };
    case "TaskCreated":
    case "TaskCompleted":
      return {
        task_id: "task-1",
        task_subject: `${SENTINEL} subject`,
        task_description: `${SENTINEL} description`,
        teammate_name: `${SENTINEL} teammate`,
      };
    case "UserPromptSubmit":
      return { prompt: `${SENTINEL} the owner's prompt`, source: "user" };
    case "PermissionRequest":
      return {
        tool_name: "Bash",
        tool_input: toolInput,
        permission_suggestions: [{ rule: `${SENTINEL} suggestion` }],
      };
    case "PermissionDenied":
      return {
        tool_name: "Bash",
        tool_input: toolInput,
        tool_use_id: "toolu_1",
        reason: `${SENTINEL} denial reason`,
      };
    case "PostModelSwitch":
      return {
        from_model: "claude-sonnet-5",
        to_model: "claude-opus-5-5",
        requested_model: "opus",
        source: "command",
        context_tokens: 1200,
        prompt_cache_warm: true,
      };
    case "PostToolUse":
      return {
        tool_name: "Bash",
        tool_input: toolInput,
        tool_response: { stdout: sentinelText(toolBytes, seed + 2), stderr: `${SENTINEL} err` },
        tool_use_id: "toolu_1",
        duration_ms: 12,
      };
    case "PostToolUseFailure":
      return {
        tool_name: "Bash",
        tool_input: toolInput,
        tool_use_id: "toolu_1",
        error: `${SENTINEL} command failed: output`,
        is_interrupt: false,
        duration_ms: 12,
      };
  }
}

/** One event's stdin payload as an object. */
export function buildHookPayload(
  event: KnownHookEvent,
  options: BuildHookStdinOptions = {},
): Record<string, unknown> {
  const seed = options.seed ?? DEFAULT_HOOK_STDIN_SEED;
  const next = mulberry32(seed);
  return {
    ...commonInput(event, seededSessionId(next)),
    ...eventInput(event, options.toolPayloadBytes ?? 64, seed),
    ...options.overrides,
  };
}

/** One event's stdin payload as the JSON text Claude Code writes. */
export function buildHookStdin(event: KnownHookEvent, options: BuildHookStdinOptions = {}): string {
  return JSON.stringify(buildHookPayload(event, options));
}
