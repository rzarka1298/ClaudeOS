import type { IncomingMessage, ServerResponse } from "node:http";
import { type ApiErrorBody, CLAUDE_STATUSLINE_PATH } from "@ccc/domain";
import { logger } from "../logging.js";
import { type BodyParser, readJsonBody } from "../request-body.js";
import type { RouteContext } from "../routes.js";
import { type ClaudeHandler, sendClaudeJson, withClaudeAuth } from "./http.js";

/**
 * The usage and integration-status routes (05-12), every one behind the
 * bearer token. Every refusal body is a module-level constant (T-02-19):
 * no snapshot field, path or reason ever reaches a response.
 */
const ACCEPTED_BODY = { accepted: true } as const;
const INVALID_BODY_BODY: ApiErrorBody = { error: "invalid request body" };
const UNAVAILABLE_BODY: ApiErrorBody = { error: "claude usage unavailable" };
const INTERNAL_ERROR_BODY: ApiErrorBody = { error: "internal error" };

/** One status-line snapshot is a few hundred bytes; 8 KiB leaves headroom (the hook-events cap). */
export const STATUSLINE_BODY_LIMIT_BYTES = 8 * 1024;

/**
 * Accepts any JSON object and hands the whole of it on: the services
 * validate it against `StatusLineSnapshotSchema` themselves, so a snapshot
 * whose shape changed is noted (capacity reads `shape-changed`), not just
 * refused.
 */
const OBJECT_BODY: BodyParser<unknown> = {
  safeParse(input) {
    return typeof input === "object" && input !== null && !Array.isArray(input)
      ? { success: true, data: input }
      : { success: false };
  },
};

async function handleStatusLine(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const usage = ctx.claude?.usage;
  if (usage === undefined) {
    req.resume();
    sendClaudeJson(res, 503, UNAVAILABLE_BODY);
    return;
  }
  const parsed = await readJsonBody(req, OBJECT_BODY, STATUSLINE_BODY_LIMIT_BYTES);
  if (!parsed.ok) {
    logger.warn({ route: CLAUDE_STATUSLINE_PATH, reason: parsed.reason }, "rejected request body");
    sendClaudeJson(res, 400, INVALID_BODY_BODY);
    return;
  }
  try {
    const outcome = usage.handleStatusLine(parsed.value);
    if (outcome === "applied") sendClaudeJson(res, 202, ACCEPTED_BODY);
    else sendClaudeJson(res, 400, INVALID_BODY_BODY);
  } catch (err: unknown) {
    logger.error({ route: CLAUDE_STATUSLINE_PATH, err }, "status-line ingest failed");
    sendClaudeJson(res, 500, INTERNAL_ERROR_BODY);
  }
}

/** `ClaudeHandler` is synchronous by contract; every path resolves to a written response. */
function detached(
  handler: (req: IncomingMessage, res: ServerResponse, ctx: RouteContext) => Promise<void>,
): ClaudeHandler {
  return (req, res, ctx) => {
    void handler(req, res, ctx);
  };
}

export const usageRoutes: Record<string, Record<string, ClaudeHandler>> = {
  [CLAUDE_STATUSLINE_PATH]: { POST: withClaudeAuth(detached(handleStatusLine)) },
};
