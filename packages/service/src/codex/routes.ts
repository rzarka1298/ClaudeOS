import type { Handler } from "../route-kit.js";
import { type DoctorRouteDeps, doctorRoutes } from "./doctor-routes.js";
import { type FollowRouteDeps, followRoutes } from "./follow-routes.js";
import { headroomRoutes } from "./headroom-routes.js";
import type { HeadroomService } from "./headroom-service.js";
import { type HookRouteDeps, hookRoutes } from "./hook-routes.js";
import { type CodexIntegrationService, integrationRoutes } from "./integration-routes.js";
import { type SessionRouteDeps, sessionRoutes } from "./session-routes.js";
import { type TokenRouteDeps, tokenRoutes } from "./token-routes.js";

/**
 * The Codex route context member and the Codex route table (plan 05.1-28,
 * D-25, CODEX-12).
 *
 * The table is the whole Codex surface of the service: nine paths, each with its
 * documented verb only. Each route file reads its services through a getter on
 * `ctx.codex`, so a context without the member (or without that one service)
 * answers the constant 503, and any other verb reaches the router's constant
 * not-found. Nothing here dispatches work, ranks agents, consumes credits or
 * writes Codex configuration.
 */
export interface CodexRouteDeps {
  readonly headroom?:
    | Pick<
        HeadroomService,
        "getUsage" | "getHeadroom" | "peekUsage" | "peekHeadroom" | "refreshIfStale"
      >
    | undefined;
  readonly sessions?: SessionRouteDeps | undefined;
  readonly tokens?: TokenRouteDeps | undefined;
  readonly doctor?: DoctorRouteDeps | undefined;
  readonly hooks?: HookRouteDeps | undefined;
  readonly follow?: FollowRouteDeps | undefined;
  readonly integration?: CodexIntegrationService | undefined;
}

export const codexRouteTable: Record<string, Record<string, Handler>> = {
  ...headroomRoutes((ctx) => ctx.codex?.headroom),
  ...sessionRoutes((ctx) => ctx.codex?.sessions),
  ...tokenRoutes((ctx) => ctx.codex?.tokens),
  ...integrationRoutes((ctx) => ctx.codex?.integration),
  ...doctorRoutes((ctx) => ctx.codex?.doctor),
  ...followRoutes((ctx) => ctx.codex?.follow),
  ...hookRoutes((ctx) => ctx.codex?.hooks),
};
