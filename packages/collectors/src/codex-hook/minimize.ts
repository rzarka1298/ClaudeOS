// Imports node: builtins and relative files only (purity.test.ts), and no
// value from @ccc/domain: the hook may not pull zod in. The domain schema
// (CodexHookRecordSchema) is the contract; minimize.test.ts asserts every
// output validates against it.
import { MAX_RECORD_BYTES, STDIN_RETAIN_BYTES } from "../hook/limits.js";

/** Hook-minted identity for one invocation. */
export interface CodexHookMeta {
  readonly eventId: string;
  readonly observedAt: string;
}

export interface CodexMinimizeOptions {
  /** Stdin exceeded the retain cap, so `raw` is only its prefix: use the bounded scan. */
  readonly overflowed?: boolean;
}

/** The minimized record the hook delivers or spools. */
export interface MinimizedCodexRecord {
  readonly eventId: string;
  readonly observedAt: string;
  readonly hook_event_name: string;
  readonly session_id: string;
  readonly [key: string]: unknown;
}

/**
 * The five hook events the installer registers, mirrored as a value from
 * `@ccc/domain`'s `CODEX_HOOK_EVENTS` (the hook cannot import values from
 * domain). limits.test.ts asserts the two lists are equal.
 */
export const CODEX_HOOK_KNOWN_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "Interrupt",
  "SessionEnd",
] as const;
export type CodexKnownEvent = (typeof CODEX_HOOK_KNOWN_EVENTS)[number];

/** The payload keys a record may ever carry besides the envelope. */
type KeptKey = "session_id" | "turn_id" | "model" | "cwd" | "source" | "reason";

/** An opaque identifier: the domain's `opaqueId(128)` rule. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
/** A printable model name: the domain's model allowlist. */
const MODEL_PATTERN = /^[A-Za-z0-9 ._-]{1,64}$/;
/** A short identifier-shaped label (`source`, `reason`). */
const LABEL_PATTERN = /^[A-Za-z0-9_.-]{1,32}$/;
/** The domain's path cap. */
const CWD_MAX = 4096;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

const VALIDATORS: Readonly<Record<KeptKey, (value: string) => boolean>> = {
  session_id: (value) => ID_PATTERN.test(value),
  turn_id: (value) => ID_PATTERN.test(value),
  model: (value) => MODEL_PATTERN.test(value),
  cwd: (value) =>
    value.startsWith("/") && value.length <= CWD_MAX && !CONTROL_CHARACTERS.test(value),
  source: (value) => LABEL_PATTERN.test(value),
  reason: (value) => LABEL_PATTERN.test(value),
};

/**
 * The payload keys KEPT per event (D-19, own allowlist; RESEARCH R1 field
 * names). The output is BUILT by picking exactly these, never filtered from
 * the payload, so the prompt, the last assistant message, the transcript
 * path, the permission mode, the stop-hook flag, agent keys and every future
 * key are dropped by construction.
 */
export const KEPT_FIELDS: Readonly<Record<CodexKnownEvent, readonly KeptKey[]>> = {
  SessionStart: ["session_id", "cwd", "model", "source"],
  UserPromptSubmit: ["session_id", "cwd", "model", "turn_id"],
  Stop: ["session_id", "cwd", "model", "turn_id"],
  Interrupt: ["session_id", "cwd", "model", "turn_id"],
  SessionEnd: ["session_id", "cwd", "reason"],
};

function isKnownEvent(name: string): name is CodexKnownEvent {
  return (CODEX_HOOK_KNOWN_EVENTS as readonly string[]).includes(name);
}

/**
 * The order optional fields are dropped in when a record exceeds
 * {@link MAX_RECORD_BYTES}: the longest first. The envelope and `session_id`
 * are never dropped.
 */
const DROP_ORDER = ["cwd", "model", "source", "reason", "turn_id"] as const;

