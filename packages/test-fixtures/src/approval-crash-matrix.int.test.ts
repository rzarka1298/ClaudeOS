import type {
  ApprovalAuditEvent,
  ExecuteOutcome,
  ProposalId,
  ProposalState,
} from "@ccc/domain";
import type { RecoverySummary } from "@ccc/service/approval";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addProductionRow,
  type CallRecord,
  type CountingOperation,
  CrashSignal,
  createFakeConnector,
  createRigs,
  delay,
  FAKE_CONNECTOR,
  failRecording,
  logViolations,
  type OpenedEngine,
  type Rigs,
  readAudit,
  readExecutions,
  restart,
  auditPathProblems,
} from "./approval-fixtures.js";

/**
 * The crash-at-every-step matrix (plan 06-24 task 2, APPR-10, D-17, D-42,
 * T-06-06). A crash is simulated, never thrown through the engine: an
 * operation-side crash makes the call never settle, a store-side crash throws
 * from a fenced store that touches the database no more, and the recording
 * crash is a temporary trigger that rolls the transaction back. The engine
 * instance is then abandoned and a fresh one opened on the same file, which
 * is exactly what a restart is.
 *
 * Expected values are written from the rules (D-17: reconcile before any
 * retry, one retry, unknown is terminal) and the audit paths are checked
 * against the domain transition table, never copied from the implementation.
 * The effect count is the operation's own `applications` counter.
 */

const MINUTE_MS = 60_000;

