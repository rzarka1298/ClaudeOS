import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ApprovalAuditEvent,
  type ApprovalItemDraft,
  type ApprovalLog,
  type ApprovalStorePort,
  type ApprovalSummary,
  type CapabilityToken,
  CLASSIFICATION,
  type ClassificationRow,
  type ClassificationTable,
  type Clock,
  type EnabledOperation,
  type ExecuteContext,
  type ExecuteOutcome,
  type OperationDefinition,
  type ProposalId,
  type ReconcileVerdict,
  type StoredProposal,
} from "@ccc/domain";
import {
  type ApprovalStore,
  applyMigrations,
  createApprovalStore,
  type OperationalStore,
  openStore,
} from "@ccc/operational-store";
import {
  type ApprovalEngine,
  buildOperationRegistry,
  createApprovalEngine,
  type SubmitInput,
} from "@ccc/service/approval";

/**
 * Shared fixtures for the approval integration suites (plan 06-24): fake
 * operations that count executions and distinct effects apart, a fake clock,
 * fault injection over the store port and the operation, a restartable engine
 * over a real file-backed SQLite database, a log recorder with the logging
 * allow-list, and readers for the audit trail and effect ledger.
 *
 * Test support only. It builds no capability token: the engine mints them, and
 * a test that needs a forged one casts inside its own `*.test.ts` file.
 */

/** The operational store's database handle, named without importing the SQLite binding. */
export type Db = OperationalStore["db"];

/** A fixed, round, millisecond-precision ISO 8601 UTC instant the suites start at. */
export const FIXTURE_EPOCH = "2026-10-06T12:00:00.000Z";

// ---------------------------------------------------------------------------
// Clock

export interface FakeClock extends Clock {
  /** Moves time forward by `ms` milliseconds. */
  advance(ms: number): void;
  /** Sets the clock to an exact instant. */
  set(iso: string): void;
}

/** Time moves only when a test says so, so every expiry and age assertion is exact. */
export function createFakeClock(start: string = FIXTURE_EPOCH): FakeClock {
  let current = Date.parse(start);
  return {
    now: () => new Date(current).toISOString(),
    advance(ms) {
      current += ms;
    },
    set(iso) {
      current = Date.parse(iso);
    },
  };
}

/** A promise that never settles: the shape of a process that was killed at that point. */
export function neverSettles(): Promise<never> {
  return new Promise<never>(() => undefined);
}

export function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Counting operations

/** What the fixtures' operations accept. Every field is optional; unknown keys are refused. */
export interface CountingPayload {
  readonly note?: string;
  /** Requester-supplied diff lines (the largest-view fixtures use this). */
  readonly lines?: readonly string[];
  /** A requester-supplied target value. */
  readonly value?: string;
}

const PAYLOAD_KEYS: ReadonlySet<string> = new Set(["note", "lines", "value"]);

/** The operation definition's own payload-schema type, so no schema library is imported here. */
type PayloadSchema = OperationDefinition<EnabledOperation, CountingPayload>["payload"];

/**
 * A strict, hand-written schema with the one method the engine calls. The
 * fixtures package has no schema-library dependency (none is added by this
 * plan), so the structural object is cast to the definition's own type.
 */
const countingPayloadSchema = {
  safeParse(raw: unknown) {
    const failure = { success: false as const, error: new Error("invalid payload") };
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return failure;
    const record = raw as Record<string, unknown>;
    for (const key of Object.keys(record)) if (!PAYLOAD_KEYS.has(key)) return failure;
    const { note, lines, value } = record;
    if (note !== undefined && typeof note !== "string") return failure;
    if (value !== undefined && typeof value !== "string") return failure;
    if (lines !== undefined) {
      if (!Array.isArray(lines) || lines.some((line) => typeof line !== "string")) return failure;
    }
    return { success: true as const, data: record as CountingPayload };
  },
} as unknown as PayloadSchema;

/** One call an operation received, in arrival order. */
export interface CallRecord {
  readonly kind: "execute" | "reconcile";
  readonly attempt: number;
  readonly key: string;
}

export interface AttemptInfo {
  readonly key: string;
  readonly attempt: number;
}

/** Points inside `execute` where a test can hold, delay or hang the call. */
export interface OperationHooks {
  /** Runs after the call is recorded and before the effect is applied. */
  beforeEffect?: ((info: AttemptInfo) => Promise<void>) | undefined;
  /** Runs after the effect is applied and before the outcome is returned. */
  afterEffect?: ((info: AttemptInfo) => Promise<void>) | undefined;
}

export interface Gate {
  release(): void;
}

