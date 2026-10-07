import type { ServerResponse } from "node:http";
import {
  TASK_ATTENTION_PATH,
  TASK_COUNTS_PATH,
  TASK_CREATE_PATH,
  TASK_DUE_TODAY_PATH,
  TASK_GET_PATH,
  TASK_LIST_PATH,
  TaskAttentionRequestSchema,
  TaskCountsRequestSchema,
  TaskCreateRequestSchema,
  TaskDueTodayRequestSchema,
  type TaskErrorBody,
  type TaskErrorCode,
  TaskGetRequestSchema,
  TaskListRequestSchema,
} from "@ccc/domain";
import { logger } from "../logging.js";
import { type BodyParser, readJsonBody } from "../request-body.js";
import { type Handler, INTERNAL_ERROR_BODY, sendJson, withAuth } from "../route-kit.js";
import type { TaskResult, TaskServices } from "./types.js";

/**
 * The task routes (plan 06-20; D-28, T-06-20, T-06-27). Fixed paths, no
 * `:param` segment, every one behind the bearer token, every body a strict zod
 * schema. Every refusal is the closed `{ error: <code> }` body the plugin
 * owns the copy for; none names a path, a title or a payload. Specifics stay
 * in the local log, by route and error class name only (an error object can
 * carry a path, so none is ever handed to the logger).
 */

/** A create body can carry a 10,000-character description, escaped; 128 KiB is generous and bounded. */
export const TASK_LARGE_BODY_LIMIT_BYTES = 128 * 1024;

/** List, counts, get, due-today and attention bodies are small: a context, a filter, a zone, a cursor. */
export const TASK_SMALL_BODY_LIMIT_BYTES = 8 * 1024;

/** The HTTP status each closed code answers with. */
const STATUS_OF: Readonly<Record<TaskErrorCode, number>> = {
  "vault-not-set-up": 409,
  "invalid-scope": 400,
  "write-failed": 500,
  "not-found": 404,
  "invalid-cursor": 400,
  "invalid-path": 400,
  "invalid-body": 400,
  "service-disconnected": 503,
  timeout: 504,
  "unrecognised-response": 500,
};

function errorBody(code: TaskErrorCode): TaskErrorBody {
  return { error: code };
}

/** Logs an unexpected failure by route and error class only, then answers the constant 500. */
function sendInternalError(res: ServerResponse, route: string, err: unknown): void {
  logger.error(
    { route, errorName: err instanceof Error ? err.name : typeof err },
    "task route failed",
  );
  if (res.headersSent) return;
  sendJson(res, 500, INTERNAL_ERROR_BODY);
}

/** Sends a service result: the value as 200, or the closed code with its status. */
export function sendResult<T>(res: ServerResponse, result: TaskResult<T>): void {
  if (result.ok) {
    sendJson(res, 200, result.value);
    return;
  }
  sendJson(res, STATUS_OF[result.code], errorBody(result.code));
}

export function postRoute<T>(
  route: string,
  schema: BodyParser<T>,
  limitBytes: number,
  handle: (body: T, res: ServerResponse, services: TaskServices) => void | Promise<void>,
): Handler {
  return withAuth((req, res, ctx) => {
    const run = async (): Promise<void> => {
      const services = ctx.tasks;
      if (services === undefined) {
        // Drain the body so the 503 reaches the caller as a response, not a reset.
        req.resume();
        sendJson(res, 503, errorBody("service-disconnected"));
        return;
      }
      const parsed = await readJsonBody(req, schema, limitBytes);
      if (!parsed.ok) {
        logger.warn({ route, reason: parsed.reason }, "rejected request body");
        sendJson(res, 400, errorBody("invalid-body"));
        return;
      }
      try {
        await handle(parsed.value, res, services);
      } catch (err: unknown) {
        sendInternalError(res, route, err);
      }
    };
    void run();
  });
}

/** `POST /api/v1/tasks/create`: write a new manual task note, index it, announce it. */
const createHandler = postRoute(
  TASK_CREATE_PATH,
  TaskCreateRequestSchema,
  TASK_LARGE_BODY_LIMIT_BYTES,
  (body, res, services) => {
    sendResult(res, services.create(body));
  },
);

/** `POST /api/v1/tasks/list`: one page of a filter in a context. */
const listHandler = postRoute(
  TASK_LIST_PATH,
  TaskListRequestSchema,
  TASK_SMALL_BODY_LIMIT_BYTES,
  (body, res, services) => {
    sendResult(res, services.list(body));
  },
);

/** `POST /api/v1/tasks/counts`: every chip count for a context, from one day computation. */
const countsHandler = postRoute(
  TASK_COUNTS_PATH,
  TaskCountsRequestSchema,
  TASK_SMALL_BODY_LIMIT_BYTES,
  (body, res, services) => {
    sendResult(res, services.counts(body));
  },
);

/** `POST /api/v1/tasks/get`: one task's detail, or the closed not-found body. */
const getHandler = postRoute(
  TASK_GET_PATH,
  TaskGetRequestSchema,
  TASK_SMALL_BODY_LIMIT_BYTES,
  (body, res, services) => {
    sendResult(res, services.get(body));
  },
);

/** `POST /api/v1/tasks/due-today`: the due-today and overdue feed (D-38). */
const dueTodayHandler = postRoute(
  TASK_DUE_TODAY_PATH,
  TaskDueTodayRequestSchema,
  TASK_SMALL_BODY_LIMIT_BYTES,
  (body, res, services) => {
    sendResult(res, services.dueToday(body));
  },
);

/** `POST /api/v1/tasks/attention`: notes the last walk could not index (D-37). */
const attentionHandler = postRoute(
  TASK_ATTENTION_PATH,
  TaskAttentionRequestSchema,
  TASK_SMALL_BODY_LIMIT_BYTES,
  (body, res, services) => {
    sendResult(res, services.attention(body));
  },
);

/** The task route table, spread into the one route table last (R-ROUTEKIT). */
export const taskRoutes: Record<string, Record<string, Handler>> = {
  [TASK_CREATE_PATH]: { POST: createHandler },
  [TASK_LIST_PATH]: { POST: listHandler },
  [TASK_COUNTS_PATH]: { POST: countsHandler },
  [TASK_GET_PATH]: { POST: getHandler },
  [TASK_DUE_TODAY_PATH]: { POST: dueTodayHandler },
  [TASK_ATTENTION_PATH]: { POST: attentionHandler },
};
