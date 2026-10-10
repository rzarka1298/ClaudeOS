import {
  APPROVAL_DECIDE_PATH,
  APPROVAL_GET_PATH,
  APPROVAL_LIST_PATH,
  APPROVAL_TEST_PATH,
  type ApprovalDecision,
  type ApprovalDetailResponse,
  ApprovalDetailResponseSchema,
  type ApprovalErrorCode,
  ApprovalErrorCodeSchema,
  ApprovalGetRequestSchema,
  type ApprovalsSnapshot,
  ApprovalsSnapshotSchema,
  type ApprovalTestRequest,
  ApprovalTestRequestSchema,
  type ApprovalTestResponse,
  ApprovalTestResponseSchema,
  DECIDED_VIA_HEADER,
  DECIDED_VIA_PLUGIN,
  DecideRequestSchema,
  type DecideResponse,
  DecideResponseSchema,
} from "@ccc/domain";
import type { SocketApiClient } from "./socket-api-client.js";
import { SocketUnreachableError } from "./socket-api-client.js";

/**
 * The approval routes through one typed, validated client (plan 06-13, D-28,
 * PATTERNS Group G). Modelled on `claude-client.ts`: a single generic poster,
 * thin wrappers, and errors that carry only a status and a fixed code. The
 * plugin owns all copy, so no server text, socket path or schema message ever
 * reaches a caller.
 *
 * The value exports of this package pull in Node HTTP, so the plugin receives
 * these functions by injection and never imports them from view code.
 */

/** Every failure this client can report: the server's closed codes plus the three transport-side ones. */
export type ApprovalClientErrorCode =
  | ApprovalErrorCode
  | "timeout"
  | "service-disconnected"
  | "unrecognised-response";

/**
 * Thrown by every function in this module. `message` mirrors `code` so a bare
 * log line is meaningful; no caller may treat it as user-facing copy.
 */
export class ApprovalRequestError extends Error {
  readonly status: number;
  readonly code: ApprovalClientErrorCode;

  constructor(status: number, code: ApprovalClientErrorCode) {
    super(code);
    this.name = "ApprovalRequestError";
    this.status = status;
    this.code = code;
  }
}

/** What a decision names: one request, one choice, the hash of what was shown. Nothing else. */
export interface ApprovalDecideInput {
  readonly proposalId: string;
  readonly decision: ApprovalDecision;
  readonly payloadHash: string;
}

export interface ApprovalsClient {
  list(): Promise<ApprovalsSnapshot>;
  get(proposalId: string): Promise<ApprovalDetailResponse>;
  decide(input: ApprovalDecideInput): Promise<DecideResponse>;
  test(request?: ApprovalTestRequest): Promise<ApprovalTestResponse>;
}

interface ResponseParser<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false };
}

interface RequestValidator<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false };
}

/** The closed code a non-200 body names, or null when it names none. */
function closedCodeOf(body: unknown): ApprovalErrorCode | null {
  if (typeof body !== "object" || body === null || !("error" in body)) return null;
  const parsed = ApprovalErrorCodeSchema.safeParse((body as { error: unknown }).error);
  return parsed.success ? parsed.data : null;
}

/**
 * The one place an approval route's response becomes a value or an
 * {@link ApprovalRequestError}. A transport failure maps by `errno`
 * (`ETIMEDOUT` to `timeout`, anything else to `service-disconnected`); a
 * non-200 body maps to its closed code, or to `unrecognised-response` when it
 * names none (a generic constant body's text is never surfaced); a 200 body
 * failing `schema` is `unrecognised-response`.
 */
async function requestApproval<T>(
  client: SocketApiClient,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  schema: ResponseParser<T>,
  headers?: Record<string, string>,
): Promise<T> {
  let res: { status: number; body: unknown };
  try {
    res = await client.request<unknown>({
      method,
      path,
      ...(body === undefined ? {} : { body }),
      ...(headers === undefined ? {} : { headers }),
    });
  } catch (error) {
    if (error instanceof SocketUnreachableError) {
      throw new ApprovalRequestError(
        0,
        error.errno === "ETIMEDOUT" ? "timeout" : "service-disconnected",
      );
    }
    throw error;
  }
  if (res.status !== 200) {
    throw new ApprovalRequestError(res.status, closedCodeOf(res.body) ?? "unrecognised-response");
  }
  const parsed = schema.safeParse(res.body);
  if (!parsed.success) throw new ApprovalRequestError(res.status, "unrecognised-response");
  return parsed.data;
}

/**
 * Validates an outgoing body against its strict schema before any request: an
 * extra key, including anything shaped like a remembered choice, or an
 * operation name, never leaves the process. The failure carries a fixed code,
 * not the schema's message.
 */
function outgoing<T>(schema: RequestValidator<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApprovalRequestError(0, "action-failed");
  return parsed.data;
}

export function createApprovalsClient(client: SocketApiClient): ApprovalsClient {
  return {
    list: () =>
      requestApproval(client, "GET", APPROVAL_LIST_PATH, undefined, ApprovalsSnapshotSchema),
    // `async` so a malformed id rejects rather than throwing before a promise exists.
    get: async (proposalId) =>
      requestApproval(
        client,
        "POST",
        APPROVAL_GET_PATH,
        outgoing(ApprovalGetRequestSchema, { proposalId }),
        ApprovalDetailResponseSchema,
      ),
    decide: async (input) =>
      requestApproval(
        client,
        "POST",
        APPROVAL_DECIDE_PATH,
        outgoing(DecideRequestSchema, input),
        DecideResponseSchema,
        // A hint for the audit trail, never an authority (D-47).
        { [DECIDED_VIA_HEADER]: DECIDED_VIA_PLUGIN },
      ),
    test: async (request) =>
      requestApproval(
        client,
        "POST",
        APPROVAL_TEST_PATH,
        outgoing(ApprovalTestRequestSchema, request ?? {}),
        ApprovalTestResponseSchema,
      ),
  };
}