export interface CountingOperation {
  readonly operation: EnabledOperation;
  readonly definition: OperationDefinition<EnabledOperation, CountingPayload>;
  /** Every `execute` and `reconcile` call, in order. */
  readonly calls: CallRecord[];
  /** The tokens `execute` was handed, in order. */
  readonly tokens: CapabilityToken<EnabledOperation>[];
  /** The distinct effects (idempotency keys) that were applied. */
  readonly effects: Set<string>;
  /** How many times `execute` was called, retries included. */
  readonly executions: number;
  /** How many times an effect was applied. A duplicate effect shows here even when the key repeats. */
  readonly applications: number;
  /** Outcomes `execute` returns, one per call; an Error is thrown. Empty means `executed`. */
  readonly outcomes: (ExecuteOutcome | Error)[];
  /** Verdicts `reconcile` returns, one per call; an Error is thrown. Empty means "ask the effect ledger". */
  readonly verdicts: (ReconcileVerdict | Error)[];
  readonly hooks: OperationHooks;
  /** How long `claimFacts` takes, so a test can interleave callers between approval and claim. */
  claimFactsDelayMs: number;
  /** Holds every following `execute` before its effect until the gate is released. */
  hold(): Gate;
  /** The calls made for one proposal. */
  callsFor(proposalId: string): CallRecord[];
}

export function draftOf(payload: CountingPayload): ApprovalItemDraft {
  const fromRequester = payload.lines !== undefined;
  return {
    title: "Run the fixture action",
    destructive: false,
    effect: null,
    action: "The command center will run a fixture action.",
    runName: null,
    target: [{ label: "Thing", value: payload.value ?? "the fixture thing", mono: false }],
    change:
      payload.lines === undefined
        ? { type: "none" }
        : { type: "diff", lines: payload.lines.map((text) => ({ kind: "added" as const, text })) },
    changeFromRequester: fromRequester,
    risks: ["This is a fixture."],
    checkHint: null,
  };
}

/**
 * A scriptable operation under `operation`'s name. It counts calls and
 * effects apart: an effect is applied only when `execute` returns `executed`,
 * and `reconcile` answers from the same ledger unless a verdict is scripted,
 * so a crash after the effect leaves evidence a restart can find.
 */
export function createCountingOperation(operation: string): CountingOperation {
  const name = operation as EnabledOperation;
  const calls: CallRecord[] = [];
  const tokens: CapabilityToken<EnabledOperation>[] = [];
  const effects = new Set<string>();
  const outcomes: (ExecuteOutcome | Error)[] = [];
  const verdicts: (ReconcileVerdict | Error)[] = [];
  const hooks: OperationHooks = {};
  let executions = 0;
  let applications = 0;
  let gate: Promise<void> | null = null;

  const op: CountingOperation = {
    operation: name,
    calls,
    tokens,
    effects,
    outcomes,
    verdicts,
    hooks,
    claimFactsDelayMs: 0,
    get executions() {
      return executions;
    },
    get applications() {
      return applications;
    },
    hold() {
      let release: () => void = () => undefined;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        release: () => {
          release();
          gate = null;
        },
      };
    },
    callsFor: (proposalId) => calls.filter((call) => call.key === proposalId),
    definition: {
      operation: name,
      payload: countingPayloadSchema,
      async claimFacts() {
        if (op.claimFactsDelayMs > 0) await delay(op.claimFactsDelayMs);
        return {};
      },
      async execute(token, _payload, context: ExecuteContext) {
        const info: AttemptInfo = { key: context.idempotencyKey, attempt: context.attempt };
        executions += 1;
        calls.push({ kind: "execute", attempt: info.attempt, key: info.key });
        tokens.push(token);
        if (gate !== null) await gate;
        await hooks.beforeEffect?.(info);
        const next = outcomes.shift() ?? { kind: "executed" as const };
        if (next instanceof Error) throw next;
        if (next.kind === "executed") {
          applications += 1;
          effects.add(info.key);
        }
        await hooks.afterEffect?.(info);
        return next;
      },
      async reconcile(_payload, context) {
        calls.push({ kind: "reconcile", attempt: context.attempt, key: context.idempotencyKey });
        const next = verdicts.shift();
        if (next instanceof Error) throw next;
        if (next !== undefined) return next;
        return effects.has(context.idempotencyKey)
          ? { kind: "effect-proven", evidence: "effect-ledger" }
          : { kind: "effect-absent" };
      },
      render: (payload) => draftOf(payload),
    },
  };
  return op;
}

// ---------------------------------------------------------------------------
// The fake connector (D-43): an operation that exists only in these fixtures

