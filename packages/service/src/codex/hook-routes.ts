import type { Handler } from "../route-kit.js";
import type { CodexHookPipeline } from "./hook-pipeline.js";
import type { DepsGetter } from "./route-support.js";

/** Signature stub (RED): the implementation lands in the green commit. */
export type HookRouteDeps = Pick<CodexHookPipeline, "ingest">;

export function hookRoutes(
  _getDeps: DepsGetter<HookRouteDeps>,
): Record<string, Record<string, Handler>> {
  return {};
}
