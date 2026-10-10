import {
  CODEX_FOLLOW_LOG_PATH,
  type CodexActionErrorBody,
  CodexFollowLogRequestSchema,
} from "@ccc/domain";
import { logger } from "../logging.js";
import { readJsonBody } from "../request-body.js";
import { type Handler, sendJson } from "../route-kit.js";
import type { FollowErrorCode, FollowLogService } from "./follow-log.js";
import { type DepsGetter, withCodexDeps } from "./route-support.js";

/**
 * The follow-log route (plan 05.1-26, D-29, CODEX-07, T-05.1-37).
 *
 * `POST /api/v1/codex/follow-log` with the strict body `{ runId }`: a wrapper run id and nothing
 * else (no path, log, rollout, argv or working directory exists in the schema, so none can ride
 * along). The service resolves the run privately and builds the log path itself. The answer is the
 * constant `{ ok: true }` or the constant `{ error: <one fixed code> }`; it never names a path, a
 * run id or process text. Only POST is in the table, so every other method reaches the router's
 * constant not-found.
 *
 * The route is NOT wired into `RouteContext` here (the composition plan does that), and it leaves
 * the open-transcript route alone.
 */
export interface FollowRouteDeps {
  readonly follow: Pick<FollowLogService, "follow">;
}

/** A follow body is one short member. */
const FOLLOW_BODY_LIMIT_BYTES = 1024;

const OK_BODY = { ok: true } as const;
const INVALID_REQUEST_BODY: CodexActionErrorBody = { error: "invalid-request" };

const STATUS_BY_CODE: Readonly<Record<FollowErrorCode, number>> = {
  "not-found": 404,
  "run-ended": 409,
  "bridge-not-installed": 409,
  "window-not-ready": 409,
  failed: 500,
};

export function followRoutes(
  getDeps: DepsGetter<FollowRouteDeps>,
): Record<string, Record<string, Handler>> {
  const followLog = withCodexDeps(getDeps, async (req, res, _ctx, deps) => {
    const body = await readJsonBody(req, CodexFollowLogRequestSchema, FOLLOW_BODY_LIMIT_BYTES);
    if (!body.ok) {
      logger.warn({ route: CODEX_FOLLOW_LOG_PATH, reason: body.reason }, "rejected request body");
      sendJson(res, 400, INVALID_REQUEST_BODY);
      return;
    }
    // A client that goes away cancels a still-waiting follow (the request is withdrawn).
    const controller = new AbortController();
    res.once("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    const outcome = await deps.follow.follow({
      runId: body.value.runId,
      signal: controller.signal,
    });
    if (outcome.ok) {
      sendJson(res, 200, OK_BODY);
      return;
    }
    logger.warn({ route: CODEX_FOLLOW_LOG_PATH, reason: outcome.error }, "follow refused");
    sendJson(res, STATUS_BY_CODE[outcome.error], { error: outcome.error });
  });

  return { [CODEX_FOLLOW_LOG_PATH]: { POST: followLog } };
}