export const FAKE_CONNECTOR = "connector.fake-send";

/** The row a later connector phase would add: approval-required, enabled, never retried. */
export const FAKE_CONNECTOR_ROW: ClassificationRow = {
  class: "approval-required",
  status: "enabled",
  ttlMs: 60 * 60_000,
  maxApprovalAgeMs: 5 * 60_000,
  retry: "never",
  modifiable: false,
  summary: "send a fake message",
};

export interface FakeConnector {
  readonly name: string;
  readonly row: ClassificationRow;
  readonly operation: CountingOperation;
  /** An injected COPY of the production table with the connector row added. The production table is untouched. */
  readonly table: ClassificationTable;
}

export function createFakeConnector(): FakeConnector {
  return {
    name: FAKE_CONNECTOR,
    row: FAKE_CONNECTOR_ROW,
    operation: createCountingOperation(FAKE_CONNECTOR),
    table: { ...CLASSIFICATION, [FAKE_CONNECTOR]: FAKE_CONNECTOR_ROW },
  };
}

/**
 * Adds a row to the PRODUCTION table object for the duration of a scenario and
 * returns the function that removes it. This stands in for what a later phase
 * does when it adds a row to the domain table: the SQL store classifies
 * through that table, not through an injected copy. Every use must restore
 * the table in a `finally`.
 */
export function addProductionRow(name: string, row: ClassificationRow): () => void {
  const table = CLASSIFICATION as unknown as Record<string, ClassificationRow>;
  table[name] = row;
  return () => {
    delete table[name];
  };
}

// ---------------------------------------------------------------------------
// Log recorder and the logging allow-list (D-19, T-06-09)

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

/** The only keys an approval log call may carry. */
export const ALLOWED_LOG_KEYS: ReadonlySet<string> = new Set([
  "proposalId",
  "operation",
  "state",
  "payloadHash",
  "attempt",
  "reason",
  "code",
  "count",
  "counts",
]);

/** No logged string is longer than this: a payload, a reason or a label does not fit by accident. */
export const MAX_LOG_STRING_CHARS = 120;

function scalarViolation(key: string, value: unknown): string | null {
  if (typeof value === "string") {
    return value.length > MAX_LOG_STRING_CHARS
      ? `key "${key}" holds a string longer than ${MAX_LOG_STRING_CHARS} characters`
      : null;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return null;
  return `key "${key}" holds a ${value instanceof Error ? "error object" : typeof value}`;
}

/**
 * Every way `lines` break the logging rule, described by key and kind only
 * (never by value, so a violation report cannot itself leak). Empty means clean.
 */
export function logViolations(lines: readonly LoggedLine[]): string[] {
  const found: string[] = [];
  lines.forEach((line, index) => {
    const at = `line ${index + 1} (${line.level})`;
    if (line.message !== undefined) found.push(`${at}: a message string was passed`);
    for (const [key, value] of Object.entries(line.fields)) {
      if (!ALLOWED_LOG_KEYS.has(key)) {
        found.push(`${at}: key "${key}" is not allowed`);
        continue;
      }
      if (key === "counts") {
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          found.push(`${at}: key "counts" must be an object of numbers`);
          continue;
        }
        for (const [counter, count] of Object.entries(value)) {
          if (typeof count !== "number") found.push(`${at}: counts.${counter} is not a number`);
        }
        continue;
      }
      const problem = scalarViolation(key, value);
      if (problem !== null) found.push(`${at}: ${problem}`);
    }
  });
  return found;
}

// ---------------------------------------------------------------------------
// Fault injection

/**
 * Where a crash is injected (the operation-side points; plan 06-24 task 2 adds
 * the store-side points):
 * - `after-claim`: the claim is committed, the effect never starts.
 * - `after-effect`: the effect is applied, the operation never returns.
 */
export type CrashPoint = "after-claim" | "after-effect";

export interface CrashInjector {
  /** Arms one crash. The next time execution reaches `point` it happens, once. */
  arm(point: CrashPoint, operation: CountingOperation): void;
  /** True once an armed crash has happened. */
  readonly fired: boolean;
  /** Wraps a store so a store-side crash can happen. */
  wrapStore(store: ApprovalStorePort): ApprovalStorePort;
}

/**
 * A crash is not an exception the engine can handle: the process is simply
 * gone. An operation-side crash never settles the call, and the test then
 * abandons that engine instance and never touches it again.
 */
