import type { IncomingMessage, ServerResponse } from "node:http";
import {
  APPROVAL_DECIDE_PATH,
  APPROVAL_GET_PATH,
  APPROVAL_LIST_PATH,
  APPROVAL_RESPONSE_BUDGET_BYTES,
  APPROVAL_TEST_PATH,
  type ApprovalErrorBody,
  ApprovalGetRequestSchema,
  type ApprovalsSnapshot,
  ApprovalTestRequestSchema,
  DECIDED_VIA_HEADER,
  DecideRequestSchema,
  normaliseDecidedVia,
} from "@ccc/domain";
import { logger } from "../logging.js";
import { type BodyParser, readJsonBody } from "../request-body.js";
import {
  type Handler,
  INTERNAL_ERROR_BODY,
  INVALID_BODY_BODY,
  sendJson,
  withAuth,
} from "../route-kit.js";
import { type ApprovalServices, CLIENT_RESPONSE_CAP_BYTES } from "./types.js";

/**
 * The approval routes (plan 06-13, APPR-03, APPR-04, D-28): list, get, decide
 * and test. Four fixed paths, no `:param` segment, every one behind the bearer
 * token. There is deliberately NO route that accepts an operation name or
 * proposes a request for a client-chosen operation (research Pattern 5, T-06-02):
 * the only request a client can cause to exist is the zero-effect test, and a
 * decision names one request, one choice and the full hash of what the owner
 * saw, nothing else.
 *
 * Every refusal is a constant body that names no path, payload or requester.
 * Specifics stay in the local log, by route and error class name only: an error
 * object can carry a payload, so none is ever handed to the logger.
 */

/** A decision body is a proposal id, one word and a 64-character hash: 4 KiB is generous. */
export const APPROVAL_BODY_LIMIT_BYTES = 4 * 1024;

const UNAVAILABLE_BODY: ApprovalErrorBody = { error: "approval-unavailable" };
const NOT_FOUND_BODY: ApprovalErrorBody = { error: "not-found" };
const TOO_MANY_PENDING_BODY: ApprovalErrorBody = { error: "too-many-pending" };
const OPERATION_RESERVED_BODY: ApprovalErrorBody = { error: "operation-reserved" };
const ACTION_FAILED_BODY: ApprovalErrorBody = { error: "action-failed" };

/** Logs an unexpected failure by route and error class only, then answers the constant 500. */
function sendInternalError(res: ServerResponse, route: string, err: unknown): void {
  logger.error(
    { route, errorName: err instanceof Error ? err.name : typeof err },
    "approval route failed",
  );
  if (res.headersSent) return;
  sendJson(res, 500, INTERNAL_ERROR_BODY);
}

/**
 * The inbox as the list route and the snapshot carry it: the services' bounded
 * snapshot, reported not ready while the services themselves are not ready
 * (startup recovery still running). Never throws on a ready flag.
 */
export function approvalsSnapshotFor(
  services: ApprovalServices,
  budgetBytes?: number,
): ApprovalsSnapshot {
  const snapshot = services.snapshot(budgetBytes);
  return snapshot.ready && !services.ready ? { ...snapshot, ready: false } : snapshot;
}

/** Room left for the member's key, a comma and the envelope's own rounding. */
const SNAPSHOT_MEMBER_OVERHEAD_BYTES = 256;

/**
 * The budget the approvals member of the snapshot may take, given the UTF-8
 * size of the rest of the snapshot body. The client rejects any response over
 * 64 KiB, which would drop the whole snapshot silently, so the approvals part
 * gets what the rest leaves, never more than the domain's own budget (T-06-30).
 */
export function approvalsBudgetFor(restOfSnapshotBytes: number): number {
  const remaining =
    CLIENT_RESPONSE_CAP_BYTES - restOfSnapshotBytes - SNAPSHOT_MEMBER_OVERHEAD_BYTES;
  return Math.max(0, Math.min(APPROVAL_RESPONSE_BUDGET_BYTES, remaining));
}

/** The decision channel: the plugin's own header value exactly, anything else is `other`. */
function decidedViaOf(req: IncomingMessage) {
  const raw = req.headers[DECIDED_VIA_HEADER.toLowerCase()];
  return normaliseDecidedVia(typeof raw === "string" ? raw : undefined);
}

