import type { IncomingMessage, ServerResponse } from "node:http";
import {
  type ApiErrorBody,
  CLAUDE_INTEGRATION_PATH,
  CLAUDE_SESSION_USAGE_PATH,
  CLAUDE_STATUSLINE_PATH,
  CLAUDE_TRANSCRIPT_ANALYSIS_PATH,
  CLAUDE_USAGE_DELETE_PATH,
  type RunId,
  type SessionActionErrorBody,
  SessionActionRequestSchema,
  TranscriptAnalysisRequestSchema,
} from "@ccc/domain";
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

/** The toggle and session-usage bodies are a few bytes (T-02-20). */
const SMALL_BODY_LIMIT_BYTES = 1024;
const RUN_NOT_FOUND_BODY: SessionActionErrorBody = { error: "run-not-found" };
const DELETED_BODY = { deleted: true } as const;

/**
 * Reads a body that must be empty or `{}` (the delete route takes no
 * parameters). Bounded like every other body; anything else is refused.
 */
function readEmptyBody(req: IncomingMessage): Promise<boolean> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    const settle = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received <= SMALL_BODY_LIMIT_BYTES) chunks.push(chunk);
    });
    req.on("error", () => settle(false));
    req.on("end", () => {
      if (received > SMALL_BODY_LIMIT_BYTES) return settle(false);
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (text.length === 0) return settle(true);
      try {
        const value: unknown = JSON.parse(text);
        settle(
          typeof value === "object" &&
            value !== null &&
            !Array.isArray(value) &&
            Object.keys(value).length === 0,
        );
      } catch {
        settle(false);
      }
    });
  });
}

/** `GET /api/v1/claude/integration` (PR-24): booleans, integers, a timestamp and a version. */
async function handleIntegration(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  req.resume();
  const usage = ctx.claude?.usage;
  if (usage === undefined) {
    sendClaudeJson(res, 503, UNAVAILABLE_BODY);
    return;
  }
  try {
    sendClaudeJson(res, 200, usage.integration());
  } catch (err: unknown) {
    logger.error({ route: CLAUDE_INTEGRATION_PATH, err }, "integration status failed");
    sendClaudeJson(res, 500, INTERNAL_ERROR_BODY);
  }
}

/** `POST /api/v1/claude/transcript-analysis` `{ enabled }` (D-03, D-47, D-48). */
async function handleTranscriptAnalysis(
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
  const parsed = await readJsonBody(req, TranscriptAnalysisRequestSchema, SMALL_BODY_LIMIT_BYTES);
  if (!parsed.ok) {
    logger.warn(
      { route: CLAUDE_TRANSCRIPT_ANALYSIS_PATH, reason: parsed.reason },
      "rejected request body",
    );
    sendClaudeJson(res, 400, INVALID_BODY_BODY);
    return;
  }
  try {
    sendClaudeJson(res, 200, await usage.setTranscriptAnalysis(parsed.value.enabled));
  } catch (err: unknown) {
    logger.error({ route: CLAUDE_TRANSCRIPT_ANALYSIS_PATH, err }, "analysis toggle failed");
    sendClaudeJson(res, 500, INTERNAL_ERROR_BODY);
  }
}

/** `POST /api/v1/claude/usage/delete` (D-46, USAGE-08): one transaction; Runs untouched. */
async function handleUsageDelete(
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
  if (!(await readEmptyBody(req))) {
    logger.warn({ route: CLAUDE_USAGE_DELETE_PATH }, "rejected request body");
    sendClaudeJson(res, 400, INVALID_BODY_BODY);
    return;
  }
  try {
    usage.deleteUsage();
    sendClaudeJson(res, 200, DELETED_BODY);
  } catch (err: unknown) {
    logger.error({ route: CLAUDE_USAGE_DELETE_PATH, err }, "usage delete failed");
    sendClaudeJson(res, 500, INTERNAL_ERROR_BODY);
  }
}

/** `POST /api/v1/claude/usage/session` `{ runId }` (PR-23). */
async function handleSessionUsage(
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
  const parsed = await readJsonBody(req, SessionActionRequestSchema, SMALL_BODY_LIMIT_BYTES);
  if (!parsed.ok) {
    logger.warn(
      { route: CLAUDE_SESSION_USAGE_PATH, reason: parsed.reason },
      "rejected request body",
    );
    sendClaudeJson(res, 400, INVALID_BODY_BODY);
    return;
  }
  try {
    const sessionUsage = usage.sessionUsage(parsed.value.runId as RunId);
    if (sessionUsage === null) sendClaudeJson(res, 404, RUN_NOT_FOUND_BODY);
    else sendClaudeJson(res, 200, sessionUsage);
  } catch (err: unknown) {
    logger.error({ route: CLAUDE_SESSION_USAGE_PATH, err }, "session usage failed");
    sendClaudeJson(res, 500, INTERNAL_ERROR_BODY);
  }
}

export const usageRoutes: Record<string, Record<string, ClaudeHandler>> = {
  [CLAUDE_STATUSLINE_PATH]: { POST: withClaudeAuth(detached(handleStatusLine)) },
  [CLAUDE_INTEGRATION_PATH]: { GET: withClaudeAuth(detached(handleIntegration)) },
  [CLAUDE_TRANSCRIPT_ANALYSIS_PATH]: {
    POST: withClaudeAuth(detached(handleTranscriptAnalysis)),
  },
  [CLAUDE_USAGE_DELETE_PATH]: { POST: withClaudeAuth(detached(handleUsageDelete)) },
  [CLAUDE_SESSION_USAGE_PATH]: { POST: withClaudeAuth(detached(handleSessionUsage)) },
};