export function createCrashInjector(): CrashInjector {
  let fired = false;
  return {
    arm(point, operation) {
      if (point !== "after-claim" && point !== "after-effect") {
        throw new Error("not implemented yet (RED)");
      }
      fired = false;
      if (point === "after-claim") {
        operation.hooks.beforeEffect = async () => {
          operation.hooks.beforeEffect = undefined;
          fired = true;
          await neverSettles();
        };
      } else {
        operation.hooks.afterEffect = async () => {
          operation.hooks.afterEffect = undefined;
          fired = true;
          await neverSettles();
        };
      }
    },
    get fired() {
      return fired;
    },
    wrapStore: (store) => store,
  };
}

// ---------------------------------------------------------------------------
// The restartable engine

/**
 * What survives a restart: the clock, the operations (the "world" an effect
 * happens in, which a process death does not undo), the log recorder and the
 * crash injector. The database is the engine's own state and lives in a file.
 */
export interface World {
  readonly clock: FakeClock;
  readonly diagnostic: CountingOperation;
  readonly terminate: CountingOperation;
  /** Every operation registered: the two enabled rows plus any extra. */
  readonly operations: readonly CountingOperation[];
  readonly table: ClassificationTable;
  readonly log: RecordingLog;
  readonly injector: CrashInjector;
  /** A counter that keeps submitted subjects distinct across restarts. */
  nextSubject(): string;
}

export interface WorldOptions {
  readonly extraOperations?: readonly CountingOperation[];
  /** An injected classification table. Defaults to the production table. */
  readonly table?: ClassificationTable;
  readonly start?: string;
}

export function createWorld(options: WorldOptions = {}): World {
  const diagnostic = createCountingOperation("diagnostic.test");
  const terminate = createCountingOperation("session.force-terminate");
  let counter = 0;
  return {
    clock: createFakeClock(options.start),
    diagnostic,
    terminate,
    operations: [diagnostic, terminate, ...(options.extraOperations ?? [])],
    table: options.table ?? CLASSIFICATION,
    log: createRecordingLog(),
    injector: createCrashInjector(),
    nextSubject() {
      counter += 1;
      return `case-${counter}`;
    },
  };
}

export interface OpenEngineOptions {
  /** The longest claim facts may take; defaults to the engine's own. */
  readonly claimFactsTimeoutMs?: number;
}

export interface OpenedEngine {
  readonly engine: ApprovalEngine;
  /** The real store over the database, for reading what the engine did. Never fenced. */
  readonly store: ApprovalStore;
  readonly db: Db;
  readonly dbPath: string;
  readonly world: World;
  /** Every summary the engine published, in order. */
  readonly published: ApprovalSummary[];
  /** Every proposal the engine asked to mirror. */
  readonly mirrored: StoredProposal[];
  /** Submits one request with defaults; `overrides` change what a test is about. Fails the test when not accepted. */
  propose(overrides?: Partial<SubmitInput>): ProposalId;
  /** The full payload hash the owner would be shown for a request. */
  hashOf(proposalId: string): string;
  /** Approves (or denies) with the stored hash through the plugin channel. */
  decide(proposalId: string, decision?: "approve" | "deny"): ReturnType<ApprovalEngine["decide"]>;
  /** Closes the database handle. Nothing may be called on the engine afterwards. */
  close(): void;
}

/** Opens (and migrates) the database at `dbPath` and builds the real engine over it. A second call on the same path is a restart. */
export function openEngine(
  dbPath: string,
  world: World,
  options: OpenEngineOptions = {},
): OpenedEngine {
  const handle = openStore(dbPath);
  applyMigrations(handle.db);
  const store = createApprovalStore(handle.db);
  const registry = buildOperationRegistry(
    world.operations.map((op) => op.definition),
    world.table,
  );
  const published: ApprovalSummary[] = [];
  const mirrored: StoredProposal[] = [];
  const engine = createApprovalEngine({
    store: world.injector.wrapStore(store),
    registry,
    clock: world.clock,
    log: world.log,
    publisher: {
      publish(_event, payload) {
        published.push(payload.approval);
      },
    },
    mirror: {
      async mirror(proposal) {
        mirrored.push(proposal);
      },
    },
    ...(options.claimFactsTimeoutMs === undefined
      ? {}
      : { claimFactsTimeoutMs: options.claimFactsTimeoutMs }),
  });

  let closed = false;

  function hashOf(proposalId: string): string {
    const row = store.get(proposalId as ProposalId);
    if (row === null) throw new Error("no such proposal");
    return row.payloadHash;
  }

  return {
    engine,
    store,
    db: handle.db,
    dbPath,
    world,
    published,
    mirrored,
    propose(overrides = {}) {
      const outcome = engine.submit({
        operation: "diagnostic.test",
        subject: world.nextSubject(),
        requester: { kind: "dashboard", label: "Fixture dashboard" },
        projectId: null,
        runId: null,
        reason: "Exercising the approval path.",
        payload: {},
        ...overrides,
      });
      if (outcome.kind !== "proposed") {
        throw new Error(`submit was not accepted: ${outcome.reason}`);
      }
      return outcome.proposalId;
    },
    hashOf,
    decide(proposalId, decision = "approve") {
      return engine.decide({
        proposalId,
        decision,
        payloadHash: hashOf(proposalId),
        via: "plugin",
      });
    },
    close() {
      if (closed) return;
      closed = true;
      handle.close();
    },
  };
}