function postRoute<T>(
  route: string,
  schema: BodyParser<T>,
  handle: (
    body: T,
    req: IncomingMessage,
    res: ServerResponse,
    services: ApprovalServices,
  ) => Promise<void>,
): Handler {
  return withAuth((req, res, ctx) => {
    const run = async (): Promise<void> => {
      const services = ctx.approvals;
      if (services === undefined) {
        // Drain the body so the 503 reaches the caller as a response, not a reset.
        req.resume();
        sendJson(res, 503, UNAVAILABLE_BODY);
        return;
      }
      const parsed = await readJsonBody(req, schema, APPROVAL_BODY_LIMIT_BYTES);
      if (!parsed.ok) {
        logger.warn({ route, reason: parsed.reason }, "rejected request body");
        sendJson(res, 400, INVALID_BODY_BODY);
        return;
      }
      try {
        await handle(parsed.value, req, res, services);
      } catch (err: unknown) {
        sendInternalError(res, route, err);
      }
    };
    void run();
  });
}

/** `GET /api/v1/approvals`: the bounded inbox. */
const listHandler: Handler = withAuth((req, res, ctx) => {
  const services = ctx.approvals;
  if (services === undefined) {
    req.resume();
    sendJson(res, 503, UNAVAILABLE_BODY);
    return;
  }
  try {
    sendJson(res, 200, approvalsSnapshotFor(services));
  } catch (err: unknown) {
    sendInternalError(res, APPROVAL_LIST_PATH, err);
  }
});

/** `POST /api/v1/approvals/get`: one request's detail, or the closed not-found body. */
const getHandler = postRoute(
  APPROVAL_GET_PATH,
  ApprovalGetRequestSchema,
  async (body, _req, res, services) => {
    const found = services.get(body.proposalId);
    if (found.kind === "not-found") {
      sendJson(res, 404, NOT_FOUND_BODY);
      return;
    }
    sendJson(res, 200, {
      summary: found.summary,
      view: found.view,
      purged: found.purged,
      payloadHash: found.payloadHash,
    });
  },
);

/**
 * `POST /api/v1/approvals/decide`: approve once or deny one request. A business
 * outcome (decided, hash-mismatch, expired, already-decided, not-found,
 * operation-reserved) is a 200 in the closed vocabulary: the request was
 * understood, the answer is the outcome. The channel is derived from a client
 * header and recorded; it is an accident detector, never a trust signal (D-47).
 */
const decideHandler = postRoute(
  APPROVAL_DECIDE_PATH,
  DecideRequestSchema,
  async (body, req, res, services) => {
    const result = await services.decide({
      proposalId: body.proposalId,
      decision: body.decision,
      payloadHash: body.payloadHash,
      via: decidedViaOf(req),
    });
    sendJson(res, 200, result);
  },
);

/** `POST /api/v1/approvals/test`: raise a test approval that does nothing (D-20). */
const testHandler = postRoute(
  APPROVAL_TEST_PATH,
  ApprovalTestRequestSchema,
  async (body, _req, res, services) => {
    const result = services.test(body);
    if ("kind" in result) {
      logger.warn({ route: APPROVAL_TEST_PATH, reason: result.reason }, "test approval refused");
      if (result.reason === "inbox-full") {
        sendJson(res, 409, TOO_MANY_PENDING_BODY);
      } else if (result.reason === "operation-reserved") {
        sendJson(res, 409, OPERATION_RESERVED_BODY);
      } else {
        sendJson(res, 500, ACTION_FAILED_BODY);
      }
      return;
    }
    sendJson(res, 200, result);
  },
);

/** The approval route table, spread into the one route table last (R-ROUTEKIT). */
export const approvalRoutes: Record<string, Record<string, Handler>> = {
  [APPROVAL_LIST_PATH]: { GET: listHandler },
  [APPROVAL_GET_PATH]: { POST: getHandler },
  [APPROVAL_DECIDE_PATH]: { POST: decideHandler },
  [APPROVAL_TEST_PATH]: { POST: testHandler },
};
