import type {
  CodexBridgeStatus,
  CodexDoctorSummary,
  CodexHookStatus,
  CodexInstall,
  CodexIntegrationStatus,
} from "@ccc/domain";
import type { Handler } from "../route-kit.js";
import type { DepsGetter } from "./route-support.js";

/**
 * The composed Codex integration status and its one GET route (plan 05.1-28,
 * D-12, D-19, D-30). SIGNATURE STUB in the RED commit.
 */

/** The four readers the status is assembled from (all synchronous, none spawns or reads a Codex file). */
export interface IntegrationStatusReaders {
  readonly bridge: () => CodexBridgeStatus;
  readonly hooks: () => CodexHookStatus;
  readonly install: () => CodexInstall;
  readonly doctor: () => CodexDoctorSummary | null;
}

export function buildCodexIntegrationStatus(
  _readers: IntegrationStatusReaders,
): CodexIntegrationStatus {
  throw new Error("not implemented");
}

/** What the route and the snapshot builder see of the integration status. */
export interface CodexIntegrationService {
  /** The cached status, read synchronously (the snapshot reads it in the same tick). */
  status(): CodexIntegrationStatus;
  /** Re-reads the four parts, publishes once when the status changed, and returns it. */
  refresh(): CodexIntegrationStatus;
}

export function integrationRoutes(
  _getDeps: DepsGetter<CodexIntegrationService>,
): Record<string, Record<string, Handler>> {
  return {};
}
