// Imports node: builtins and ./ files only, plus TYPE-ONLY imports from
// @ccc/domain (erased at compile time). A value import would pull zod into
// the hook and break purity (PATTERNS Group A, purity.test.ts).
import type { KnownHookEvent, StopFailureError } from "@ccc/domain";

/**
 * The hook events this build knows, mirrored as a value from
 * `@ccc/domain`'s `KNOWN_HOOK_EVENTS` (the hook cannot import values from
 * domain). `minimize.test.ts` asserts the two lists are equal.
 */
export const HOOK_KNOWN_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "Stop",
  "StopFailure",
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "TaskCreated",
  "TaskCompleted",
  "UserPromptSubmit",
  "PermissionRequest",
  "PermissionDenied",
  "PostModelSwitch",
  "PostToolUse",
  "PostToolUseFailure",
] as const satisfies readonly KnownHookEvent[];

/**
 * `StopFailure.error` values documented in hooks.md, mirrored from
 * `@ccc/domain`'s `STOP_FAILURE_ERRORS` (asserted equal in the tests). The
 * error crosses the hook boundary only as one of these (PR-04).
 */
export const HOOK_STOP_FAILURE_ERRORS = [
  "rate_limit",
  "overloaded",
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "billing_error",
  "invalid_request",
  "model_not_found",
  "server_error",
  "max_output_tokens",
  "cloud_credential_error",
  "unknown",
] as const satisfies readonly StopFailureError[];

/**
 * Input keys every known event keeps: the hooks.md common input minus
 * `prompt_id` and `scratchpad_dir`. `effort` is an object in the input; only
 * its `level` is kept, as `effort_level`. `agent_id`/`agent_type` are present
 * when the event fires inside a subagent.
 */
const COMMON_KEPT = [
  "session_id",
  "cwd",
  "transcript_path",
  "permission_mode",
  "effort",
  "agent_id",
  "agent_type",
] as const;

/**
 * The input keys KEPT per event (D-09 as amended by PR-04). Everything not
 * listed is dropped by construction: `tool_input`, `tool_response`, prompts,
 * `message`/`title`, `last_assistant_message`, task subjects and
 * descriptions, `permission_suggestions`, `background_tasks`, tool-failure
 * `error`. The only `error` kept is `StopFailure`'s, renamed `stop_error`.
 * Input names are the hooks.md ones (verified against the installed CLI's
 * input schemas on 2026-09-28): `PostModelSwitch` sends `from_model`,
 * `to_model` and `source`; its `source` is renamed `switch_source`.
 */
export const KEPT_FIELDS: Readonly<Record<KnownHookEvent, readonly string[]>> = {
  SessionStart: [...COMMON_KEPT, "source", "model", "session_title"],
  SessionEnd: [...COMMON_KEPT, "reason"],
  Stop: COMMON_KEPT,
  StopFailure: [...COMMON_KEPT, "error"],
  Notification: [...COMMON_KEPT, "notification_type"],
  SubagentStart: COMMON_KEPT,
  SubagentStop: COMMON_KEPT,
  TaskCreated: COMMON_KEPT,
  TaskCompleted: COMMON_KEPT,
  UserPromptSubmit: COMMON_KEPT,
  PermissionRequest: [...COMMON_KEPT, "tool_name"],
  PermissionDenied: [...COMMON_KEPT, "tool_name"],
  PostModelSwitch: [...COMMON_KEPT, "from_model", "to_model", "source"],
  PostToolUse: [...COMMON_KEPT, "tool_name"],
  PostToolUseFailure: [...COMMON_KEPT, "tool_name", "is_interrupt"],
};

/** The environment variables a record may carry (D-09). Every other variable is dropped. */
export const ENV_KEPT = [
  "CLAUDE_PID",
  "TERM_PROGRAM",
  "CLAUDE_CODE_CHILD_SESSION",
  "CCC_RUN_ID",
  "CCC_LAUNCH_SOURCE",
] as const;

/** The record the hook delivers or spools. Known events match domain's `MinimalHookRecord`. */
export interface MinimizedHookRecord {
  readonly eventId: string;
  readonly observedAt: string;
  readonly hook_event_name: string;
  readonly [key: string]: unknown;
}

/** Hook-minted identity for one invocation (D-08). */
export interface HookRecordMeta {
  readonly eventId: string;
  readonly observedAt: string;
}

function isKnownEvent(name: string): name is KnownHookEvent {
  return (HOOK_KNOWN_EVENTS as readonly string[]).includes(name);
}

function isStopFailureError(value: unknown): value is StopFailureError {
  return (
    typeof value === "string" && (HOOK_STOP_FAILURE_ERRORS as readonly string[]).includes(value)
  );
}

/** The output key an input key is forwarded under, for this event. */
function outputKey(event: KnownHookEvent, inputKey: string): string {
  if (inputKey === "effort") return "effort_level";
  if (inputKey === "error") return "stop_error";
  if (event === "PostModelSwitch" && inputKey === "source") return "switch_source";
  return inputKey;
}

/**
 * The value an input key is forwarded as, or `undefined` to drop it. Only
 * scalars cross: an object or array in a kept key is dropped, so no nested
 * payload can ride along under an allowlisted name.
 */
function outputValue(inputKey: string, value: unknown): unknown {
  if (inputKey === "effort") {
    const level =
      typeof value === "object" && value !== null
        ? (value as { level?: unknown }).level
        : undefined;
    return typeof level === "string" ? level : undefined;
  }
  if (inputKey === "error") {
    return isStopFailureError(value) ? value : undefined;
  }
  if (inputKey === "is_interrupt") {
    return typeof value === "boolean" ? value : undefined;
  }
  return typeof value === "string" ? value : undefined;
}

function pickEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const key of ENV_KEPT) {
    const value = env[key];
    if (typeof value === "string") {
      picked[key] = value;
    }
  }
  return picked;
}

function parsePayload(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Turns the retained stdin text of one hook invocation into the minimized
 * record (D-09, PR-04). The record is BUILT from the allowlist, never
 * filtered from the payload, so an unlisted key cannot survive. An event
 * name outside {@link HOOK_KNOWN_EVENTS} still yields the minimal envelope
 * plus `session_id`, so the service can count it (D-12). Returns `null` only
 * when no `hook_event_name` can be found.
 */
export function minimizeHookInput(
  raw: string | null,
  env: Readonly<Record<string, string | undefined>>,
  meta: HookRecordMeta,
): MinimizedHookRecord | null {
  const payload = parsePayload(raw);
  const eventName = payload?.hook_event_name;
  if (payload === null || typeof eventName !== "string" || eventName.length === 0) {
    return null;
  }
  const record: Record<string, unknown> = {
    eventId: meta.eventId,
    observedAt: meta.observedAt,
    hook_event_name: eventName,
  };
  if (!isKnownEvent(eventName)) {
    if (typeof payload.session_id === "string") {
      record.session_id = payload.session_id;
    }
    return record as MinimizedHookRecord;
  }
  for (const inputKey of KEPT_FIELDS[eventName]) {
    const value = outputValue(inputKey, payload[inputKey]);
    if (value !== undefined) {
      record[outputKey(eventName, inputKey)] = value;
    }
  }
  const pickedEnv = pickEnv(env);
  if (Object.keys(pickedEnv).length > 0) {
    record.env = pickedEnv;
  }
  return record as MinimizedHookRecord;
}
