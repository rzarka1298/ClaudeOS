import type { ApprovalLog, ApprovalsSnapshot, Clock, MirrorPort } from "@ccc/domain";
import type Database from "better-sqlite3";
import type { ApprovalEngine, buildOperationRegistry, RecoverySummary } from "../approval/index.js";
import type { EventBus } from "../events/event-bus.js";
import type { ApprovalServices } from "./types.js";

/** Skeleton (RED): the real composition follows in the GREEN commit. */
export type OperationDefinitions = Parameters<typeof buildOperationRegistry>[0];

export interface ApprovalRuntimeDeps {
  readonly db: Database.Database;
  readonly definitions: OperationDefinitions;
  readonly clock: Clock;
  readonly eventBus: Pick<EventBus, "publish">;
  readonly getVaultRoot: () => string | null;
  readonly log: ApprovalLog;
  readonly env: NodeJS.ProcessEnv;
  readonly projectName?: (projectId: string) => string | null;
  readonly mirror?: MirrorPort;
}

export interface ApprovalRuntime {
  readonly services: ApprovalServices;
  readonly engine: Pick<ApprovalEngine, "submit">;
  recover(): Promise<RecoverySummary>;
  start(): void;
  settled(): Promise<void>;
  stop(): Promise<void>;
}

const EMPTY_SNAPSHOT: ApprovalsSnapshot = {
  ready: false,
  pending: [],
  decided: [],
  expired: [],
  counts: { pending: 0, decided: 0, expired: 0 },
  truncated: false,
};

export function startApprovalServices(_deps: ApprovalRuntimeDeps): ApprovalRuntime {
  return {
    services: {
      ready: false,
      snapshot: () => EMPTY_SNAPSHOT,
      get: () => ({ kind: "not-found" }),
      decide: async () => ({ outcome: "not-found" }),
      test: () => ({ kind: "rejected", reason: "operation-unknown" }),
    },
    engine: { submit: () => ({ kind: "rejected", reason: "operation-unknown" }) },
    recover: async () => {
      throw new Error("not implemented");
    },
    start: () => {},
    settled: async () => {},
    stop: async () => {},
  };
}
