// The shared wiring the approval tests build an engine from (06-08).
// Folder-private: never exported from the approval public entry. Everything
// here is a double (memory store, fixed clock, scriptable operations, a
// recording publisher, mirror and log), so a test can assert what the engine
// did AND what it did not do. Imports `@ccc/domain` and the folder's own files.
import {
  type ApprovalLog,
  type ApprovalUpsertedPayload,
  CLASSIFICATION,
  type NoteId,
  type ProposalId,
  type Requester,
  type StoredProposal,
} from "@ccc/domain";
import {
  type ApprovalEngine,
  type ApprovalEngineDeps,
  createApprovalEngine,
  type OperationRegistry,
  type SubmitInput,
  type SubmitOutcome,
} from "../engine.js";
import { createTestClock, type TestClock } from "./clock.js";
import { createFakeOperation, type FakeOperation, type FakePayload } from "./fake-operation.js";
import { createMemoryApprovalStore, type MemoryApprovalStore } from "./memory-store.js";

export type LogLevel = "info" | "warn" | "error";

export interface LoggedLine {
  readonly level: LogLevel;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly message: string | undefined;
}

export interface RecordingLog extends ApprovalLog {
  readonly lines: LoggedLine[];
}

export function createRecordingLog(): RecordingLog {
  const lines: LoggedLine[] = [];
  const push = (level: LogLevel) => (fields: Readonly<Record<string, unknown>>, message?: string) =>
    void lines.push({ level, fields, message });
  return { lines, info: push("info"), warn: push("warn"), error: push("error") };
}

/** A registry without the startup checks, for tests that are not about the registry. */
export function createLooseRegistry(fakes: readonly FakeOperation[]): OperationRegistry {
  const byName = new Map(fakes.map((fake) => [fake.operation as string, fake.definition]));
  return {
    table: CLASSIFICATION,
    lookup: (operation) => byName.get(operation),
    operations: () => [...byName.keys()],
  };
}

export const REQUESTER: Requester = { kind: "dashboard", label: "Test dashboard" };

export interface Harness {
  readonly engine: ApprovalEngine;
  readonly store: MemoryApprovalStore;
  readonly clock: TestClock;
  readonly diagnostic: FakeOperation;
  readonly terminate: FakeOperation;
  readonly published: ApprovalUpsertedPayload[];
  readonly mirrored: StoredProposal[];
  readonly log: RecordingLog;
  /** Submits the diagnostic operation with defaults; `overrides` change what a test is about. */
  submit(overrides?: Partial<SubmitInput>): SubmitOutcome;
  /** Submits and returns the proposal id, failing the test if the submit was not accepted. */
  propose(overrides?: Partial<SubmitInput>): ProposalId;
}

export interface HarnessOptions {
  readonly registry?: (fakes: readonly FakeOperation[]) => OperationRegistry;
  readonly publisherThrows?: boolean;
  readonly mirrorRejects?: boolean;
  readonly projectName?: ApprovalEngineDeps["projectName"];
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const store = createMemoryApprovalStore();
  const clock = createTestClock();
  const diagnostic = createFakeOperation("diagnostic.test");
  const terminate = createFakeOperation("session.force-terminate");
  const published: ApprovalUpsertedPayload[] = [];
  const mirrored: StoredProposal[] = [];
  const log = createRecordingLog();
  let counter = 0;
  const pad = (n: number): string => n.toString(36).padStart(24, "0");
  const registry = (options.registry ?? createLooseRegistry)([diagnostic, terminate]);

  const deps: ApprovalEngineDeps = {
    store,
    registry,
    clock,
    log,
    ids: {
      proposalId: () => {
        counter += 1;
        return `p${pad(counter)}` as ProposalId;
      },
      noteId: () => {
        counter += 1;
        return `n${pad(counter)}` as NoteId;
      },
    },
    publisher: {
      publish(_event, payload) {
        if (options.publisherThrows === true) throw new Error("publisher down");
        published.push(payload);
      },
    },
    mirror: {
      async mirror(proposal) {
        if (options.mirrorRejects === true) throw new Error("mirror down");
        mirrored.push(proposal);
      },
    },
    ...(options.projectName === undefined ? {} : { projectName: options.projectName }),
  };
  const engine = createApprovalEngine(deps);

  const defaults: SubmitInput = {
    operation: "diagnostic.test",
    subject: "diagnostic",
    requester: REQUESTER,
    projectId: null,
    runId: null,
    reason: "Testing the approval path.",
    payload: {} satisfies FakePayload,
  };

  const harness: Harness = {
    engine,
    store,
    clock,
    diagnostic,
    terminate,
    published,
    mirrored,
    log,
    submit: (overrides = {}) => engine.submit({ ...defaults, ...overrides }),
    propose: (overrides = {}) => {
      const outcome = harness.submit(overrides);
      if (outcome.kind !== "proposed") {
        throw new Error(`submit was not accepted: ${JSON.stringify(outcome)}`);
      }
      return outcome.proposalId;
    },
  };
  return harness;
}

/** Lets every already-queued microtask and immediate run, so an un-awaited effect gets its chance. */
export async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
