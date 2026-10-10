import {
  CODEX_OPEN_TRANSCRIPT_PATH,
  CODEX_SESSIONS_PATH,
  type CodexActionErrorBody,
  type CodexActionErrorCode,
  CodexOpenTranscriptRequestSchema,
  CodexSessionsSnapshotSchema,
} from "@ccc/domain";
import { logger } from "../logging.js";
import { readJsonBody } from "../request-body.js";
import { type Handler, INTERNAL_ERROR_BODY, sendJson } from "../route-kit.js";
import { CODEX_UNAVAILABLE_BODY, type DepsGetter, withCodexDeps } from "./route-support.js";
import type { CodexSessionMirror } from "./session-mirror.js";
import type { TranscriptOpener } from "./transcript-open.js";

/**
 * The two Codex session routes (plan 05.1-22, CODEX-05, CODEX-07, D-15, D-29).
 *
 * - `GET /api/v1/codex/sessions`: the cached snapshot (a read-through
 *   `refreshIfStale` starts at most one background poll, or one awaited poll
 *   when nothing is cached yet), validated against the domain schema before it
 *   is sent. The schema is strict, so a stray `cwd` or path member can never be
 *   serialised even if a bug put one on a view.
 * - `POST /api/v1/codex/open-transcript` `{ threadId, via }`: the strict body
 *   only; the thread resolves to a path inside the service, never from the
 *   request. Answers the constant `{ ok: true }` or `{ error: <one fixed code> }`.
 *
 * No other verb is in the table, so every other method reaches the router's
 * constant not-found. Logging is by reason code only.
 */
export interface SessionRouteDeps {
  readonly mirror: Pick<CodexSessionMirror, "snapshot" | "refreshIfStale" | "pollNow">;
  readonly opener: Pick<TranscriptOpener, "open">;
}

/** A transcript open body is two short members. */
const OPEN_BODY_LIMIT_BYTES = 4096;

const OK_BODY = { ok: true } as const;
const INVALID_REQUEST_BODY: CodexActionErrorBody = { error: "invalid-request" };

const STATUS_BY_CODE: Readonly<Record<CodexActionErrorCode, number>> = {
  "invalid-request": 400,
  "not-found": 404,
  "outside-sessions-folder": 403,
  "run-ended": 409,
  "bridge-not-installed": 409,
  "bridge-outdated": 409,
  "window-not-ready": 409,
  unavailable: 503,
  failed: 500,
};

export function sessionRoutes(
  getDeps: DepsGetter<SessionRouteDeps>,
): Record<string, Record<string, Handler>> {
  const sessions = withCodexDeps(getDeps, async (_req, res, _ctx, deps) => {
    let value = deps.mirror.snapshot();
    if (value === null) {
      await deps.mirror.pollNow();
      value = deps.mirror.snapshot();
    } else {
      deps.mirror.refreshIfStale();
    }
    if (value === null) {
      sendJson(res, 503, CODEX_UNAVAILABLE_BODY);
      return;
    }
    const parsed = CodexSessionsSnapshotSchema.safeParse(value);
    if (!parsed.success) {
      logger.error(
        { route: CODEX_SESSIONS_PATH, reason: "invalid-output" },
        "codex sessions not sent",
      );
      sendJson(res, 500, INTERNAL_ERROR_BODY);
      return;
    }
    sendJson(res, 200, parsed.data);
  });

  const openTranscript = withCodexDeps(getDeps, async (req, res, _ctx, deps) => {
    const body = await readJsonBody(req, CodexOpenTranscriptRequestSchema, OPEN_BODY_LIMIT_BYTES);
    if (!body.ok) {
      logger.warn(
        { route: CODEX_OPEN_TRANSCRIPT_PATH, reason: body.reason },
        "rejected request body",
      );
      sendJson(res, 400, INVALID_REQUEST_BODY);
      return;
    }
    // A client that goes away cancels a still-running `open`.
    const controller = new AbortController();
    res.once("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    const outcome = await deps.opener.open({
      threadId: body.value.threadId,
      via: body.value.via,
      signal: controller.signal,
    });
    if (outcome.ok) {
      sendJson(res, 200, OK_BODY);
      return;
    }
    logger.warn(
      { route: CODEX_OPEN_TRANSCRIPT_PATH, reason: outcome.error },
      "transcript open refused",
    );
    sendJson(res, STATUS_BY_CODE[outcome.error], { error: outcome.error });
  });

  return {
    [CODEX_SESSIONS_PATH]: { GET: sessions },
    [CODEX_OPEN_TRANSCRIPT_PATH]: { POST: openTranscript },
  };
}
