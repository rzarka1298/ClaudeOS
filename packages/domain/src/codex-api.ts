import { z } from "zod";
import { API_BASE } from "./api.js";
import { CodexHookRecordSchema, CodexSessionViewSchema } from "./codex-sessions.js";

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

// ---------------------------------------------------------------------------
// Routes. Reads are GET with no body; actions are POST with a strict body. A
// GET route has no request schema at all, so nothing can ride along.

/** `GET` -- the Codex session list (CODEX-05, D-15), path-free. */
export const CODEX_SESSIONS_PATH = `${CODEX_API_BASE}/sessions`;
/** `GET` -- the Codex usage snapshot, plan capacity only (CODEX-07, D-23). Read-only (CODEX-12). */
export const CODEX_USAGE_PATH = `${CODEX_API_BASE}/usage`;
/**
 * `GET` -- the precomputed Codex token summary (CODEX-10, D-24): all three
 * ranges, so the plugin never asks for one.
 */
export const CODEX_TOKEN_ACTIVITY_PATH = `${CODEX_API_BASE}/token-activity`;
/** `GET` -- the Codex integration status for Settings (CODEX-06, CODEX-08). */
export const CODEX_INTEGRATION_PATH = `${CODEX_API_BASE}/integration`;
/** `POST` -- run `codex doctor` once, owner-triggered (RESEARCH R4). Strict empty body. */
export const CODEX_DOCTOR_PATH = `${CODEX_API_BASE}/doctor`;
/** `POST` -- reveal or open a session's transcript, addressed by thread id (D-29). */
export const CODEX_OPEN_TRANSCRIPT_PATH = `${CODEX_API_BASE}/open-transcript`;
/** `POST` -- follow a wrapper run's live log in the Antigravity terminal (D-29). */
export const CODEX_FOLLOW_LOG_PATH = `${CODEX_API_BASE}/follow-log`;
/**
 * `POST` -- the Codex hook delivers one minimized record (RESEARCH R1). Only
 * the hook process posts here: the client package has no function for it.
 */
export const CODEX_HOOK_EVENTS_PATH = `${CODEX_API_BASE}/hook-events`;

// ---------------------------------------------------------------------------
// Request schemas. Every one is strict, and none has a path, rollout, file,
// argv or shell member: the service resolves every path from its own records
// by thread id or wrapper run id (D-29, T-05.1-10).

/**
 * A thread id is the session view's own id schema, so the request and the
 * view cannot drift apart.
 */
const CodexThreadIdSchema = CodexSessionViewSchema.shape.threadId;

/**
 * A wrapper run id: eight digits, a `T`, nine digits and a `Z` (the stamp the
 * bridge wrapper mints, for example `20261006T120000123Z`).
 */
export const CODEX_WRAPPER_RUN_ID_PATTERN = /^\d{8}T\d{9}Z$/;

/** `reveal` shows the transcript in Finder; `open` hands it to the default app. */
export const CODEX_OPEN_TRANSCRIPT_VIAS = ["reveal", "open"] as const;
export type CodexOpenTranscriptVia = (typeof CODEX_OPEN_TRANSCRIPT_VIAS)[number];

export const CodexOpenTranscriptRequestSchema = z.strictObject({
  threadId: CodexThreadIdSchema,
  via: z.enum(CODEX_OPEN_TRANSCRIPT_VIAS),
});
export type CodexOpenTranscriptRequest = z.infer<typeof CodexOpenTranscriptRequestSchema>;

export const CodexFollowLogRequestSchema = z.strictObject({
  runId: z.string().regex(CODEX_WRAPPER_RUN_ID_PATTERN, { message: "must be a wrapper run id" }),
});
export type CodexFollowLogRequest = z.infer<typeof CodexFollowLogRequestSchema>;

/** The doctor body is empty: the service builds the whole command itself. */
export const CodexDoctorRequestSchema = z.strictObject({});
export type CodexDoctorRequest = z.infer<typeof CodexDoctorRequestSchema>;

/** The hook route takes the minimized hook record and nothing else. */
export const CodexHookEventsRequestSchema = CodexHookRecordSchema;
export type CodexHookEventsRequest = z.infer<typeof CodexHookEventsRequestSchema>;

/** Action success: the constant `{ ok: true }`. */
export const CodexActionOkSchema = z.strictObject({ ok: z.literal(true) });
export type CodexActionOk = z.infer<typeof CodexActionOkSchema>;

// ---------------------------------------------------------------------------
// Deadlines. The client always waits a little longer than the service's own
// cap, so the service's typed answer arrives before the client gives up.

/** The service's cap on one `codex doctor` run (RESEARCH R4). */
export const CODEX_DOCTOR_CAP_MS = 60_000;
/** The client's doctor deadline: above the service cap. */
export const CODEX_DOCTOR_CLIENT_TIMEOUT_MS = CODEX_DOCTOR_CAP_MS + 10_000;
/** The service's cap on the pair launch (CODEX-02), equal to the Phase 4 launch cap. */
export const CODEX_PAIR_LAUNCH_CAP_MS = 4_000;
/** The client's pair launch deadline: just above the service cap. */
export const CODEX_PAIR_LAUNCH_CLIENT_TIMEOUT_MS = CODEX_PAIR_LAUNCH_CAP_MS + 500;
