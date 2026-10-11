import { CODEX_HOOK_EVENTS_PATH } from "@ccc/domain";
import { HOOK_EVENT_BODY_LIMIT_BYTES } from "../claude/ingest-routes.js";
import { logger } from "../logging.js";
import { type BodyParser, readJsonBody } from "../request-body.js";
import { type Handler, INVALID_BODY_BODY, sendJson } from "../route-kit.js";
import type { CodexHookPipeline } from "./hook-pipeline.js";
import { type DepsGetter, withCodexDeps } from "./route-support.js";

/**
 * `POST /api/v1/codex/hook-events` (plan 05.1-32, D-19, CODEX-06): one minimized
 * hook record per request, behind the bearer token. POST is the only verb in the
 * table, so every other verb reaches the router's constant not-found.
 *
 * The body is read through the shared bounded reader at the same 8 KiB cap the
 * Claude route uses, and only checked to be a JSON object here: the strict
 * domain schema runs in the pipeline. A shape-invalid record answers 202 like
 * Phase 5, so the hook does not respawn it into the spool (where the drain would
 * count it a second time). Every body is a module-level constant: no field of
 * the record, no event name and no failing path ever reaches a response, and the
 * logs hold reason codes only (T-05.1-07).
 */
export type HookRouteDeps = Pick<CodexHookPipeline, "ingest">;

const ACCEPTED_BODY = { accepted: true } as const;

const OBJECT_BODY: BodyParser<unknown> = {
  safeParse(input) {
    return typeof input === "object" && input !== null && !Array.isArray(input)
      ? { success: true, data: input }
      : { success: false };
  },
};

export function hookRoutes(
  getDeps: DepsGetter<HookRouteDeps>,
): Record<string, Record<string, Handler>> {
  const post = withCodexDeps(getDeps, async (req, res, _ctx, deps) => {
    const parsed = await readJsonBody(req, OBJECT_BODY, HOOK_EVENT_BODY_LIMIT_BYTES);
    if (!parsed.ok) {
      logger.warn(
        { route: CODEX_HOOK_EVENTS_PATH, reason: parsed.reason },
        "rejected request body",
      );
      sendJson(res, 400, INVALID_BODY_BODY);
      return;
    }
    const outcome = await deps.ingest(parsed.value, "socket");
    if (outcome === "envelope-invalid") {
      sendJson(res, 400, INVALID_BODY_BODY);
      return;
    }
    sendJson(res, 202, ACCEPTED_BODY);
  });
  return { [CODEX_HOOK_EVENTS_PATH]: { POST: post } };
}
