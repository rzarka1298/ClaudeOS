import type { Handler } from "../route-kit.js";
import type { DoctorRouteDeps } from "./doctor-routes.js";
import type { FollowRouteDeps } from "./follow-routes.js";
import type { HeadroomService } from "./headroom-service.js";
import type { HookRouteDeps } from "./hook-routes.js";
import type { CodexIntegrationService } from "./integration-routes.js";
import type { SessionRouteDeps } from "./session-routes.js";
import type { TokenRouteDeps } from "./token-routes.js";

/**
 * The Codex route context member and the Codex route table (plan 05.1-28,
 * D-25, CODEX-12). SIGNATURE STUB in the RED commit.
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

export const codexRouteTable: Record<string, Record<string, Handler>> = {};
