// Imports node: builtins and ./ files only, plus TYPE-ONLY imports from
// @ccc/domain (erased at compile time). A value import would pull zod into
// the hook and break purity (PATTERNS Group A, purity.test.ts).
import type { KnownHookEvent, StopFailureError } from "@ccc/domain";
import { MAX_RECORD_BYTES, STDIN_RETAIN_BYTES } from "./limits.js";

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

/** A non-empty string, or `undefined`: the domain schema caps most strings at min(1). */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The value an input key is forwarded as, or `undefined` to drop it. Only
 * scalars cross: an object or array in a kept key is dropped, so no nested
 * payload can ride along under an allowlisted name. An empty string is
 * dropped too: forwarded, it would fail a min(1) field and make a known event
 * shape-invalid, pausing tracking (wave 2 review).
 */
function outputValue(inputKey: string, value: unknown): unknown {
  if (inputKey === "effort") {
    const level =
      typeof value === "object" && value !== null
        ? (value as { level?: unknown }).level
        : undefined;
    return nonEmpty(level);
  }
  if (inputKey === "error") {
    // A present error outside the documented list crosses as "unknown", never
    // as its text, so the record stays known (wave 2 review). An absent error
    // stays absent: a missing field is never defaulted (D-12).
    if (value === undefined) return undefined;
    return isStopFailureError(value) ? value : "unknown";
  }
  if (inputKey === "is_interrupt") {
    return typeof value === "boolean" ? value : undefined;
  }
  return nonEmpty(value);
}

/**
 * The domain schema's length caps for free-text fields (claude-hook-events.ts
 * `COMMON_SHAPE` and `HookEnvSchema`). An over-long value is cut to its cap
 * rather than forwarded: one long session title or tool name must never make
 * a known event classify shape-invalid and pause tracking (wave 1 review).
 * Identifier- and path-shaped fields are NOT cut: a value of the wrong shape
 * there is exactly the telemetry-shape change the service must detect.
 */
const FREE_TEXT_CAPS: Readonly<Record<string, number>> = {
  session_title: 256,
  model: 128,
  tool_name: 128,
  agent_id: 128,
  agent_type: 128,
  from_model: 128,
  to_model: 128,
};

/** `TERM_PROGRAM` is free text too (HookEnvSchema caps it at 64). */
const ENV_CAPS: Readonly<Record<string, number>> = { TERM_PROGRAM: 64 };

/** The envelope's event-name cap; an unknown name is cut to it and still counted. */
const EVENT_NAME_CAP = 64;

/**
 * The order optional fields are dropped in when a record exceeds
 * {@link MAX_RECORD_BYTES}: the plan's fixed order first, then the remaining
 * optional fields, and `session_id` only as the very last resort. The
 * envelope (`eventId`, `observedAt`, `hook_event_name`) is never dropped.
 */
const DROP_ORDER = [
  "session_title",
  "transcript_path",
  "cwd",
  "model",
  "to_model",
  "from_model",
  "agent_type",
  "agent_id",
  "permission_mode",
  "env",
  "notification_type",
  "reason",
  "source",
  "switch_source",
  "stop_error",
  "effort_level",
  "tool_name",
  "is_interrupt",
  "session_id",
] as const;

/**
 * The bounded scan used when stdin overflowed the retain cap or does not
 * parse. Each pattern matches a top-level-looking `"key":"value"` pair whose
 * opening quote is not escaped, with a value restricted to identifier
 * characters and length-capped, so the scan is linear and can capture
 * nothing but the identifier. The first match wins: Claude Code writes the
 * common fields and the event name before any tool payload.
 */
const SCAN_EVENT_NAME = /(?<![\\\w])"hook_event_name"\s*:\s*"([A-Za-z]{1,64})"/;
const SCAN_SESSION_ID = /(?<![\\\w])"session_id"\s*:\s*"([A-Za-z0-9_-]{1,128})"/;

