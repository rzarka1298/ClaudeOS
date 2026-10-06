import type { IncomingMessage, ServerResponse } from "node:http";
import { type ApiErrorBody, CLAUDE_HOOK_EVENTS_PATH, HookRecordEnvelopeSchema } from "@ccc/domain";
import { logger } from "../logging.js";
import { type BodyParser, readJsonBody } from "../request-body.js";
import type { RouteContext } from "../routes.js";
import { type ClaudeHandler, sendClaudeJson, withClaudeAuth } from "./http.js";

/**
 * `POST /api/v1/claude/hook-events` (D-06): one minimized hook record per
 * request, behind the bearer token like every route but the handshake.
 *
 * Every refusal body is a module-level constant (T-02-19). Neither the
 * record, its event name, nor which field failed ever reaches a response:
 * the specifics go to the redacting log by field path only (D-12, D-49).
 */
const ACCEPTED_BODY = { accepted: true } as const;
const INVALID_BODY_BODY: ApiErrorBody = { error: "invalid request body" };
const UNAVAILABLE_BODY: ApiErrorBody = { error: "claude ingest unavailable" };
const INTERNAL_ERROR_BODY: ApiErrorBody = { error: "internal error" };

/**
 * Checks the permissive envelope but hands back the WHOLE parsed body: the
 * envelope schema strips every key it does not name, and the pipeline must
 * see the event's own fields to tell a known event from one whose shape
 * changed. {@link HOOK_EVENT_BODY_LIMIT_BYTES} bounds the read.
 */
/**
 * The hook caps a serialized record at 4 KiB (collectors `MAX_RECORD_BYTES`);
 * twice that leaves headroom for a future field without letting one request
 * buffer the 64 KiB general default (wave 3 review).
 */
export const HOOK_EVENT_BODY_LIMIT_BYTES = 8 * 1024;

const ENVELOPE_CHECKED_BODY: BodyParser<unknown> = {
  safeParse(input) {
    return HookRecordEnvelopeSchema.safeParse(input).success
      ? { success: true, data: input }
      : { success: false };
  },
};

async function handleHookEvents(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const claude = ctx.claude;
  if (claude === undefined) {
    req.resume();
    sendClaudeJson(res, 503, UNAVAILABLE_BODY);
    return;
  }
  const parsed = await readJsonBody(req, ENVELOPE_CHECKED_BODY, HOOK_EVENT_BODY_LIMIT_BYTES);
  if (!parsed.ok) {
    logger.warn({ route: CLAUDE_HOOK_EVENTS_PATH, reason: parsed.reason }, "rejected request body");
    sendClaudeJson(res, 400, INVALID_BODY_BODY);
    return;
  }
  try {
    const outcome = await claude.pipeline.ingest(parsed.value, "socket");
    switch (outcome) {
      // A shape-invalid record was received and classified (health now
      // reads "changed"); answering 400 would make the hook spool it and the
      // spool drain count it a second time (wave 3 review).
      case "applied":
      case "duplicate":
      case "unknown-event":
      case "shape-invalid":
        sendClaudeJson(res, 202, ACCEPTED_BODY);
        return;
      case "envelope-invalid":
        sendClaudeJson(res, 400, INVALID_BODY_BODY);
        return;
    }
  } catch (err: unknown) {
    logger.error({ route: CLAUDE_HOOK_EVENTS_PATH, err }, "hook event ingest failed");
    sendClaudeJson(res, 500, INTERNAL_ERROR_BODY);
  }
}

export const hookEventsHandler: ClaudeHandler = (req, res, ctx) => {
  // `ClaudeHandler` is synchronous by contract; every path inside resolves
  // to a written response, so the floating promise carries nothing to act on.
  void handleHookEvents(req, res, ctx);
};

export const ingestRoutes: Record<string, Record<string, ClaudeHandler>> = {
  [CLAUDE_HOOK_EVENTS_PATH]: { POST: withClaudeAuth(hookEventsHandler) },
};
