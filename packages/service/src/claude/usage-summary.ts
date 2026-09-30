import type { IntegrationInstallState, PlanCapacity, UsageSummary } from "@ccc/domain";
import type Database from "better-sqlite3";

/** RED scaffold (05-12 Task 1): the real builder lands in the GREEN commit. */
export interface StatusLineObservation {
  readonly lastValidAt: string | null;
  readonly lastHadLimits: boolean;
  readonly lastInvalidAt: string | null;
  readonly lastInvalidVersion: string | null;
}

export const EMPTY_STATUS_LINE_OBSERVATION: StatusLineObservation = Object.freeze({
  lastValidAt: null,
  lastHadLimits: false,
  lastInvalidAt: null,
  lastInvalidVersion: null,
});

export interface PlanCapacityInputs {
  readonly db: Database.Database;
  readonly statusLineInstall: IntegrationInstallState;
  readonly observation: StatusLineObservation;
  readonly now: Date;
}

export function buildPlanCapacity(_inputs: PlanCapacityInputs): PlanCapacity {
  return { kind: "unavailable", reason: "shape-changed", version: null };
}

export function buildUsageSummary(inputs: PlanCapacityInputs): UsageSummary {
  const unavailable = {
    activity: { kind: "unavailable", reason: "analysis-off", version: null },
    cost: { kind: "unavailable", reason: "needs-activity-or-wrapper" },
  } as const;
  return {
    capacity: buildPlanCapacity(inputs),
    ranges: { today: unavailable, "last-7-days": unavailable, "this-month": unavailable },
    analysis: { enabled: false, firstScanPending: false },
    observedAt: inputs.now.toISOString(),
  };
}
