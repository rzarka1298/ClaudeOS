import {
  RESEARCH_LIST_PATH,
  RESEARCH_REPORT_PATH,
  RESEARCH_RUN_PATH,
  RESEARCH_STATUS_PATH,
  ResearchErrorBodySchema,
  type ResearchErrorCode,
  type ResearchListRequest,
  ResearchListRequestSchema,
  type ResearchListResponse,
  ResearchListResponseSchema,
  type ResearchReportRequest,
  ResearchReportRequestSchema,
  type ResearchReportResponse,
  ResearchReportResponseSchema,
  ResearchRunRequestSchema,
  type ResearchRunResponse,
  ResearchRunResponseSchema,
  ResearchStatusRequestSchema,
  type ResearchStatusResponse,
  ResearchStatusResponseSchema,
} from "@ccc/domain";
import type { SocketApiClient } from "./socket-api-client.js";
import { SocketUnreachableError } from "./socket-api-client.js";

/**
 * The research routes through one typed, validated client (plan 07-15, D-23, T-07-32). Modelled
 * on `tasks-client.ts`: one generic poster, thin wrappers, and errors that carry only a status
 * and a closed code. The plugin owns all copy, so no server text, socket path or schema message
 * ever reaches a caller.
 *
 * The value exports of this package pull in Node HTTP, so the plugin receives these functions by
 * injection and never imports them from view code.
 */

/**
 * Thrown by every function in this module. `message` mirrors `code` so a bare log line is
 * meaningful; no caller may treat it as user-facing copy.
 */
export class ResearchRequestError extends Error {
  readonly status: number;
  readonly code: ResearchErrorCode;

  constructor(status: number, code: ResearchErrorCode) {
    super(code);
    this.name = "ResearchRequestError";
    this.status = status;
    this.code = code;
  }
}

export interface ResearchClient {
  /** Starts a run now, or answers the one already running. */
  run(): Promise<ResearchRunResponse>;
  list(request: ResearchListRequest): Promise<ResearchListResponse>;
  report(request: ResearchReportRequest): Promise<ResearchReportResponse>;
  status(): Promise<ResearchStatusResponse>;
}

interface Parser<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false };
}

/**
 * Validates an outgoing body against its strict schema before any request: an extra key, an id
 * that is not an id or a cursor that is not URL-safe never leaves the process. The failure
 * carries a fixed code, not the schema's message.
 */
function outgoing<T>(schema: Parser<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ResearchRequestError(0, "invalid-body");
  return parsed.data;
}

/**
 * The one place a research route's response becomes a value or a {@link ResearchRequestError}. A
 * transport failure maps by `errno` (`ETIMEDOUT` to `timeout`, anything else to
 * `service-disconnected`); a non-200 body maps to its closed code, or to `unrecognised-response`
 * when it names none; a 200 body that fails `schema` is `unrecognised-response`.
 */
async function requestResearch<T>(
  client: SocketApiClient,
  path: string,
  body: unknown,
  schema: Parser<T>,
): Promise<T> {
  let res: { status: number; body: unknown };
  try {
    res = await client.request<unknown>({ method: "POST", path, body });
  } catch (error) {
    if (error instanceof SocketUnreachableError) {
      throw new ResearchRequestError(
        0,
        error.errno === "ETIMEDOUT" ? "timeout" : "service-disconnected",
      );
    }
    throw error;
  }
  if (res.status !== 200) {
    const closed = ResearchErrorBodySchema.safeParse(res.body);
    throw new ResearchRequestError(
      res.status,
      closed.success ? closed.data.error : "unrecognised-response",
    );
  }
  const parsed = schema.safeParse(res.body);
  if (!parsed.success) throw new ResearchRequestError(res.status, "unrecognised-response");
  return parsed.data;
}

export function createResearchClient(client: SocketApiClient): ResearchClient {
  return {
    // `async` so an invalid request rejects rather than throwing before a promise exists.
    run: async () =>
      requestResearch(
        client,
        RESEARCH_RUN_PATH,
        outgoing(ResearchRunRequestSchema, {}),
        ResearchRunResponseSchema,
      ),
    list: async (request) =>
      requestResearch(
        client,
        RESEARCH_LIST_PATH,
        outgoing(ResearchListRequestSchema, request),
        ResearchListResponseSchema,
      ),
    report: async (request) =>
      requestResearch(
        client,
        RESEARCH_REPORT_PATH,
        outgoing(ResearchReportRequestSchema, request),
        ResearchReportResponseSchema,
      ),
    status: async () =>
      requestResearch(
        client,
        RESEARCH_STATUS_PATH,
        outgoing(ResearchStatusRequestSchema, {}),
        ResearchStatusResponseSchema,
      ),
  };
}
