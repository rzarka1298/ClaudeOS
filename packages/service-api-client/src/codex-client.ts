import {
  CODEX_DOCTOR_CLIENT_TIMEOUT_MS,
  CODEX_DOCTOR_PATH,
  CODEX_FOLLOW_LOG_PATH,
  CODEX_HEADROOM_PATH,
  CODEX_INTEGRATION_PATH,
  CODEX_OPEN_TRANSCRIPT_PATH,
  CODEX_PAIR_LAUNCH_CLIENT_TIMEOUT_MS,
  CODEX_SESSIONS_PATH,
  CODEX_TOKEN_ACTIVITY_PATH,
  CODEX_USAGE_PATH,
  CodexActionErrorBodySchema,
  type CodexActionErrorCode,
  type CodexActionOk,
  CodexActionOkSchema,
  CodexDoctorRequestSchema,
  type CodexDoctorSummary,
  CodexDoctorSummarySchema,
  type CodexFollowLogRequest,
  CodexFollowLogRequestSchema,
  type CodexIntegrationStatus,
  CodexIntegrationStatusSchema,
  type CodexOpenTranscriptRequest,
  CodexOpenTranscriptRequestSchema,
  type CodexSessionsSnapshot,
  CodexSessionsSnapshotSchema,
  type CodexTokenSummary,
  CodexTokenSummarySchema,
  type CodexUsageSnapshot,
  CodexUsageSnapshotSchema,
  type HeadroomSignal,
  HeadroomSignalSchema,
  LAUNCH_PAIR_PATH,
  type LaunchPairRequest,
  LaunchPairRequestSchema,
  type LaunchPairResponse,
  LaunchPairResponseSchema,
} from "@ccc/domain";
import type { SocketApiClient } from "./socket-api-client.js";
import { SocketUnreachableError } from "./socket-api-client.js";

/**
 * Every Codex route through one typed, validated client (plan 05.1-06, D-25).
 * Modelled on `claude-client.ts`: a single generic requester, thin exported
 * wrappers, and errors that carry only a fixed code -- never the server's raw
 * text (the plugin owns all copy, T-05.1-13).
 *
 * Read-only by construction (D-04, D-05, CODEX-12): there is no function here
 * that posts to the headroom or usage route, hands work to an agent, spends
 * credits or writes Codex configuration.
 */

/**
 * A client-side failure this package can report for ANY Codex route, beyond
 * the server's own {@link CodexActionErrorCode} vocabulary.
 */
export type CodexClientErrorCode =
  | CodexActionErrorCode
  | "unrecognised-response"
  | "timeout"
  | "service-disconnected";

/**
 * Thrown by every function in this module. `code` is always one fixed value;
 * `message` mirrors it so a bare `error.message` in a log is still meaningful,
 * but no caller may treat `message` as user-facing copy.
 */
export class CodexRequestError extends Error {
  readonly status: number;
  readonly code: CodexClientErrorCode;

  constructor(status: number, code: CodexClientErrorCode) {
    super(code);
    this.name = "CodexRequestError";
    this.status = status;
    this.code = code;
  }
}

/** The structural shape zod schemas satisfy. */
interface ResponseParser<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false };
}

/**
 * The one place a Codex route's response becomes a value or a
 * {@link CodexRequestError}. A transport failure maps by `errno` (`ETIMEDOUT`
 * becomes `timeout`, anything else `service-disconnected`); a non-200 body is
 * parsed through the strict error schema, and anything else collapses to
 * `unrecognised-response` -- the server's free text is never surfaced; a 200
 * body failing `schema` is `unrecognised-response`.
 */
