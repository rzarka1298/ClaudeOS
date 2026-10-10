import { SENTINEL } from "./hook-stdin.js";

/**
 * A builder for Codex hook stdin payloads in the shape the upstream input
 * schemas document (RESEARCH R1: `additionalProperties: false`, required keys
 * per event). Every content field is filled with {@link SENTINEL}-tagged
 * synthetic text, so a test can prove none of it reaches a record. Synthetic
 * values only; never a real transcript or session.
 */

export const CODEX_TEST_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "Interrupt",
  "SessionEnd",
] as const;
export type CodexTestEvent = (typeof CODEX_TEST_EVENTS)[number];

export const CODEX_TEST_SESSION_ID = "0196a7c2-5b3d-7e41-9a08-3c6f1d2e4b57";
export const CODEX_TEST_TURN_ID = "0196a7c2-8e10-7a55-b3c9-6d02f4a81e90";
export const CODEX_TEST_CWD = "/Users/USERNAME/code/demo";
export const CODEX_TEST_MODEL = "gpt-5.5-codex";

/** The keys the hook is allowed to forward, per event (the allowlist, restated for the tests). */
export const CODEX_EXPECTED_KEYS: Readonly<Record<CodexTestEvent, readonly string[]>> = {
  SessionStart: [
    "eventId",
    "observedAt",
    "hook_event_name",
    "session_id",
    "cwd",
    "model",
    "source",
  ],
  UserPromptSubmit: [
    "eventId",
    "observedAt",
    "hook_event_name",
    "session_id",
    "cwd",
    "model",
    "turn_id",
  ],
  Stop: ["eventId", "observedAt", "hook_event_name", "session_id", "cwd", "model", "turn_id"],
  Interrupt: ["eventId", "observedAt", "hook_event_name", "session_id", "cwd", "model", "turn_id"],
  SessionEnd: ["eventId", "observedAt", "hook_event_name", "session_id", "cwd", "reason"],
};

/** Every field a Codex payload may carry that must never cross the hook boundary. */
function decoys(): Record<string, unknown> {
  return {
    prompt: `${SENTINEL} the owner's prompt`,
    last_assistant_message: `${SENTINEL} the assistant's reply`,
    transcript_path: `/Users/USERNAME/.codex/sessions/${SENTINEL}.jsonl`,
    permission_mode: `${SENTINEL}-permission`,
    stop_hook_active: true,
    agent_id: `${SENTINEL}-agent`,
    agent_type: `${SENTINEL}-agent-type`,
    tool_input: { command: `${SENTINEL} command` },
    unknown_future_key: `${SENTINEL} unknown`,
  };
}

/** The required fields of each event's documented input, with synthetic values. */
function documented(event: CodexTestEvent): Record<string, unknown> {
  const base = {
    session_id: CODEX_TEST_SESSION_ID,
    cwd: CODEX_TEST_CWD,
    hook_event_name: event,
  };
  switch (event) {
    case "SessionStart":
      return { ...base, model: CODEX_TEST_MODEL, source: "startup" };
    case "SessionEnd":
      return { ...base, reason: "other" };
    case "Stop":
    case "UserPromptSubmit":
    case "Interrupt":
      return { ...base, model: CODEX_TEST_MODEL, turn_id: CODEX_TEST_TURN_ID };
  }
}

export interface BuildCodexStdinOptions {
  /** Keys merged over the built payload (to exercise odd or invalid values). */
  readonly overrides?: Readonly<Record<string, unknown>>;
  /** Keys removed from the built payload. */
  readonly omit?: readonly string[];
  /** Add decoy values in every dropped field (default true). */
  readonly decoys?: boolean;
}

/** One event's stdin payload as an object. */
export function buildCodexPayload(
  event: CodexTestEvent,
  options: BuildCodexStdinOptions = {},
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    ...(options.decoys === false ? {} : decoys()),
    ...documented(event),
    ...options.overrides,
  };
  for (const key of options.omit ?? []) delete payload[key];
  return payload;
}

/** One event's stdin payload as the JSON text Codex writes. */
export function buildCodexStdin(
  event: CodexTestEvent,
  options: BuildCodexStdinOptions = {},
): string {
  return JSON.stringify(buildCodexPayload(event, options));
}
