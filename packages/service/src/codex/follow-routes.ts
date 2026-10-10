import type { Handler } from "../route-kit.js";
import type { FollowLogService } from "./follow-log.js";
import type { DepsGetter } from "./route-support.js";

/** The follow-log route (plan 05.1-26). SIGNATURE STUB for the red commit. */
export interface FollowRouteDeps {
  readonly follow: Pick<FollowLogService, "follow">;
}

export function followRoutes(
  _getDeps: DepsGetter<FollowRouteDeps>,
): Record<string, Record<string, Handler>> {
  return {};
}
