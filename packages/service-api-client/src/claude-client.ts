import {
  ApiErrorBodySchema,
  CLAUDE_INTEGRATION_PATH,
  CLAUDE_TRANSCRIPT_ANALYSIS_PATH,
  CLAUDE_USAGE_DELETE_PATH,
  type ClaudeIntegrationStatus,
  ClaudeIntegrationStatusSchema,
  SessionActionErrorBodySchema,
  type SessionActionErrorCode,
  type TranscriptAnalysisRequest,
  TranscriptAnalysisRequestSchema,
} from "@ccc/domain";
import type { SocketApiClient } from "./socket-api-client.js";
import { SocketUnreachableError } from "./socket-api-client.js";

/**
 * Every Phase 5 route through one typed, validated client (UI-SPEC S5,
 * PATTERNS Group F). Modelled on `socket-api-client.ts`'s
 * `postVaultSetupRequest`: a single generic poster, thin exported wrappers,
 * and errors that carry only a fixed code -- never the server's raw text
 * (the plugin owns all copy, UI-SPEC "reason vocabulary").
 */

/**
 * A client-side failure this package can report for ANY Claude route,
 * beyond the server's own {@link SessionActionErrorCode} vocabulary: the
 * 200 body (or an error body) did not parse against the expected schema.
 */
export type ClaudeClientErrorCode = SessionActionErrorCode | "unrecognised-response";

/**
 * Thrown by every function in this module. `code` is always one fixed
 * value from {@link ClaudeClientErrorCode} -- `message` mirrors it so a
 * bare `error.message` in a log is still meaningful, but no caller may
 * treat `message` as user-facing copy: the plugin owns that (UI-SPEC
 * reason vocabulary).
 */
export class ClaudeRequestError extends Error {
  readonly status: number;
  readonly code: ClaudeClientErrorCode;

  constructor(status: number, code: ClaudeClientErrorCode) {
    super(code);
    this.name = "ClaudeRequestError";
    this.status = status;
    this.code = code;
  }
}

/** The structural shape zod schemas satisfy -- also what `unknownResponse` below implements. */
interface ResponseParser<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false };
}

/**
 * Accepts any 200 body without validating its shape. Used for routes whose
 * success response carries nothing the caller needs to read (e.g. a bare
 * "deleted" acknowledgement) -- `requestClaude` still enforces the 200
 * status and the fixed error-code vocabulary on failure.
 */
const unknownResponse: ResponseParser<unknown> = {
  safeParse: (input: unknown) => ({ success: true, data: input }),
};

/**
 * The one place a Claude route's response becomes a value or a
 * {@link ClaudeRequestError}. A transport failure maps by `errno`
 * (`ETIMEDOUT` -> `timeout`, anything else -> `service-disconnected`); a
 * non-200 body is parsed as {@link SessionActionErrorBodySchema} first (the
 * server's fixed vocabulary), falling back to a schema-shape check via
 * {@link ApiErrorBodySchema} whose free-text field is never surfaced; and a
 * 200 body failing `schema` is `unrecognised-response` -- the same
 * "validate, don't cast" discipline `postVaultSetupRequest` uses, so a
 * malformed response becomes a visible failure here rather than a
 * downstream `undefined`.
 */
async function requestClaude<T>(
  client: SocketApiClient,
  method: string,
  path: string,
  body: unknown,
  schema: ResponseParser<T>,
): Promise<T> {
  let res: { status: number; body: unknown };
  try {
    res = await client.request<unknown>({ method, path, body });
  } catch (error) {
    if (error instanceof SocketUnreachableError) {
      throw new ClaudeRequestError(
        0,
        error.errno === "ETIMEDOUT" ? "timeout" : "service-disconnected",
      );
    }
    throw error;
  }
  if (res.status !== 200) {
    const actionParsed = SessionActionErrorBodySchema.safeParse(res.body);
    if (actionParsed.success) throw new ClaudeRequestError(res.status, actionParsed.data.error);
    // Confirms a generic error shape without ever surfacing its free text --
    // the plugin owns all copy (UI-SPEC reason vocabulary), so an error this
    // client does not recognise collapses to the same fixed code either way.
    ApiErrorBodySchema.safeParse(res.body);
    throw new ClaudeRequestError(res.status, "unrecognised-response");
  }
  const parsed = schema.safeParse(res.body);
  if (!parsed.success) throw new ClaudeRequestError(res.status, "unrecognised-response");
  return parsed.data;
}

/** `GET /api/v1/claude/integration` -- the status Settings shows (PR-24, UI-SPEC S5). */
export function getClaudeIntegration(client: SocketApiClient): Promise<ClaudeIntegrationStatus> {
  return requestClaude(
    client,
    "GET",
    CLAUDE_INTEGRATION_PATH,
    undefined,
    ClaudeIntegrationStatusSchema,
  );
}

/** `POST /api/v1/claude/transcript-analysis` -- turns transcript analysis on or off (D-03, D-48). */
export function setTranscriptAnalysis(
  client: SocketApiClient,
  enabled: boolean,
): Promise<TranscriptAnalysisRequest> {
  const body = TranscriptAnalysisRequestSchema.parse({ enabled });
  return requestClaude(
    client,
    "POST",
    CLAUDE_TRANSCRIPT_ANALYSIS_PATH,
    body,
    TranscriptAnalysisRequestSchema,
  );
}

/**
 * `POST /api/v1/claude/usage/delete` -- deletes cached usage analytics
 * (D-46, USAGE-08). Pulled forward from Task 2's scope because `main.ts`
 * builds the settings tab's whole `SettingsClaudeSeam` in this task, and
 * `main.ts` is not touched again by a later task in this plan.
 */
export function deleteUsageAnalytics(client: SocketApiClient): Promise<void> {
  return requestClaude(client, "POST", CLAUDE_USAGE_DELETE_PATH, undefined, unknownResponse).then(
    () => undefined,
  );
}

// Task 2 adds requestSessionAction and getSessionUsage on this same
// `requestClaude` poster.