async function requestCodex<T>(
  client: SocketApiClient,
  method: string,
  path: string,
  body: unknown,
  schema: ResponseParser<T>,
  timeoutMs?: number,
): Promise<T> {
  let res: { status: number; body: unknown };
  try {
    res = await client.request<unknown>({
      method,
      path,
      body,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  } catch (error) {
    if (error instanceof SocketUnreachableError) {
      throw new CodexRequestError(
        0,
        error.errno === "ETIMEDOUT" ? "timeout" : "service-disconnected",
      );
    }
    throw error;
  }
  if (res.status !== 200) {
    const actionParsed = CodexActionErrorBodySchema.safeParse(res.body);
    if (actionParsed.success) throw new CodexRequestError(res.status, actionParsed.data.error);
    throw new CodexRequestError(res.status, "unrecognised-response");
  }
  const parsed = schema.safeParse(res.body);
  if (!parsed.success) throw new CodexRequestError(res.status, "unrecognised-response");
  return parsed.data;
}

/**
 * `GET /api/v1/codex/headroom` -- the read-only headroom signal (CODEX-11,
 * CODEX-12, D-23). A GET with no body; called by the Codex card (plan
 * 05.1-18) and the agent-facing callers of the signal.
 */
export function getCodexHeadroom(client: SocketApiClient): Promise<HeadroomSignal> {
  return requestCodex(client, "GET", CODEX_HEADROOM_PATH, undefined, HeadroomSignalSchema);
}

/**
 * `GET /api/v1/codex/sessions` -- the path-free Codex session list (CODEX-05,
 * D-15). A GET with no body; called by the Codex card (plan 05.1-18) on mount
 * and after a reconnect.
 */
export function getCodexSessions(client: SocketApiClient): Promise<CodexSessionsSnapshot> {
  return requestCodex(client, "GET", CODEX_SESSIONS_PATH, undefined, CodexSessionsSnapshotSchema);
}

/**
 * `GET /api/v1/codex/usage` -- the Codex plan-capacity snapshot (CODEX-07,
 * D-23). Read-only: a GET with no body, and this package has no function that
 * posts to the path (CODEX-12). Called by the Codex card (plan 05.1-18).
 */
export function getCodexUsage(client: SocketApiClient): Promise<CodexUsageSnapshot> {
  return requestCodex(client, "GET", CODEX_USAGE_PATH, undefined, CodexUsageSnapshotSchema);
}

/**
 * `GET /api/v1/codex/integration` -- the Codex integration status Settings
 * shows (CODEX-06, CODEX-08). A GET with no body; called by the Settings Codex
 * group (plan 05.1-19).
 */
export function getCodexIntegration(client: SocketApiClient): Promise<CodexIntegrationStatus> {
  return requestCodex(
    client,
    "GET",
    CODEX_INTEGRATION_PATH,
    undefined,
    CodexIntegrationStatusSchema,
  );
}

/**
 * `GET /api/v1/codex/token-activity` -- the precomputed three-range token
 * summary (CODEX-10, D-24). A GET with no body: the plugin never asks for a
 * range. Called by the Codex card (plan 05.1-25).
 */
export function getCodexTokenSummary(client: SocketApiClient): Promise<CodexTokenSummary> {
  return requestCodex(client, "GET", CODEX_TOKEN_ACTIVITY_PATH, undefined, CodexTokenSummarySchema);
}

/**
 * `POST /api/v1/codex/doctor` -- run `codex doctor` once and return the
 * allowlisted summary (CODEX-03, CODEX-08, RESEARCH R4). Owner-triggered; the
 * client waits past the service's 60 second cap. Called by the Settings Codex
 * group (plan 05.1-19).
 */
export async function runCodexDoctor(client: SocketApiClient): Promise<CodexDoctorSummary> {
  const body = CodexDoctorRequestSchema.parse({});
  return requestCodex(
    client,
    "POST",
    CODEX_DOCTOR_PATH,
    body,
    CodexDoctorSummarySchema,
    CODEX_DOCTOR_CLIENT_TIMEOUT_MS,
  );
}

/**
 * `POST /api/v1/codex/open-transcript` -- reveal or open a Codex transcript
 * by thread id (CODEX-05, D-29). The outgoing body is parsed against the
 * strict schema first, so a smuggled path throws before the request is made
 * (T-05.1-10). Called by the quick-action handler (plan 05.1-19).
 */
export async function openCodexTranscript(
  client: SocketApiClient,
  request: CodexOpenTranscriptRequest,
): Promise<CodexActionOk> {
  const body = CodexOpenTranscriptRequestSchema.parse(request);
  return requestCodex(client, "POST", CODEX_OPEN_TRANSCRIPT_PATH, body, CodexActionOkSchema);
}

/**
 * `POST /api/v1/codex/follow-log` -- follow a wrapper run's live log (CODEX-05,
 * D-29). Addressed by wrapper run id only; validated locally first
 * (T-05.1-10). Called by the quick-action handler (plan 05.1-19).
 */
export async function followCodexLog(
  client: SocketApiClient,
  request: CodexFollowLogRequest,
): Promise<CodexActionOk> {
  const body = CodexFollowLogRequestSchema.parse(request);
  return requestCodex(client, "POST", CODEX_FOLLOW_LOG_PATH, body, CodexActionOkSchema);
}

/**
 * `POST /api/v1/projects/launch-pair` -- open Claude Code and Codex together
 * for a project (CODEX-02, D-10). The deadline sits just above the service's
 * 4 second cap, so the service's typed answer (the per-agent envelope or the
 * guard conflict) always arrives first. Called by the project launch toolbar
 * (plan 05.1-17).
 */
export async function launchPair(
  client: SocketApiClient,
  request: LaunchPairRequest,
): Promise<LaunchPairResponse> {
  const body = LaunchPairRequestSchema.parse(request);
  return requestCodex(
    client,
    "POST",
    LAUNCH_PAIR_PATH,
    body,
    LaunchPairResponseSchema,
    CODEX_PAIR_LAUNCH_CLIENT_TIMEOUT_MS,
  );
}
