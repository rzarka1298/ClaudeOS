import type { ServerResponse } from "node:http";
import {
  RESEARCH_LIST_PATH,
  RESEARCH_REPORT_PATH,
  RESEARCH_RUN_PATH,
  RESEARCH_STATUS_PATH,
  type ResearchErrorBody,
  type ResearchErrorCode,
  ResearchListRequestSchema,
  ResearchReportRequestSchema,
  ResearchRunRequestSchema,
  ResearchStatusRequestSchema,
} from "@ccc/domain";
import { logger } from "../logging.js";
import { type BodyParser, readJsonBody } from "../request-body.js";
import { type Handler, sendJson, withAuth } from "../route-kit.js";
import type { ResearchRouteResult, ResearchRouteServices } from "./types.js";

/**
 * The research routes (plan 07-14; D-23, T-07-07, T-07-35). Fixed paths, no `:param` segment,
 * every one behind the bearer token, every body a strict zod schema with a small limit. Every
 * refusal is the closed `{ error: <code> }` body the plugin owns the copy for; none names a path,
 * a title or a payload. Specifics stay in the local log, by route and error class name only (an
 * error object can carry a path, so none is ever handed to the logger).
 */

/** Every research request body is a few hundred bytes: a note id, a page name, a cursor. */
export const RESEARCH_BODY_LIMIT_BYTES = 4 * 1024;

/** The HTTP status each closed code answers with. */
const STATUS_OF: Readonly<Record<ResearchErrorCode, number>> = {
  "vault-not-set-up": 409,
  "not-found": 404,
  "unreadable-report": 422,
  "invalid-body": 400,
  "invalid-cursor": 400,
  "service-disconnected": 503,
  timeout: 504,
  "unrecognised-response": 500,
  internal: 500,
};

function errorBody(code: ResearchErrorCode): ResearchErrorBody {
  return { error: code };
}

/** Logs an unexpected failure by route and error class only, then answers the closed `internal` code. */
function sendInternalError(res: ServerResponse, route: string, err: unknown): void {
  logger.error(
    { route, errorName: err instanceof Error ? err.name : typeof err },
    "research route failed",
  );
  if (res.headersSent) return;
  sendJson(res, STATUS_OF.internal, errorBody("internal"));
}

/** Sends a service result: the value as 200, or the closed code with its status. */
function sendResult<T>(res: ServerResponse, result: ResearchRouteResult<T>): void {
  if (result.ok) {
    sendJson(res, 200, result.value);
    return;
  }
  sendJson(res, STATUS_OF[result.code], errorBody(result.code));
}

function postRoute<T>(
  route: string,
  schema: BodyParser<T>,
  handle: (body: T, services: ResearchRouteServices) => ResearchRouteResult<unknown>,
): Handler {
  return withAuth((req, res, ctx) => {
    const run = async (): Promise<void> => {
      const services = ctx.research;
      if (services === undefined) {
        // Drain the body so the 503 reaches the caller as a response, not a reset.
        req.resume();
        sendJson(res, 503, errorBody("service-disconnected"));
        return;
      }
      const parsed = await readJsonBody(req, schema, RESEARCH_BODY_LIMIT_BYTES);
      if (!parsed.ok) {
        logger.warn({ route, reason: parsed.reason }, "rejected request body");
        sendJson(res, 400, errorBody("invalid-body"));
        return;
      }
      try {
        sendResult(res, handle(parsed.value, services));
      } catch (err: unknown) {
        sendInternalError(res, route, err);
      }
    };
    void run();
  });
}

/** `POST /api/v1/research/run`: start a run now, or answer the run already in flight. */
const runHandler = postRoute(RESEARCH_RUN_PATH, ResearchRunRequestSchema, (_body, services) =>
  services.run(),
);

/** `POST /api/v1/research/list`: one page of the report list. */
const listHandler = postRoute(RESEARCH_LIST_PATH, ResearchListRequestSchema, (body, services) =>
  services.list(body),
);

/** `POST /api/v1/research/report`: one page of one report's view model. */
const reportHandler = postRoute(
  RESEARCH_REPORT_PATH,
  ResearchReportRequestSchema,
  (body, services) => services.report(body),
);

/** `POST /api/v1/research/status`: the run status strip. */
const statusHandler = postRoute(
  RESEARCH_STATUS_PATH,
  ResearchStatusRequestSchema,
  (_body, services) => services.status(),
);

/** The research route table, spread into the one route table beside the task routes. */
export const researchRoutes: Record<string, Record<string, Handler>> = {
  [RESEARCH_RUN_PATH]: { POST: runHandler },
  [RESEARCH_LIST_PATH]: { POST: listHandler },
  [RESEARCH_REPORT_PATH]: { POST: reportHandler },
  [RESEARCH_STATUS_PATH]: { POST: statusHandler },
};
