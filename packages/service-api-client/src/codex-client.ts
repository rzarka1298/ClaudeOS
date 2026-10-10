import {
  CODEX_HEADROOM_PATH,
  CodexActionErrorBodySchema,
  type CodexActionErrorCode,
  type HeadroomSignal,
  HeadroomSignalSchema,
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
 * that posts to the headroom or usage route, dispatches work, consumes
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
 * 05.1-18) and the agent-facing consumers of the signal.
 */
export function getCodexHeadroom(client: SocketApiClient): Promise<HeadroomSignal> {
  return requestCodex(client, "GET", CODEX_HEADROOM_PATH, undefined, HeadroomSignalSchema);
}

// RED stub (plan 05.1-06 task 2): signatures only.
const stub = (): Promise<never> => Promise.resolve(undefined as never);
export const getCodexSessions = (_client: SocketApiClient) => stub();
export const getCodexUsage = (_client: SocketApiClient) => stub();
export const getCodexIntegration = (_client: SocketApiClient) => stub();
export const getCodexTokenSummary = (_client: SocketApiClient) => stub();
export const runCodexDoctor = (_client: SocketApiClient) => stub();
export const openCodexTranscript = (_client: SocketApiClient, _request: unknown) => stub();
export const followCodexLog = (_client: SocketApiClient, _request: unknown) => stub();
export const launchPair = (_client: SocketApiClient, _request: unknown) => stub();
