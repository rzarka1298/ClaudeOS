import type { Handler } from "../route-kit.js";
import type { HeadroomService } from "./headroom-service.js";
import type { DepsGetter } from "./route-support.js";

/** Signature stub (RED). */
export type HeadroomRouteDeps = Pick<HeadroomService, "getUsage" | "getHeadroom">;

export function headroomRoutes(
  _getDeps: DepsGetter<HeadroomRouteDeps>,
): Record<string, Record<string, Handler>> {
  return {};
}
