import type { IntegrationInstallState, UsageSummary } from "@ccc/domain";
import type Database from "better-sqlite3";
import type { Logger } from "pino";
import type { EventBus } from "../events/event-bus.js";
import type { ClaudePipeline } from "./pipeline.js";
import type { SpoolPoller } from "./spool-poller.js";
import { buildUsageSummary, EMPTY_STATUS_LINE_OBSERVATION } from "./usage-summary.js";

/** RED scaffold (05-12 Task 1): the real composition lands in the GREEN commit. */
export interface UsageServicesDeps {
  readonly db: Database.Database;
  readonly bus: Pick<EventBus, "publish">;
  readonly pipeline: Pick<ClaudePipeline, "onRunSettled" | "health">;
  readonly poller: Pick<SpoolPoller, "setStatusLineSink" | "dropCount">;
  readonly logger: Logger;
  readonly env: NodeJS.ProcessEnv;
  readonly now: () => Date;
  readonly settingsFacts?: () => {
    readonly statusLine: IntegrationInstallState;
    readonly cleanupPeriodDays: number;
  };
}

export type StatusLineOutcome = "applied" | "invalid";

export interface UsageServices {
  summary(): UsageSummary;
  handleStatusLine(input: unknown): StatusLineOutcome;
  start(): void;
  stop(): Promise<void>;
}

export function startUsageServices(deps: UsageServicesDeps): UsageServices {
  return {
    summary: () =>
      buildUsageSummary({
        db: deps.db,
        statusLineInstall: "unknown",
        observation: EMPTY_STATUS_LINE_OBSERVATION,
        now: deps.now(),
      }),
    handleStatusLine: () => "invalid",
    start() {},
    async stop() {},
  };
}
