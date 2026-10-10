import { CODEX_TOKEN_ACTIVITY_PATH, CodexTokenSummarySchema } from "@ccc/domain";
import { logger } from "../logging.js";
import { type Handler, INTERNAL_ERROR_BODY, sendJson } from "../route-kit.js";
import { type DepsGetter, withCodexDeps } from "./route-support.js";
import type { TokenScanner } from "./token-scanner.js";

/**
 * The Codex token-activity route (plan 05.1-23, D-24, CODEX-10). GET only: the
 * table holds no other verb, so every other method reaches the router's
 * constant not-found. There is no body, query or action.
 *
 * The cached three-range summary is computed from the counter tables, so the
 * request itself reads no rollout. A read-through (`refreshIfStale`, fire and
 * forget, deduplicated and interval-gated inside the scanner) is asked for only
 * while analysis is on: with analysis off every range says so and the scanner
 * is not touched at all. The answer is validated against the strict domain
 * schema before it is sent, so no extra member can leave the service; a
 * failure is logged by reason code only.
 */
export type TokenRouteDeps = Pick<TokenScanner, "summary" | "refreshIfStale">;

export function tokenRoutes(
  getDeps: DepsGetter<TokenRouteDeps>,
): Record<string, Record<string, Handler>> {
  const tokenActivity = withCodexDeps(getDeps, (_req, res, _ctx, deps) => {
    const value = deps.summary();
    const parsed = CodexTokenSummarySchema.safeParse(value);
    if (!parsed.success) {
      logger.error(
        { route: CODEX_TOKEN_ACTIVITY_PATH, reason: "invalid-output" },
        "codex token activity not sent",
      );
      sendJson(res, 500, INTERNAL_ERROR_BODY);
      return;
    }
    const ranges = Object.values(parsed.data.ranges);
    const analysisOff = ranges.every(
      (range) => range.kind === "unavailable" && range.reason === "analysis-off",
    );
    if (!analysisOff) deps.refreshIfStale();
    sendJson(res, 200, parsed.data);
  });
  return { [CODEX_TOKEN_ACTIVITY_PATH]: { GET: tokenActivity } };
}
