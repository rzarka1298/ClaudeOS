import {
  type ApprovalLog,
  type Clock,
  type MirrorPort,
  type ProposalId,
  ProposalIdSchema,
} from "@ccc/domain";
import { createApprovalStore } from "@ccc/operational-store";
import type Database from "better-sqlite3";
import {
  type ApprovalEngine,
  buildOperationRegistry,
  createApprovalEngine,
  createExpirySweeper,
  type RecoverySummary,
} from "../approval/index.js";
import type { EventBus } from "../events/event-bus.js";
import { createApprovalMirror } from "./mirror.js";
import { createApprovalPublisher } from "./publisher.js";
import type { ApprovalServices } from "./types.js";

/**
 * The approval composition (plan 06-21, APPR-01, D-03, D-04, D-28): builds the
 * store, the operation registry (failing closed), the publisher, the mirror,
 * the engine and the expiry sweeper, and hands the routes the narrow
 * {@link ApprovalServices} surface.
 *
 * The operation definitions arrive as DATA from `main.ts`, the only file that
 * may import the executors folder; this module imports the approval public
 * entry only. The services given to the routes carry list, get, decide and the
 * zero-effect test, and nothing that can reach an executor or a terminator.
 * The engine itself is returned separately and only as its `submit` member,
 * for the requester adapters (the force-terminate proposer).
 */

/** The operation definitions, typed as the registry builder takes them. */
export type OperationDefinitions = Parameters<typeof buildOperationRegistry>[0];

export interface ApprovalRuntimeDeps {
  /** The migrated operational database. */
  readonly db: Database.Database;
  readonly definitions: OperationDefinitions;
  readonly clock: Clock;
  readonly eventBus: Pick<EventBus, "publish">;
  /** The managed vault root, or null before vault setup has run. */
  readonly getVaultRoot: () => string | null;
  readonly log: ApprovalLog;
  readonly env: NodeJS.ProcessEnv;
  /** The display name of a registered project, or null. Display only. */
  readonly projectName?: (projectId: string) => string | null;
  /** Replaces the vault mirror (tests only). */
  readonly mirror?: MirrorPort;
}

export interface ApprovalRuntime {
  /** The route-facing services: list, get, decide, test, ready. Nothing else. */
  readonly services: ApprovalServices;
  /** Only `submit`, for requester adapters. */
  readonly engine: Pick<ApprovalEngine, "submit">;
  /** Startup recovery; the services report ready once it has completed (D-17). */
  recover(): Promise<RecoverySummary>;
  /** Starts the periodic expiry sweep. */
  start(): void;
  /** Resolves when every execution the engine started has finished. */
  settled(): Promise<void>;
  /** Stops the sweeper, then waits for in-flight executions (shutdown, D-09). */
  stop(): Promise<void>;
}

/** The test route's request: it targets nothing, so its one subject is constant. */
const TEST_OPERATION = "diagnostic.test";
const TEST_SUBJECT = "diagnostic";
const TEST_REQUESTER = { kind: "dashboard", label: "Settings" } as const;
const TEST_REASON = "A test request raised from the settings page. It changes nothing.";

export function startApprovalServices(deps: ApprovalRuntimeDeps): ApprovalRuntime {
  const { db, clock, log } = deps;
  // Fails closed: any mismatch between the definitions and the enabled
  // classification rows throws here, before the service accepts a connection.
  const registry = buildOperationRegistry(deps.definitions);
  const store = createApprovalStore(db);
  const publisher = createApprovalPublisher(deps.eventBus, log);
  const mirror = deps.mirror ?? createApprovalMirror({ getVaultRoot: deps.getVaultRoot, log });
  const projectName = deps.projectName;
  const engine = createApprovalEngine({
    store,
    registry,
    clock,
    publisher,
    mirror,
    log,
    ...(projectName === undefined ? {} : { projectName }),
  });
  const sweeper = createExpirySweeper({ engine, log });

  let ready = false;

  const services: ApprovalServices = {
    get ready() {
      return ready;
    },
    snapshot: (budgetBytes) => engine.snapshot(budgetBytes),
    get(proposalId) {
      const detail = engine.get(proposalId);
      if (detail.kind === "not-found") return { kind: "not-found" };
      const parsed = ProposalIdSchema.safeParse(proposalId);
      const stored = parsed.success ? store.get(parsed.data as ProposalId) : null;
      if (stored === null) return { kind: "not-found" };
      return {
        kind: "found",
        summary: detail.summary,
        view: detail.view,
        purged: detail.purged,
        payloadHash: stored.payloadHash,
      };
    },
    decide: (input) => engine.decide(input),
    test(request) {
      const outcome = engine.submit({
        operation: TEST_OPERATION,
        subject: TEST_SUBJECT,
        requester: TEST_REQUESTER,
        projectId: null,
        runId: null,
        reason: TEST_REASON,
        payload: {},
        ...(request.ttlMs === undefined ? {} : { requestedTtlMs: request.ttlMs }),
      });
      if (outcome.kind === "rejected") return { kind: "rejected", reason: outcome.reason };
      return {
        outcome: outcome.deduped ? "already-pending" : "proposed",
        proposalId: outcome.proposalId,
      };
    },
  };

  return {
    services,
    engine: { submit: (input) => engine.submit(input) },
    async recover() {
      const summary = await engine.recover();
      ready = true;
      return summary;
    },
    start: () => sweeper.start(),
    settled: () => engine.settled(),
    async stop() {
      await sweeper.stop();
      await engine.settled();
    },
  };
}

/** The service logger as the engine's narrow log port (the same adapter shape the publisher uses). */
export function createServiceApprovalLog(logger: {
  info(fields: object, message?: string): void;
  warn(fields: object, message?: string): void;
  error(fields: object, message?: string): void;
}): ApprovalLog {
  return {
    info: (fields, message) => logger.info(fields, message),
    warn: (fields, message) => logger.warn(fields, message),
    error: (fields, message) => logger.error(fields, message),
  };
}