async function waitUntil(condition: () => boolean, what: string): Promise<void> {
  for (let waited = 0; waited < 3000; waited += 5) {
    if (condition()) return;
    await delay(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Everything a scenario established, copied out so the rigs can be disposed. */
interface Snapshot {
  readonly id: ProposalId;
  readonly state: ProposalState;
  readonly attempts: number;
  readonly outcomeCode: string | null;
  readonly events: ApprovalAuditEvent[];
  readonly details: (string | null)[];
  readonly applications: number;
  readonly executions: number;
  readonly calls: CallRecord[];
  readonly attemptRows: number;
  readonly unfinishedAttemptRows: number;
  readonly before: { state: ProposalState; attempts: number; events: ApprovalAuditEvent[] };
  readonly recoveries: RecoverySummary[];
  readonly logProblems: string[];
}

interface Scenario {
  readonly name: string;
  readonly run: (rigs: Rigs) => Promise<Snapshot>;
  readonly expected: {
    readonly before: ProposalState;
    readonly final: ProposalState;
    readonly events: ApprovalAuditEvent[];
    readonly applications: number;
    readonly executions: number;
    readonly attempts: number;
    readonly outcomeCode: string | null;
    /** The detail the outcome audit row carries (the evidence code or the outcome code). */
    readonly lastDetail: string | null;
    /** The calls the operation saw, as `kind:attempt`. */
    readonly callOrder: string[];
  };
}

function snapshot(
  rig: OpenedEngine,
  id: ProposalId,
  op: CountingOperation,
  before: Snapshot["before"],
  recoveries: RecoverySummary[],
): Snapshot {
  const row = rig.store.get(id);
  if (row === null) throw new Error("the proposal vanished");
  const audit = readAudit(rig.db, id);
  const attempts = readExecutions(rig.db, id);
  return {
    id,
    state: row.state,
    attempts: row.attempts,
    outcomeCode: row.outcomeCode,
    events: audit.map((entry) => entry.event),
    details: audit.map((entry) => entry.detail),
    applications: op.applications,
    executions: op.executions,
    calls: [...op.callsFor(id)],
    attemptRows: attempts.length,
    unfinishedAttemptRows: attempts.filter((entry) => entry.finishedAt === null).length,
    before,
    recoveries,
    logProblems: logViolations(rig.world.log.lines),
  };
}

function beforeRestart(rig: OpenedEngine, id: ProposalId): Snapshot["before"] {
  const row = rig.store.get(id);
  return {
    state: row?.state ?? "pending",
    attempts: row?.attempts ?? -1,
    events: readAudit(rig.db, id).map((entry) => entry.event),
  };
}

type Crash = "after-decision" | "after-claim" | "after-effect" | "before-record" | "inside-record";

/** Raises a request, approves it and lets the chosen crash happen. Returns the crashed instance. */
async function crashAt(
  rig: OpenedEngine,
  op: CountingOperation,
  crash: Crash,
  propose: () => ProposalId,
): Promise<ProposalId> {
  const id = propose();
  switch (crash) {
    case "after-decision": {
      rig.world.injector.arm("after-decision", op);
      await expect(rig.decide(id)).rejects.toBeInstanceOf(CrashSignal);
      expect(rig.world.injector.fired).toBe(true);
      break;
    }
    case "after-claim":
    case "after-effect": {
      rig.world.injector.arm(crash, op);
      await rig.decide(id);
      await waitUntil(() => rig.world.injector.fired, `the crash ${crash}`);
      break;
    }
    case "before-record": {
      rig.world.injector.arm("before-record", op);
      await rig.decide(id);
      await rig.engine.settled();
      expect(rig.world.injector.fired).toBe(true);
      break;
    }
    case "inside-record": {
      failRecording(rig.db);
      await rig.decide(id);
      await rig.engine.settled();
      break;
    }
  }
  return id;
}

/** One crash, one restart, one recovery. */
function crashRecover(
  crash: Crash,
  options: {
    readonly script?: (op: CountingOperation) => void;
    readonly advanceMs?: number;
    readonly restarts?: number;
  } = {},
): Scenario["run"] {
  return async (rigs) => {
    const rig = rigs.start();
    const op = rig.world.diagnostic;
    options.script?.(op);
    const id = await crashAt(rig, op, crash, () => rig.propose());
    const before = beforeRestart(rig, id);
    rig.world.clock.advance(options.advanceMs ?? 1000);
    const next = restart(rigs, rig);
    const summary = await next.engine.recover();
    await next.engine.settled();
    return snapshot(next, id, op, before, [summary]);
  };
}

const REFUSED: ExecuteOutcome = { kind: "refused", reason: "process-ended" };
const FAILED: ExecuteOutcome = { kind: "failed", reason: "execution-failed" };
const BASE = ["requested", "approved", "claimed"] as const satisfies ApprovalAuditEvent[];

const SCENARIOS: Scenario[] = [
  {
    name: "after the decision, inside the approval age: claimed and executed once",
    run: crashRecover("after-decision", { advanceMs: 4 * MINUTE_MS }),
    expected: {
      before: "approved",
      final: "executed",
      events: [...BASE, "executed"],
      applications: 1,
      executions: 1,
      attempts: 1,
      outcomeCode: "executed",
      lastDetail: "executed",
      callOrder: ["execute:1"],
    },
  },
  {
    name: "after the decision, past the approval age: lapsed with no effect",
    run: crashRecover("after-decision", { advanceMs: 5 * MINUTE_MS }),
    expected: {
      before: "approved",
      final: "lapsed",
      events: ["requested", "approved", "lapsed"],
      applications: 0,
      executions: 0,
      attempts: 0,
      outcomeCode: null,
      lastDetail: null,
      callOrder: [],
    },
  },
  {
    name: "after the claim: reconciled absent, retried once with the same key",
    run: crashRecover("after-claim"),
    expected: {
      before: "executing",
      final: "executed",
      events: [...BASE, "retried-after-restart", "executed"],
      applications: 1,
      executions: 2,
      attempts: 2,
      outcomeCode: "executed",
      lastDetail: "executed",
      callOrder: ["execute:1", "reconcile:1", "execute:2"],
    },
  },
  {
    name: "after the effect: reconciled proven, executed with no second execution",
    run: crashRecover("after-effect"),
    expected: {
      before: "executing",
      final: "executed",
      events: [...BASE, "reconciled-executed"],
      applications: 1,
      executions: 1,
      attempts: 1,
      outcomeCode: "executed",
      lastDetail: "effect-ledger",
      callOrder: ["execute:1", "reconcile:1"],
    },
  },
  {
    name: "before the outcome is recorded: behaves as after the effect",
    run: crashRecover("before-record"),
    expected: {
      before: "executing",
      final: "executed",
      events: [...BASE, "reconciled-executed"],
      applications: 1,
      executions: 1,
      attempts: 1,
      outcomeCode: "executed",
      lastDetail: "effect-ledger",
      callOrder: ["execute:1", "reconcile:1"],
    },
  },
  {
    name: "inside the recording transaction: rolled back, then behaves as after the effect",
    run: crashRecover("inside-record"),
    expected: {
      before: "executing",
      final: "executed",
      events: [...BASE, "reconciled-executed"],
      applications: 1,
      executions: 1,
      attempts: 1,
      outcomeCode: "executed",
      lastDetail: "effect-ledger",
      callOrder: ["execute:1", "reconcile:1"],
    },
  },
  {
    name: "late refusal on the retry, reconcile then proves the effect: executed (reconciled)",
    run: crashRecover("after-claim", {
      script(op) {
        op.verdicts.push({ kind: "effect-absent" }, { kind: "effect-proven", evidence: "peer-wrote" });
        op.outcomes.push(REFUSED);
      },
    }),
    expected: {
      before: "executing",
      final: "executed",
      events: [...BASE, "retried-after-restart", "reconciled-executed"],
      applications: 0,
      executions: 2,
      attempts: 2,
      outcomeCode: "executed",
      lastDetail: "peer-wrote",
      callOrder: ["execute:1", "reconcile:1", "execute:2", "reconcile:2"],
    },
  },
  {
    name: "late refusal on the retry, reconcile finds the effect absent: unknown, never failed",
    run: crashRecover("after-claim", {
      script(op) {
        op.verdicts.push({ kind: "effect-absent" }, { kind: "effect-absent" });
        op.outcomes.push(REFUSED);
      },
    }),
    expected: {
      before: "executing",
      final: "unknown",
      events: [...BASE, "retried-after-restart", "outcome-unknown"],
      applications: 0,
      executions: 2,
      attempts: 2,
      outcomeCode: "outcome-unknown",
      lastDetail: "effect-absent",
      callOrder: ["execute:1", "reconcile:1", "execute:2", "reconcile:2"],
    },
  },
  {
    name: "late failure on the retry, reconcile cannot tell: unknown, never failed",
    run: crashRecover("after-claim", {
      script(op) {
        op.verdicts.push({ kind: "effect-absent" }, { kind: "unknown", reason: "no-evidence" });
        op.outcomes.push(FAILED);
      },
    }),
    expected: {
      before: "executing",
      final: "unknown",
      events: [...BASE, "retried-after-restart", "outcome-unknown"],
      applications: 0,
      executions: 2,
      attempts: 2,
      outcomeCode: "outcome-unknown",
      lastDetail: "no-evidence",
      callOrder: ["execute:1", "reconcile:1", "execute:2", "reconcile:2"],
    },
  },
  {
    name: "a retry whose execute rejects: unknown, never failed",
    run: crashRecover("after-claim", {
      script(op) {
        op.verdicts.push({ kind: "effect-absent" });
        op.outcomes.push(new Error("retry blew up"));
      },
    }),
    expected: {
      before: "executing",
      final: "unknown",
      events: [...BASE, "retried-after-restart", "outcome-unknown"],
      applications: 0,
      executions: 2,
      attempts: 2,
      outcomeCode: "executor-threw",
      lastDetail: "executor-threw",
      callOrder: ["execute:1", "reconcile:1", "execute:2"],
    },
  },
  {
    name: "late refusal and the second reconcile throws: unknown",
    run: crashRecover("after-claim", {
      script(op) {
        op.verdicts.push({ kind: "effect-absent" }, new Error("reconcile down"));
        op.outcomes.push(REFUSED);
      },
    }),
    expected: {
      before: "executing",
      final: "unknown",
      events: [...BASE, "retried-after-restart", "outcome-unknown"],
      applications: 0,
      executions: 2,
      attempts: 2,
      outcomeCode: "reconcile-threw",
      lastDetail: "reconcile-threw",
      callOrder: ["execute:1", "reconcile:1", "execute:2", "reconcile:2"],
    },
  },
  {
    name: "reconcile cannot tell at recovery: unknown with no retry",
    run: crashRecover("after-claim", {
      script(op) {
        op.verdicts.push({ kind: "unknown", reason: "no-evidence" });
      },
    }),
    expected: {
      before: "executing",
      final: "unknown",
      events: [...BASE, "outcome-unknown"],
      applications: 0,
      executions: 1,
      attempts: 1,
      outcomeCode: "outcome-unknown",
      lastDetail: "no-evidence",
      callOrder: ["execute:1", "reconcile:1"],
    },
  },
  {
    name: "reconcile throws at recovery: unknown with no retry",
    run: crashRecover("after-claim", {
      script(op) {
        op.verdicts.push(new Error("reconcile down"));
      },
    }),
    expected: {
      before: "executing",
      final: "unknown",
      events: [...BASE, "outcome-unknown"],
      applications: 0,
      executions: 1,
      attempts: 1,
      outcomeCode: "reconcile-threw",
      lastDetail: "reconcile-threw",
      callOrder: ["execute:1", "reconcile:1"],
    },
  },
  {
    name: "recovery after the approval age has passed: absent evidence ends unknown, no retry",
    run: crashRecover("after-claim", { advanceMs: 5 * MINUTE_MS }),
    expected: {
      before: "executing",
      final: "unknown",
      events: [...BASE, "outcome-unknown"],
      applications: 0,
      executions: 1,
      attempts: 1,
      outcomeCode: "outcome-unknown",
      lastDetail: "effect-absent",
      callOrder: ["execute:1", "reconcile:1"],
    },
  },
  {
    name: "retry exhausted: two attempts used and the evidence still absent ends unknown",
    run: async (rigs) => {
      const first = rigs.start();
      const op = first.world.diagnostic;
      const id = await crashAt(first, op, "after-claim", () => first.propose());
      const before = beforeRestart(first, id);
      first.world.clock.advance(1000);
      // The first restart retries and the retry itself crashes before its effect.
      const second = restart(rigs, first);
      second.world.injector.arm("after-claim", op);
      const firstRecovery = await second.engine.recover();
      await waitUntil(() => second.world.injector.fired, "the crash during the retry");
      expect(second.store.get(id)?.attempts).toBe(2);
      second.world.clock.advance(1000);
      const third = restart(rigs, second);
      const secondRecovery = await third.engine.recover();
      await third.engine.settled();
      return snapshot(third, id, op, before, [firstRecovery, secondRecovery]);
    },
    expected: {
      before: "executing",
      final: "unknown",
      events: [...BASE, "retried-after-restart", "outcome-unknown"],
      applications: 0,
      executions: 2,
      attempts: 2,
      outcomeCode: "outcome-unknown",
      lastDetail: "effect-absent",
      callOrder: ["execute:1", "reconcile:1", "execute:2", "reconcile:2"],
    },
  },
  {
    name: "an operation that is never retried: absent evidence ends unknown after one execution",
    run: async (rigs) => {
      const connector = createFakeConnector();
      const rig = rigs.start({ extraOperations: [connector.operation], table: connector.table });
      const restore = addProductionRow(FAKE_CONNECTOR, connector.row);
      try {
        const id = await crashAt(rig, connector.operation, "after-claim", () =>
          rig.propose({
            operation: FAKE_CONNECTOR,
            requester: { kind: "connector", label: "Fake connector" },
          }),
        );
        const before = beforeRestart(rig, id);
        rig.world.clock.advance(1000);
        const next = restart(rigs, rig);
        const summary = await next.engine.recover();
        await next.engine.settled();
        return snapshot(next, id, connector.operation, before, [summary]);
      } finally {
        restore();
      }
    },
    expected: {
      before: "executing",
      final: "unknown",
      events: [...BASE, "outcome-unknown"],
      applications: 0,
      executions: 1,
      attempts: 1,
      outcomeCode: "outcome-unknown",
      lastDetail: "effect-absent",
      callOrder: ["execute:1", "reconcile:1"],
    },
  },
];

const rigs = createRigs();
const results = new Map<string, Snapshot | Error>();

beforeAll(async () => {
  for (const scenario of SCENARIOS) {
    try {
      results.set(scenario.name, await scenario.run(rigs));
    } catch (error) {
      results.set(scenario.name, error instanceof Error ? error : new Error(String(error)));
    }
  }
}, 120_000);
afterAll(() => rigs.dispose());

function resultOf(name: string): Snapshot {
  const result = results.get(name);
  if (result === undefined) throw new Error("the scenario did not run");
  if (result instanceof Error) throw result;
  return result;
}

describe("Tests 1 to 7: the crash matrix", () => {
  it("has at least eleven rows, covering the five injection points and the late-refusal, terminal and exhausted rows", () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(11);
    const names = SCENARIOS.map((scenario) => scenario.name).join("\n");
    for (const point of ["after the decision", "after the claim", "after the effect", "before the outcome", "inside the recording"]) {
      expect(names).toContain(point);
    }
    expect(names).toContain("late refusal");
    expect(names).toContain("retry exhausted");
  });

  for (const scenario of SCENARIOS) {
    it(scenario.name, () => {
      const got = resultOf(scenario.name);
      const want = scenario.expected;
      expect(got.before.state).toBe(want.before);
      expect(got.state).toBe(want.final);
      expect(got.events).toEqual(want.events);
      expect(got.attempts).toBe(want.attempts);
      expect(got.outcomeCode).toBe(want.outcomeCode);
      expect(got.details.at(-1) ?? null).toBe(want.lastDetail);
      // The operation's own counters: effects applied and executions started.
      expect(got.applications).toBe(want.applications);
      expect(got.executions).toBe(want.executions);
      expect(got.calls.map((call) => `${call.kind}:${call.attempt}`)).toEqual(want.callOrder);
      // Every call carried the proposal id as its key; it is never regenerated.
      expect(got.calls.every((call) => call.key === got.id)).toBe(true);
      // Nothing in the matrix ends as plain failed: after a retry that would be a lie, and no first attempt here fails.
      expect(got.state).not.toBe("failed");
      expect(got.logProblems).toEqual([]);
    });
  }

  it("records what a crash left behind before the restart in the rolled-back and fenced rows", () => {
    // The inside-recording crash rolled back: no outcome event reached the audit table.
    const rolledBack = resultOf(
      "inside the recording transaction: rolled back, then behaves as after the effect",
    );
    expect(rolledBack.before.events).toEqual([...BASE]);
    expect(rolledBack.before.attempts).toBe(1);
    const fenced = resultOf("before the outcome is recorded: behaves as after the effect");
    expect(fenced.before.events).toEqual([...BASE]);
  });
});

describe("Test 7: unknown is terminal", () => {
  it("is untouched by any number of further restarts, and no third attempt ever happens", async () => {
    const local = createRigs();
    try {
      const rig = local.start();
      const op = rig.world.diagnostic;
      op.verdicts.push({ kind: "effect-absent" }, { kind: "effect-absent" });
      op.outcomes.push(REFUSED);
      const id = await crashAt(rig, op, "after-claim", () => rig.propose());
      let current = restart(local, rig);
      await current.engine.recover();
      await current.engine.settled();
      expect(current.store.get(id)?.state).toBe("unknown");
      const settledRow = current.store.get(id);
      const settledCalls = [...op.calls];
      const settledAudit = readAudit(current.db, id);

      for (let round = 0; round < 3; round += 1) {
        current.world.clock.advance(MINUTE_MS);
        current = restart(local, current);
        const summary = await current.engine.recover();
        await current.engine.settled();
        expect(summary).toMatchObject({
          reconciled: 0,
          retried: 0,
          unknown: 0,
          claimed: 0,
          failed: 0,
          lapsed: 0,
        });
      }
      expect(current.store.get(id)).toEqual(settledRow);
      expect(readAudit(current.db, id)).toEqual(settledAudit);
      expect(op.calls).toEqual(settledCalls);
      expect(op.executions).toBe(2);
      expect(op.applications).toBe(0);
    } finally {
      local.dispose();
    }
  });
});

describe("Test 8: a claim and a retry happen at most once", () => {
  it("holds across every scenario, and no effect is applied twice", () => {
    for (const scenario of SCENARIOS) {
      const got = resultOf(scenario.name);
      expect(got.events.filter((event) => event === "claimed").length, scenario.name).toBeLessThanOrEqual(1);
      expect(
        got.events.filter((event) => event === "retried-after-restart").length,
        scenario.name,
      ).toBeLessThanOrEqual(1);
      expect(got.applications, scenario.name).toBeLessThanOrEqual(1);
      expect(got.executions, scenario.name).toBeLessThanOrEqual(2);
      expect(got.attempts, scenario.name).toBeLessThanOrEqual(2);
      expect(got.attemptRows, scenario.name).toBeLessThanOrEqual(2);
    }
  });
});

describe("Test 9: reconcile is asked before any retry", () => {
  it("holds in every scenario that retried", () => {
    let retried = 0;
    for (const scenario of SCENARIOS) {
      const got = resultOf(scenario.name);
      const second = got.calls.findIndex((call) => call.kind === "execute" && call.attempt === 2);
      if (second === -1) continue;
      retried += 1;
      const firstReconcile = got.calls.findIndex((call) => call.kind === "reconcile");
      expect(firstReconcile, scenario.name).toBeGreaterThanOrEqual(0);
      expect(firstReconcile, scenario.name).toBeLessThan(second);
    }
    // Not vacuous: several rows did retry.
    expect(retried).toBeGreaterThanOrEqual(5);
  });
});

describe("Test 10: every audit trail is a legal path through the transition table", () => {
  it("holds in every scenario", () => {
    for (const scenario of SCENARIOS) {
      const got = resultOf(scenario.name);
      expect(auditPathProblems(got.events, got.state), scenario.name).toEqual([]);
    }
  });

  it("is not vacuous: illegal trails are reported", () => {
    expect(auditPathProblems(["requested", "executed"], "executed")).not.toEqual([]);
    expect(auditPathProblems(["approved", "claimed"], "executing")).not.toEqual([]);
    expect(
      auditPathProblems(
        ["requested", "approved", "claimed", "retried-after-restart", "retried-after-restart"],
        "executing",
      ),
    ).not.toEqual([]);
    expect(
      auditPathProblems(["requested", "approved", "claimed", "executed", "claimed"], "executing"),
    ).not.toEqual([]);
    expect(auditPathProblems(["requested", "approved", "claimed", "executed"], "unknown")).not.toEqual([]);
    expect(auditPathProblems(["requested", "approved", "retried-after-restart"], "approved")).not.toEqual([]);
    expect(auditPathProblems(["requested", "denied"], "denied")).toEqual([]);
  });
});
