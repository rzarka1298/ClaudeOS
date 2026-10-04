import type { IncomingMessage, ServerResponse } from "node:http";
import { LAUNCH_PATH, LaunchRequestSchema } from "@ccc/domain";
import { logger } from "../logging.js";
import { readJsonBody } from "../request-body.js";
import {
  type Handler,
  INTERNAL_ERROR_BODY,
  INVALID_BODY_BODY,
  type RouteContext,
  sendJson,
  withAuth,
} from "../route-kit.js";

/**
 * `POST /api/v1/projects/launch` (D-40): one request, one typed response.
 *
 * The body is `{ projectId, action }` and nothing else — the strict domain
 * schema refuses a `path` or any other key with the constant 400 (T-04-05),
 * so a caller can never name a directory, an application or a URL. Every
 * well-formed request answers 200 with a `LaunchResult`: `{ ok: true }` or
 * one D-26 kind. A launch failure is a result, not an HTTP error, so the
 * client has exactly one parse path.
 *
 * The route is not a general opener (D-19, D-13): it opens only a
 * configured bundle ID, the store-resolved project folder, or an https
 * github.com URL rebuilt from validated parts — all decided inside the
 * launch service.
 */

async function handleLaunch(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const parsed = await readJsonBody(req, LaunchRequestSchema);
  if (!parsed.ok) {
    logger.warn({ route: LAUNCH_PATH, reason: parsed.reason }, "rejected request body");
    sendJson(res, 400, INVALID_BODY_BODY);
    return;
  }
  if (ctx.launch === undefined) {
    logger.error({ route: LAUNCH_PATH }, "launch service not wired");
    sendJson(res, 500, INTERNAL_ERROR_BODY);
    return;
  }
  try {
    const result = await ctx.launch.launch(parsed.value);
    sendJson(res, 200, result);
  } catch (err: unknown) {
    // The launch service never rejects by contract; this is a last resort,
    // logged by error class only (a message could carry a path).
    logger.error(
      { route: LAUNCH_PATH, errorName: err instanceof Error ? err.name : typeof err },
      "launch route failed",
    );
    sendJson(res, 500, INTERNAL_ERROR_BODY);
  }
}

const launchHandler: Handler = (req, res, ctx) => {
  // `Handler` is synchronous by contract; every path inside resolves to a
  // written response.
  void handleLaunch(req, res, ctx);
};

export const launchRoutes: Record<string, Record<string, Handler>> = {
  [LAUNCH_PATH]: { POST: withAuth(launchHandler) },
};
