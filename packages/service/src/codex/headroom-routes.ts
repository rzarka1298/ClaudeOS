import {
  CODEX_HEADROOM_PATH,
  CODEX_USAGE_PATH,
  CodexUsageSnapshotSchema,
  HeadroomSignalSchema,
} from "@ccc/domain";
import { logger } from "../logging.js";
import { type Handler, INTERNAL_ERROR_BODY, sendJson } from "../route-kit.js";
import type { HeadroomService } from "./headroom-service.js";
import { type DepsGetter, withCodexDeps } from "./route-support.js";

/**
 * The two read-only Codex usage routes (plan 05.1-15, D-04, CODEX-08, CODEX-11,
 * CODEX-12). GET only: the table below holds no other verb, so a POST, PUT,
 * PATCH or DELETE reaches the router's constant not-found. There is no request
 * body, no query handling and no action here; the headroom is a statement about
 * capacity that nothing in the service acts on.
 *
 * Every answer is validated against its domain schema before it is sent, and a
 * failure is logged by reason code only.
 */
export type HeadroomRouteDeps = Pick<HeadroomService, "getUsage" | "getHeadroom">;

export function headroomRoutes(
  getDeps: DepsGetter<HeadroomRouteDeps>,
): Record<string, Record<string, Handler>> {
  const usage = withCodexDeps(getDeps, async (_req, res, _ctx, deps) => {
    const parsed = CodexUsageSnapshotSchema.safeParse(await deps.getUsage());
    if (!parsed.success) {
      logger.error({ route: CODEX_USAGE_PATH, reason: "invalid-output" }, "codex usage not sent");
      sendJson(res, 500, INTERNAL_ERROR_BODY);
      return;
    }
    sendJson(res, 200, parsed.data);
  });
  const headroom = withCodexDeps(getDeps, async (_req, res, _ctx, deps) => {
    const parsed = HeadroomSignalSchema.safeParse(await deps.getHeadroom());
    if (!parsed.success) {
      logger.error(
        { route: CODEX_HEADROOM_PATH, reason: "invalid-output" },
        "codex headroom not sent",
      );
      sendJson(res, 500, INTERNAL_ERROR_BODY);
      return;
    }
    sendJson(res, 200, parsed.data);
  });
  return {
    [CODEX_USAGE_PATH]: { GET: usage },
    [CODEX_HEADROOM_PATH]: { GET: headroom },
  };
}