/** A throwaway directory and database path, removed by the returned function. */
function createTempDatabase(): { readonly dbPath: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "ccc-approval-int-"));
  return {
    dbPath: join(dir, "operational.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export interface Rigs {
  /** A fresh database in a throwaway directory with a fresh world, all removed by `dispose`. */
  start(options?: WorldOptions & OpenEngineOptions): OpenedEngine;
  /** Another engine on the same database file and world: a second connection, or a restart after a crash. */
  connect(from: OpenedEngine, options?: OpenEngineOptions): OpenedEngine;
  dispose(): void;
}

export function createRigs(): Rigs {
  const opened: OpenedEngine[] = [];
  const cleanups: (() => void)[] = [];
  return {
    start(options = {}) {
      const temp = createTempDatabase();
      cleanups.push(temp.cleanup);
      const engine = openEngine(temp.dbPath, createWorld(options), options);
      opened.push(engine);
      return engine;
    },
    connect(from, options = {}) {
      const engine = openEngine(from.dbPath, from.world, options);
      opened.push(engine);
      return engine;
    },
    dispose() {
      for (const engine of opened.splice(0)) engine.close();
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
  };
}

// ---------------------------------------------------------------------------
// Reading what happened

export interface AuditRecord {
  readonly seq: number;
  readonly event: ApprovalAuditEvent;
  readonly at: string;
  readonly decidedVia: string | null;
  readonly payloadHash: string | null;
  readonly detail: string | null;
}

/** The complete audit trail of one request, oldest first, straight from the table. */
export function readAudit(db: Db, proposalId: string): AuditRecord[] {
  const rows = db
    .prepare(
      `SELECT seq, event, at, decided_via, payload_hash, detail
       FROM approval_audit WHERE proposal_id = ? ORDER BY seq ASC`,
    )
    .all(proposalId) as {
    seq: number;
    event: ApprovalAuditEvent;
    at: string;
    decided_via: string | null;
    payload_hash: string | null;
    detail: string | null;
  }[];
  return rows.map((row) => ({
    seq: row.seq,
    event: row.event,
    at: row.at,
    decidedVia: row.decided_via,
    payloadHash: row.payload_hash,
    detail: row.detail,
  }));
}

export function auditEvents(db: Db, proposalId: string): ApprovalAuditEvent[] {
  return readAudit(db, proposalId).map((row) => row.event);
}

export function countAudit(db: Db, proposalId: string, event: ApprovalAuditEvent): number {
  return readAudit(db, proposalId).filter((row) => row.event === event).length;
}

export interface ExecutionRecord {
  readonly attempt: number;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly resultCode: string | null;
}

/** The attempt rows of one request. */
export function readExecutions(db: Db, proposalId: string): ExecutionRecord[] {
  const rows = db
    .prepare(
      `SELECT attempt, started_at, finished_at, result_code
       FROM approval_executions WHERE proposal_id = ? ORDER BY attempt ASC`,
    )
    .all(proposalId) as {
    attempt: number;
    started_at: string;
    finished_at: string | null;
    result_code: string | null;
  }[];
  return rows.map((row) => ({
    attempt: row.attempt,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    resultCode: row.result_code,
  }));
}

/** How many rows the zero-impact diagnostic effect ledger holds for a request. */
export function diagnosticEffectRows(db: Db, proposalId: string): number {
  const row = db
    .prepare("SELECT count(*) AS n FROM diagnostic_effects WHERE proposal_id = ?")
    .get(proposalId) as { n: number };
  return row.n;
}

// RED skeleton for plan 06-24 task 2: the store-side crash points, the
// recording failure, the restart helper and the audit-path checker follow.
const notImplemented = (..._args: unknown[]): never => {
  throw new Error("not implemented yet (RED)");
};
export class CrashSignal extends Error {}
export const failRecording = notImplemented;
export const restart = notImplemented;
export const auditPathProblems = notImplemented;
