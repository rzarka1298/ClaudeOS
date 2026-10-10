// Imports node: builtins and relative files only (purity.test.ts), and no
// value from @ccc/domain: the hook may not pull zod in. The domain schema
// (CodexHookRecordSchema) is the contract; minimize.test.ts asserts every
// output validates against it.
import { MAX_RECORD_BYTES } from "../hook/limits.js";

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
 * The payload keys KEPT per event (D-19, own allowlist). The output is BUILT
 * by picking exactly these, never filtered from the payload, so the prompt,
 * the last assistant message, the transcript path, the permission mode, the
 * stop-hook flag, agent keys and every future key are dropped by
 * construction.
 */
export const KEPT_FIELDS: Readonly<Record<string, readonly KeptKey[]>> = {
  Stop: ["session_id", "cwd", "model", "turn_id"],
};

function isKnownEvent(name: string): boolean {
  return Object.hasOwn(KEPT_FIELDS, name);
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
 * Builds the record for a known event from a parsed payload. A kept key that
 * is absent or null is omitted (never defaulted); a kept key that is present
 * but of the wrong type or shape makes the whole record null, so a malformed
 * payload never delivers a partial or reshaped one.
 */
function pickKept(
  eventName: string,
  payload: Record<string, unknown>,
): Record<string, string> | null {
  const picked: Record<string, string> = {};
  for (const key of KEPT_FIELDS[eventName] ?? []) {
    const value = payload[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || !VALIDATORS[key](value)) return null;
    picked[key] = value;
  }
  return picked;
}

export function minimizeCodexHookInput(
  raw: string | null,
  meta: CodexHookMeta,
  options: CodexMinimizeOptions = {},
): MinimizedCodexRecord | null {
  if (raw === null || options.overflowed === true) return null;
  const payload = parsePayload(raw);
  const eventName = payload?.hook_event_name;
  if (payload === null || typeof eventName !== "string" || !isKnownEvent(eventName)) return null;
  const picked = pickKept(eventName, payload);
  if (picked === null || picked.session_id === undefined) return null;
  const record = {
    eventId: meta.eventId,
    observedAt: meta.observedAt,
    hook_event_name: eventName,
    ...picked,
  } as MinimizedCodexRecord;
  return Buffer.byteLength(JSON.stringify(record)) <= MAX_RECORD_BYTES ? record : null;
}
