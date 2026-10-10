import { z } from "zod";
import { API_BASE } from "./api.js";

/**
 * The Codex API contract (plan 05.1-06, CODEX-05, CODEX-07, CODEX-08,
 * CODEX-10, CODEX-11, CODEX-12, D-25): fixed paths under the API base, strict
 * request and response schemas, a fixed action error vocabulary and the SSE
 * payloads. It follows the Phase 5 pattern in `session-actions.ts`: the route
 * table matches exact paths only, so an identifier travels in the JSON body,
 * never in a path segment.
 *
 * This module imports nothing from Node, so both domain barrels re-export it.
 */

/** Every Codex route lives under this base. */
export const CODEX_API_BASE = `${API_BASE}/codex`;

/**
 * `GET` -- the read-only headroom signal (CODEX-11, D-23). There is no body,
 * no request schema and no mutating verb for it anywhere (CODEX-12, D-04):
 * it is a statement about capacity, never an instruction to dispatch work.
 */
export const CODEX_HEADROOM_PATH = `${CODEX_API_BASE}/headroom`;

/**
 * Why a Codex action failed. The plugin owns every word of copy; a body never
 * carries a message, a path or a stack. The service answers with exactly one
 * of these and the client throws it unchanged.
 */
export const CODEX_ACTION_ERROR_CODES = [
  "invalid-request",
  "not-found",
  "outside-sessions-folder",
  "run-ended",
  "bridge-not-installed",
  "bridge-outdated",
  "window-not-ready",
  "unavailable",
  "failed",
] as const;
export type CodexActionErrorCode = (typeof CODEX_ACTION_ERROR_CODES)[number];

/** The strict error body: `{ error: <code> }` and nothing else (T-05.1-13). */
export const CodexActionErrorBodySchema = z.strictObject({
  error: z.enum(CODEX_ACTION_ERROR_CODES),
}) satisfies z.ZodType<{ readonly error: CodexActionErrorCode }, unknown>;
export type CodexActionErrorBody = z.infer<typeof CodexActionErrorBodySchema>;

// RED stub (plan 05.1-06 task 2): signatures only.
export const CODEX_SESSIONS_PATH = "";
export const CODEX_USAGE_PATH = "";
export const CODEX_TOKEN_ACTIVITY_PATH = "";
export const CODEX_INTEGRATION_PATH = "";
export const CODEX_DOCTOR_PATH = "";
export const CODEX_OPEN_TRANSCRIPT_PATH = "";
export const CODEX_FOLLOW_LOG_PATH = "";
export const CODEX_HOOK_EVENTS_PATH = "";
export const CODEX_WRAPPER_RUN_ID_PATTERN = /$^/;
export const CODEX_OPEN_TRANSCRIPT_VIAS = [] as const;
export const CodexOpenTranscriptRequestSchema = z.never();
export const CodexFollowLogRequestSchema = z.never();
export const CodexDoctorRequestSchema = z.never();
export const CodexHookEventsRequestSchema = z.never();
export const CodexActionOkSchema = z.never();
export const CODEX_DOCTOR_CAP_MS = 0;
export const CODEX_DOCTOR_CLIENT_TIMEOUT_MS = 0;
export const CODEX_PAIR_LAUNCH_CAP_MS = 0;
export const CODEX_PAIR_LAUNCH_CLIENT_TIMEOUT_MS = 0;
