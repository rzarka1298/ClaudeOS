import type { ClaudeHandler } from "./http.js";
import { ingestRoutes } from "./ingest-routes.js";
import type { ClaudePipeline } from "./pipeline.js";
import { type SessionActionDeps, sessionActionRoutes } from "./session-action-routes.js";
import { usageRoutes } from "./usage-routes.js";
import type { UsageServices } from "./usage-services.js";

/**
 * What the Claude routes need from the composition root. `routes.ts`
 * carries it as one optional `RouteContext.claude` member, so an older
 * composition without it still builds (the routes answer 503). 05-12 and
 * 05-14 add optional members here.
 */
export interface ClaudeRouteDeps {
  readonly pipeline: ClaudePipeline;
  /** The usage and integration-status composition (05-12); the usage routes answer 503 without it. */
  readonly usage?: UsageServices | undefined;
  /** The session-action ports (05-14); the action routes answer 503 without them. */
  readonly actions?: SessionActionDeps | undefined;
}

/** Every Phase 5 route. `routes.ts` spreads this last into its own table. */
export const claudeRouteTable: Record<string, Record<string, ClaudeHandler>> = {
  ...ingestRoutes,
  ...usageRoutes,
  ...sessionActionRoutes,
};
