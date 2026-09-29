import type { ClaudeHandler } from "./http.js";
import { ingestRoutes } from "./ingest-routes.js";
import type { ClaudePipeline } from "./pipeline.js";

/**
 * What the Claude routes need from the composition root. `routes.ts`
 * carries it as one optional `RouteContext.claude` member, so an older
 * composition without it still builds (the routes answer 503). 05-12 and
 * 05-14 add optional members here.
 */
export interface ClaudeRouteDeps {
  readonly pipeline: ClaudePipeline;
}

/** Every Phase 5 route. `routes.ts` spreads this last into its own table. */
export const claudeRouteTable: Record<string, Record<string, ClaudeHandler>> = {
  ...ingestRoutes,
};
