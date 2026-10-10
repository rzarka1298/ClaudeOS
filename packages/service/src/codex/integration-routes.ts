import {
  CODEX_INTEGRATION_PATH,
  type CodexBridgeStatus,
  type CodexDoctorSummary,
  type CodexHookStatus,
  type CodexInstall,
  type CodexIntegrationStatus,
  CodexIntegrationStatusSchema,
} from "@ccc/domain";
import { logger } from "../logging.js";
import { type Handler, INTERNAL_ERROR_BODY, sendJson } from "../route-kit.js";
import { type DepsGetter, withCodexDeps } from "./route-support.js";

/**
 * The composed Codex integration status and its one GET route (plan 05.1-28,
 * D-12, D-19, D-30; the Settings group and the card setup state poll it).
 *
 * The status is assembled from four small readers: the bridge status view, the
 * hook status, the cached install result and the last doctor summary. It
 * spawns nothing, reads no Codex file and carries no path: the domain schema is
 * strict, so only enums, timestamps, booleans and a dotted version can leave.
 * GET is the only verb in the table; every other method reaches the router's
 * constant not-found. A failure is logged by reason code only.
 */

/** The four readers the status is assembled from (all synchronous, none spawns or reads a Codex file). */
export interface IntegrationStatusReaders {
  readonly bridge: () => CodexBridgeStatus;
  readonly hooks: () => CodexHookStatus;
  readonly install: () => CodexInstall;
  readonly doctor: () => CodexDoctorSummary | null;
}

/** Pure over the readers; the strict domain schema is the last gate before the value is used. */
export function buildCodexIntegrationStatus(
  readers: IntegrationStatusReaders,
): CodexIntegrationStatus {
  return CodexIntegrationStatusSchema.parse({
    hooks: readers.hooks(),
    bridge: readers.bridge(),
    codex: readers.install(),
    doctor: readers.doctor(),
  });
}

/** What the route and the snapshot builder see of the integration status. */
export interface CodexIntegrationService {
  /** The cached status, read synchronously (the snapshot reads it in the same tick). */
  status(): CodexIntegrationStatus;
  /** Re-reads the four parts, publishes once when the status changed, and returns it. */
  refresh(): CodexIntegrationStatus;
  /**
   * Starts the one-time install detection when none has run in this service run (the first
   * dashboard snapshot calls it); fire-and-forget, never awaited, a no-op afterwards.
   */
  detectOnce?(): void;
}

export function integrationRoutes(
  getDeps: DepsGetter<CodexIntegrationService>,
): Record<string, Record<string, Handler>> {
  const integration = withCodexDeps(getDeps, (_req, res, _ctx, deps) => {
    let status: CodexIntegrationStatus;
    try {
      status = deps.refresh();
    } catch (error: unknown) {
      logger.error(
        {
          route: CODEX_INTEGRATION_PATH,
          reason: "refresh-failed",
          errorName: error instanceof Error ? error.name : "non-error",
        },
        "codex integration not sent",
      );
      sendJson(res, 500, INTERNAL_ERROR_BODY);
      return;
    }
    const parsed = CodexIntegrationStatusSchema.safeParse(status);
    if (!parsed.success) {
      logger.error(
        { route: CODEX_INTEGRATION_PATH, reason: "invalid-output" },
        "codex integration not sent",
      );
      sendJson(res, 500, INTERNAL_ERROR_BODY);
      return;
    }
    sendJson(res, 200, parsed.data);
  });
  return { [CODEX_INTEGRATION_PATH]: { GET: integration } };
}
