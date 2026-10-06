// Domain-only fakes for the executors tests (06-07). This folder is its own
// element: nothing here may import anything but `@ccc/domain`. These fakes
// record what the operations asked of them, so a test can assert both what an
// operation returned and what it did NOT touch. There is deliberately no
// capability-token construction in this file: a test that needs a token builds
// one with a local cast inside its own `*.test.ts` file (backstop rule 10).
import type {
  ApprovalLog,
  CapabilityToken,
  DiagnosticEffectsPort,
  ProcessStatus,
  ProposalId,
  RunFacts,
  RunId,
  RunInspector,
  SessionTerminator,
  TerminateResult,
} from "@ccc/domain";

/** An in-memory effect ledger that counts every record call apart from the distinct rows it holds. */
export interface FakeEffects extends DiagnosticEffectsPort {
  /** Every `record` call, including repeats. */
  readonly recordCalls: ProposalId[];
  /** The distinct proposal ids that have a row. */
  readonly rows: Set<string>;
  /** Every `exists` call. */
  readonly existsCalls: ProposalId[];
}

export function createFakeEffects(initialRows: readonly string[] = []): FakeEffects {
  const rows = new Set<string>(initialRows);
  const recordCalls: ProposalId[] = [];
  const existsCalls: ProposalId[] = [];
  return {
    recordCalls,
    existsCalls,
    rows,
    record(proposalId) {
      recordCalls.push(proposalId);
      if (rows.has(proposalId)) return "already-recorded";
      rows.add(proposalId);
      return "recorded";
    },
    exists(proposalId) {
      existsCalls.push(proposalId);
      return rows.has(proposalId);
    },
  };
}

export type LogLevel = "info" | "warn" | "error";

export interface LoggedLine {
  readonly level: LogLevel;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly message: string | undefined;
}

/** A log that keeps every line, so a test can assert what was (and was not) written. */
export interface FakeLog extends ApprovalLog {
  readonly lines: LoggedLine[];
  ofLevel(level: LogLevel): LoggedLine[];
}

export function createFakeLog(): FakeLog {
  const lines: LoggedLine[] = [];
  const push = (level: LogLevel) => (fields: Readonly<Record<string, unknown>>, message?: string) =>
    void lines.push({ level, fields, message });
  return {
    lines,
    ofLevel: (level) => lines.filter((line) => line.level === level),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
  };
}

/** What a fake terminator does when called: answer with a result or reject. */
export type TerminatorScript =
  | { readonly kind: "result"; readonly result: TerminateResult }
  | { readonly kind: "reject"; readonly error: Error };

export interface TerminatorCall {
  readonly token: CapabilityToken<"session.force-terminate">;
  readonly runId: RunId;
}

export interface FakeTerminator extends SessionTerminator {
  readonly calls: TerminatorCall[];
  script: TerminatorScript;
}

export function createFakeTerminator(
  script: TerminatorScript = { kind: "result", result: { ok: true } },
): FakeTerminator {
  const calls: TerminatorCall[] = [];
  const fake: FakeTerminator = {
    calls,
    script,
    async terminate(token, runId) {
      calls.push({ token, runId });
      if (fake.script.kind === "reject") throw fake.script.error;
      return fake.script.result;
    },
  };
  return fake;
}

/** A scripted view of the Run and its process, recording every read. */
export interface FakeInspector extends RunInspector {
  /** What `readRun` returns; null for a missing Run. Mutable so a test can change the world between calls. */
  run: RunFacts | null;
  /** What `processStatus` answers. */
  status: ProcessStatus;
  /** When set, `readRun` throws this. */
  readRunError: Error | null;
  /** When set, `processStatus` rejects with this. */
  statusError: Error | null;
  readonly readCalls: string[];
  readonly statusCalls: { readonly pid: number; readonly expectedStartedAt: string }[];
}

export function createFakeInspector(
  initial: { run?: RunFacts | null; status?: ProcessStatus } = {},
): FakeInspector {
  const fake: FakeInspector = {
    run: initial.run === undefined ? null : initial.run,
    status: initial.status ?? "same",
    readRunError: null,
    statusError: null,
    readCalls: [],
    statusCalls: [],
    readRun(runId) {
      fake.readCalls.push(runId);
      if (fake.readRunError !== null) throw fake.readRunError;
      return fake.run;
    },
    async processStatus(pid, expectedStartedAt) {
      fake.statusCalls.push({ pid, expectedStartedAt });
      if (fake.statusError !== null) throw fake.statusError;
      return fake.status;
    },
  };
  return fake;
}

/** Run facts with sensible defaults; a test overrides only what it is about. */
export function makeRunFacts(overrides: Partial<RunFacts> & { readonly runId: string }): RunFacts {
  return {
    state: "running",
    displayName: "Refactor parser",
    pid: 4242,
    processStartedAt: "Mon Oct  6 01:00:00 2026",
    ...overrides,
  };
}