/**
 * The bounded scan used when stdin overflowed the retain cap or does not
 * parse. Each pattern matches a top-level-looking `"key":"value"` pair whose
 * opening quote is not escaped, with a value restricted to identifier
 * characters and length-capped, so the scan is linear and can capture
 * nothing but an identifier. The first match wins: a quote inside a JSON
 * string value is always escaped, so content cannot masquerade as a key.
 */
const SCAN_EVENT_NAME = /(?<![\\\w])"hook_event_name"\s*:\s*"([A-Za-z]{1,64})"/;
const SCAN_SESSION_ID = /(?<![\\\w])"session_id"\s*:\s*"([A-Za-z0-9_-]{1,128})"/;
const SCAN_TURN_ID = /(?<![\\\w])"turn_id"\s*:\s*"([A-Za-z0-9_-]{1,128})"/;

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
 * The only three scalars recoverable from an overflowed or unparseable stdin,
 * scanned from at most {@link STDIN_RETAIN_BYTES} of it. Nothing else of the
 * payload is kept.
 */
function scanIdentifiers(raw: string): Record<string, unknown> | null {
  const text = raw.length > STDIN_RETAIN_BYTES ? raw.slice(0, STDIN_RETAIN_BYTES) : raw;
  const eventName = SCAN_EVENT_NAME.exec(text)?.[1];
  if (eventName === undefined) return null;
  const found: Record<string, unknown> = { hook_event_name: eventName };
  const sessionId = SCAN_SESSION_ID.exec(text)?.[1];
  if (sessionId !== undefined) found.session_id = sessionId;
  const turnId = SCAN_TURN_ID.exec(text)?.[1];
  if (turnId !== undefined) found.turn_id = turnId;
  return found;
}

/**
 * Builds the picked members for a known event from a payload. A kept key that
 * is absent or null is omitted (never defaulted); a kept key that is present
 * but of the wrong type or shape makes the whole record null, so a malformed
 * payload never delivers a partial or reshaped one.
 */
function pickKept(
  eventName: CodexKnownEvent,
  payload: Record<string, unknown>,
): Record<string, string> | null {
  const picked: Record<string, string> = {};
  for (const key of KEPT_FIELDS[eventName]) {
    const value = payload[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || !VALIDATORS[key](value)) return null;
    picked[key] = value;
  }
  return picked;
}

/** Drops optional members in {@link DROP_ORDER} until the record fits {@link MAX_RECORD_BYTES}. */
function capRecord(record: Record<string, unknown>): Record<string, unknown> {
  for (const key of DROP_ORDER) {
    if (Buffer.byteLength(JSON.stringify(record)) <= MAX_RECORD_BYTES) break;
    delete record[key];
  }
  return record;
}

/**
 * Turns the retained stdin text of one Codex hook invocation into the
 * minimized record (D-19). The record is BUILT from the per-event allowlist,
 * never filtered from the payload. An overflowed or unparseable stdin yields
 * only the identifiers a bounded scan finds. Returns `null` (deliver and
 * spool nothing) for an event outside {@link CODEX_HOOK_KNOWN_EVENTS}, a
 * missing or invalid session id, or any kept member of the wrong shape. The
 * Codex record has no environment member, so the process environment is not
 * an input.
 */
export function minimizeCodexHookInput(
  raw: string | null,
  meta: CodexHookMeta,
  options: CodexMinimizeOptions = {},
): MinimizedCodexRecord | null {
  if (raw === null) return null;
  const parsed = options.overflowed === true ? null : parsePayload(raw);
  const payload = parsed ?? scanIdentifiers(raw);
  const eventName = payload?.hook_event_name;
  if (payload === null || typeof eventName !== "string" || !isKnownEvent(eventName)) return null;
  const picked = pickKept(eventName, payload);
  if (picked === null || picked.session_id === undefined) return null;
  const record: Record<string, unknown> = {
    eventId: meta.eventId,
    observedAt: meta.observedAt,
    hook_event_name: eventName,
    ...picked,
  };
  return capRecord(record) as MinimizedCodexRecord;
}
