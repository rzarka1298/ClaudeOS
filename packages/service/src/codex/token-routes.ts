import type { Handler } from "../route-kit.js";
import type { DepsGetter } from "./route-support.js";
import type { TokenScanner } from "./token-scanner.js";

/** Signature stub (RED): the real route lands with the green commit. */
export type TokenRouteDeps = Pick<TokenScanner, "summary" | "refreshIfStale">;

export function tokenRoutes(
  _getDeps: DepsGetter<TokenRouteDeps>,
): Record<string, Record<string, Handler>> {
  return {};
}