/** Cuts `value` to at most `cap` UTF-16 units without splitting a surrogate pair. */
function truncate(value: string, cap: number): string {
  if (value.length <= cap) return value;
  const cut = value.slice(0, cap);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function pickEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const key of ENV_KEPT) {
    const value = nonEmpty(env[key]);
    if (value !== undefined) {
      const cap = ENV_CAPS[key];
      picked[key] = cap === undefined ? value : truncate(value, cap);
    }
  }
  return picked;
}

function parsePayload(raw: string): Record<string, unknown> | null {
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
 * The only two scalars recoverable from an overflowed or unparseable stdin,
 * scanned from at most {@link STDIN_RETAIN_BYTES} of it. Nothing else of the
 * payload is kept.
 */
function scanIdentifiers(raw: string): Record<string, unknown> | null {
  const text = raw.length > STDIN_RETAIN_BYTES ? raw.slice(0, STDIN_RETAIN_BYTES) : raw;
  const eventName = SCAN_EVENT_NAME.exec(text)?.[1];
  if (eventName === undefined) return null;
  const sessionId = SCAN_SESSION_ID.exec(text)?.[1];
  return sessionId === undefined
    ? { hook_event_name: eventName }
    : { hook_event_name: eventName, session_id: sessionId };
}

function serializedBytes(record: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(record));
}

/** Drops optional fields in {@link DROP_ORDER} until the record fits {@link MAX_RECORD_BYTES}. */
function capRecord(record: Record<string, unknown>): Record<string, unknown> {
  for (const key of DROP_ORDER) {
    if (serializedBytes(record) <= MAX_RECORD_BYTES) break;
    delete record[key];
  }
  return record;
}

export interface MinimizeOptions {
  /** Stdin exceeded the retain cap, so `raw` is only its prefix: use the bounded scan. */
  readonly overflowed?: boolean;
}

/**
 * Turns the retained stdin text of one hook invocation into the minimized
 * record (D-09, PR-04). The record is BUILT from the allowlist, never
 * filtered from the payload, so an unlisted key cannot survive. Free-text
 * fields are cut to the domain caps and the whole record to
 * {@link MAX_RECORD_BYTES}. An overflowed or unparseable stdin yields only
 * `hook_event_name` and `session_id` from a bounded scan. An event name
 * outside {@link HOOK_KNOWN_EVENTS} yields the envelope plus `session_id`,
 * so the service can count it (D-12). Returns `null` only when no
 * `hook_event_name` can be found.
 */
export function minimizeHookInput(
  raw: string | null,
  env: Readonly<Record<string, string | undefined>>,
  meta: HookRecordMeta,
  options: MinimizeOptions = {},
): MinimizedHookRecord | null {
  if (raw === null) return null;
  const parsed = options.overflowed === true ? null : parsePayload(raw);
  const payload = parsed ?? scanIdentifiers(raw);
  const eventName = payload?.hook_event_name;
  if (payload === null || typeof eventName !== "string" || eventName.length === 0) {
    return null;
  }
  const record: Record<string, unknown> = {
    eventId: meta.eventId,
    observedAt: meta.observedAt,
    hook_event_name: truncate(eventName, EVENT_NAME_CAP),
  };
  if (!isKnownEvent(eventName)) {
    if (nonEmpty(payload.session_id) !== undefined) {
      record.session_id = payload.session_id;
    }
    return capRecord(record) as MinimizedHookRecord;
  }
  for (const inputKey of KEPT_FIELDS[eventName]) {
    const value = outputValue(inputKey, payload[inputKey]);
    if (value === undefined) continue;
    const key = outputKey(eventName, inputKey);
    const cap = FREE_TEXT_CAPS[key];
    record[key] = cap !== undefined && typeof value === "string" ? truncate(value, cap) : value;
  }
  const pickedEnv = pickEnv(env);
  if (Object.keys(pickedEnv).length > 0) {
    record.env = pickedEnv;
  }
  return capRecord(record) as MinimizedHookRecord;
}
