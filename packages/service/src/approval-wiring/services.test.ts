import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ApprovalItemDraft,
  ApprovalLog,
  ApprovalSummary,
  Clock,
  EnabledOperation,
  OperationDefinition,
  ServiceEventType,
} from "@ccc/domain";
import { applyMigrations, type OperationalStore, openStore } from "@ccc/operational-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ApprovalRuntimeDeps,
  resolveSweepIntervalMs,
  resolveTestLifetimeMs,
  startApprovalServices,
} from "./services.js";

let base: string;
let store: OperationalStore;

beforeEach(() => {
  const root = join(homedir(), ".ccc-test");
  mkdirSync(root, { recursive: true });
  base = mkdtempSync(join(root, "appr-wire-"));
  store = openStore(join(base, "operational.db"));
  applyMigrations(store.db);
});

afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

const DRAFT: ApprovalItemDraft = {
  title: "Test approval",
  destructive: false,
  effect: null,
  action: "The command center will do nothing.",
  runName: null,
  target: [],
  change: { type: "none" },
  changeFromRequester: false,
  risks: ["This test changes nothing."],
  checkHint: null,
};

interface FakeOps {
  readonly definitions: OperationDefinition<EnabledOperation, unknown>[];
  readonly executed: string[];
}

/** Package-local fakes of the two enabled operations: the executors folder is main.ts's alone. */
function fakeOperations(): FakeOps {
  const executed: string[] = [];
  const diagnostic: OperationDefinition<EnabledOperation, unknown> = {
    operation: "diagnostic.test",
    payload: z.strictObject({}),
    subjectOf: () => "diagnostic",
    async execute(_token, _payload, context) {
      executed.push(context.idempotencyKey);
      return { kind: "executed" };
    },
    async reconcile() {
      return { kind: "effect-absent" };
    },
    render: () => DRAFT,
  };
  const terminate: OperationDefinition<EnabledOperation, unknown> = {
    operation: "session.force-terminate",
    payload: z.strictObject({ runId: z.string().min(1) }),
    subjectOf: (payload) => (payload as { runId: string }).runId,
    async execute() {
      return { kind: "failed", reason: "execution-failed" };
    },
    async reconcile() {
      return { kind: "unknown", reason: "none" };
    },
    render: () => DRAFT,
  };
  return { definitions: [diagnostic, terminate], executed };
}

interface Published {
  readonly type: ServiceEventType;
  readonly payload: unknown;
}

function baseDeps(ops: FakeOps, published: Published[] = []): ApprovalRuntimeDeps {
  const clock: Clock = { now: () => new Date().toISOString() };
  const log: ApprovalLog = { info() {}, warn() {}, error() {} };
  return {
    db: store.db,
    definitions: ops.definitions,
    clock,
    eventBus: {
      publish(type, payload) {
        published.push({ type, payload });
        return { id: String(published.length), type, payload, at: clock.now() } as never;
      },
    },
    getVaultRoot: () => null,
    log,
    env: {},
  };
}

function flipOneCharacter(hash: string): string {
  return `${hash.startsWith("a") ? "b" : "a"}${hash.slice(1)}`;
}

describe("startApprovalServices: shutdown refuses late decisions (wave-5 review)", () => {
  it("starts no execution after stop() has begun, and reports not ready", async () => {
    const ops = fakeOperations();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = ops.definitions[0] as OperationDefinition<EnabledOperation, unknown>;
    const holding = {
      ...first,
      async execute(_token: never, _payload: never, context: { idempotencyKey: string }) {
        ops.executed.push(context.idempotencyKey);
        await gate;
        return { kind: "executed" };
      },
    } as unknown as OperationDefinition<EnabledOperation, unknown>;
    const runtime = startApprovalServices({
      ...baseDeps(ops),
      definitions: [holding, ops.definitions[1] as never],
    });
    await runtime.recover();
    const one = runtime.services.test({}) as { proposalId: string };
    const oneFound = runtime.services.get(one.proposalId);
    if (oneFound.kind !== "found") throw new Error("expected found");
    await runtime.services.decide({
      proposalId: one.proposalId,
      decision: "approve",
      payloadHash: oneFound.payloadHash,
      via: "plugin",
    });
    expect(ops.executed).toHaveLength(1);

    const two = runtime.services.test({}) as { proposalId: string };
    const twoFound = runtime.services.get(two.proposalId);
    if (twoFound.kind !== "found") throw new Error("expected found");

    const stopped = runtime.stop();
    expect(runtime.services.ready).toBe(false);
    release();
    await stopped;
    const late = await runtime.services.decide({
      proposalId: two.proposalId,
      decision: "approve",
      payloadHash: twoFound.payloadHash,
      via: "plugin",
    });
    expect(late.outcome).not.toBe("decided");
    await runtime.settled();
    expect(ops.executed).toHaveLength(1);
    const after = runtime.services.get(two.proposalId);
    if (after.kind !== "found") throw new Error("expected found");
    expect(after.summary.state).toBe("pending");
  });
});

describe("startApprovalServices: the registry fails closed (Task 1, Test 4)", () => {
  it("throws when an enabled operation has no definition", () => {
    const ops = fakeOperations();
    expect(() =>
      startApprovalServices({ ...baseDeps(ops), definitions: [ops.definitions[0] as never] }),
    ).toThrow(/session\.force-terminate/);
  });

  it("throws when no definition is supplied at all", () => {
    expect(() =>
      startApprovalServices({ ...baseDeps(fakeOperations()), definitions: [] }),
    ).toThrow();
  });

  it("throws on a definition for an operation the classification does not enable", () => {
    const ops = fakeOperations();
    const stray = { ...ops.definitions[0], operation: "gmail.send" } as never;
    expect(() =>
      startApprovalServices({ ...baseDeps(ops), definitions: [...ops.definitions, stray] }),
    ).toThrow();
  });

  it("returns route-facing services with no terminate or execute function", () => {
    const runtime = startApprovalServices(baseDeps(fakeOperations()));
    expect(Object.keys(runtime.services).sort()).toEqual([
      "decide",
      "get",
      "ready",
      "snapshot",
      "test",
    ]);
    expect(Object.keys(runtime).sort()).toEqual([
      "engine",
      "recover",
      "services",
      "settled",
      "start",
      "stop",
    ]);
    expect(Object.keys(runtime.engine)).toEqual(["submit"]);
  });
});

describe("startApprovalServices: ready (Task 1, Test 5)", () => {
  it("is not ready until recovery has completed", async () => {
    const runtime = startApprovalServices(baseDeps(fakeOperations()));
    expect(runtime.services.ready).toBe(false);
    await runtime.recover();
    expect(runtime.services.ready).toBe(true);
    await runtime.stop();
  });

  it("stays not ready when recovery throws", async () => {
    const runtime = startApprovalServices(baseDeps(fakeOperations()));
    store.db.exec("DROP TABLE proposals");
    await runtime.recover().catch(() => undefined);
    expect(runtime.services.ready).toBe(false);
    await runtime.stop();
  });
});

describe("startApprovalServices: the test approval round trip (Task 1, Tests 1 and 2)", () => {
  it("raises a pending request, shows its view, and executes it exactly once on approval", async () => {
    const ops = fakeOperations();
    const published: Published[] = [];
    const runtime = startApprovalServices(baseDeps(ops, published));
    await runtime.recover();

    const raised = runtime.services.test({});
    expect("outcome" in raised && raised.outcome).toBe("proposed");
    const proposalId = (raised as { proposalId: string }).proposalId;

    const snapshot = runtime.services.snapshot();
    expect(snapshot.pending.map((entry) => entry.proposalId)).toEqual([proposalId]);

    const found = runtime.services.get(proposalId);
    expect(found.kind).toBe("found");
    if (found.kind !== "found") return;
    expect(found.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(found.view?.title).toBe("Test approval");
    expect(found.view?.destructive).toBe(false);

    const decided = await runtime.services.decide({
      proposalId,
      decision: "approve",
      payloadHash: found.payloadHash,
      via: "plugin",
    });
    expect(decided.outcome).toBe("decided");
    await runtime.settled();
    expect(ops.executed).toEqual([proposalId]);

    const again = await runtime.services.decide({
      proposalId,
      decision: "approve",
      payloadHash: found.payloadHash,
      via: "plugin",
    });
    expect(again.outcome).toBe("already-decided");
    await runtime.settled();
    expect(ops.executed).toHaveLength(1);

    const states = published
      .filter((event) => event.type === "approval.upserted")
      .map((event) => (event.payload as { approval: ApprovalSummary }).approval.state);
    expect(states).toContain("executing");
    expect(states.at(-1)).toBe("executed");

    const history = runtime.services.get(proposalId);
    if (history.kind !== "found") throw new Error("expected found");
    expect(history.view?.history.map((entry) => entry.event)).toEqual([
      "requested",
      "approved",
      "claimed",
      "executed",
    ]);
    await runtime.stop();
  });

  it("answers already-pending, not a second request, while one test approval is pending", async () => {
    const runtime = startApprovalServices(baseDeps(fakeOperations()));
    await runtime.recover();
    const first = runtime.services.test({}) as { outcome: string; proposalId: string };
    const second = runtime.services.test({}) as { outcome: string; proposalId: string };
    expect(first.outcome).toBe("proposed");
    expect(second.outcome).toBe("already-pending");
    expect(second.proposalId).toBe(first.proposalId);
    await runtime.stop();
  });

  it("refuses a decision whose hash differs by one character and leaves the request pending", async () => {
    const ops = fakeOperations();
    const runtime = startApprovalServices(baseDeps(ops));
    await runtime.recover();
    const raised = runtime.services.test({}) as { proposalId: string };
    const found = runtime.services.get(raised.proposalId);
    if (found.kind !== "found") throw new Error("expected found");
    const result = await runtime.services.decide({
      proposalId: raised.proposalId,
      decision: "approve",
      payloadHash: flipOneCharacter(found.payloadHash),
      via: "plugin",
    });
    expect(result.outcome).toBe("hash-mismatch");
    await runtime.settled();
    expect(ops.executed).toEqual([]);
    expect(runtime.services.snapshot().pending).toHaveLength(1);
    await runtime.stop();
  });

  it("records the decision channel: a decision from another client is shown as the other channel", async () => {
    const runtime = startApprovalServices(baseDeps(fakeOperations()));
    await runtime.recover();
    const raised = runtime.services.test({}) as { proposalId: string };
    const found = runtime.services.get(raised.proposalId);
    if (found.kind !== "found") throw new Error("expected found");
    await runtime.services.decide({
      proposalId: raised.proposalId,
      decision: "deny",
      payloadHash: found.payloadHash,
      via: "other",
    });
    const after = runtime.services.get(raised.proposalId);
    if (after.kind !== "found") throw new Error("expected found");
    expect(after.view?.record.decidedVia).toBe("other");
    await runtime.stop();
  });

  it("shortens, never lengthens, a requested lifetime", async () => {
    const runtime = startApprovalServices(baseDeps(fakeOperations()));
    await runtime.recover();
    const raised = runtime.services.test({ ttlMs: 60_000 }) as { proposalId: string };
    const found = runtime.services.get(raised.proposalId);
    if (found.kind !== "found") throw new Error("expected found");
    const lifetime = Date.parse(found.summary.expiresAt) - Date.parse(found.summary.createdAt);
    expect(lifetime).toBe(60_000);
    await runtime.stop();
  });

  it("answers not-found for an unknown id", async () => {
    const runtime = startApprovalServices(baseDeps(fakeOperations()));
    await runtime.recover();
    expect(runtime.services.get("0mfk1a2b3c4d5e6f7a8b9c999").kind).toBe("not-found");
    await runtime.stop();
  });
});

describe("the sweeper environment (Task 3, Test 4)", () => {
  it("uses the default between thirty and sixty seconds when nothing is set", () => {
    const value = resolveSweepIntervalMs({});
    expect(value).toBeGreaterThanOrEqual(30_000);
    expect(value).toBeLessThanOrEqual(60_000);
  });

  it("honours a positive integer within the bounds", () => {
    expect(resolveSweepIntervalMs({ CCC_APPROVAL_SWEEP_MS: "200" })).toBe(200);
    expect(resolveSweepIntervalMs({ CCC_APPROVAL_SWEEP_MS: "60000" })).toBe(60_000);
  });

  it.each(["", "abc", "0", "-5", "1.5", "1e3", "19", "60001", "99999999999", " 200"])(
    "falls back to the default for %j",
    (raw) => {
      expect(resolveSweepIntervalMs({ CCC_APPROVAL_SWEEP_MS: raw })).toBe(
        resolveSweepIntervalMs({}),
      );
    },
  );

  it("starts the sweeper with the resolved interval and an unref'd timer", async () => {
    const unref: boolean[] = [];
    const intervals: number[] = [];
    const runtime = startApprovalServices({
      ...baseDeps(fakeOperations()),
      env: { CCC_APPROVAL_SWEEP_MS: "250" },
      timers: {
        setInterval(_fn, ms) {
          intervals.push(ms);
          return { unref: () => void unref.push(true) };
        },
        clearInterval() {},
      },
    });
    runtime.start();
    expect(intervals).toEqual([250]);
    expect(unref).toEqual([true]);
    await runtime.stop();
  });
});

describe("the guarded test-lifetime override (Task 3, Test 5)", () => {
  const ENABLED = { CCC_ENABLE_TEST_OVERRIDES: "1" };

  function recordingLog(): ApprovalLog & { codes: string[] } {
    const codes: string[] = [];
    const record = (fields: Readonly<Record<string, unknown>>): void => {
      if (typeof fields.code === "string") codes.push(fields.code);
    };
    return { codes, info: record, warn: record, error: record };
  }

  it("applies a valid value only when the enabling flag is exactly 1", () => {
    const log = recordingLog();
    expect(resolveTestLifetimeMs({ ...ENABLED, CCC_APPROVAL_TEST_TTL_MS: "5000" }, log)).toBe(5000);
    expect(log.codes).toEqual([]);
    for (const flag of [undefined, "", "0", "true", "yes", "01"]) {
      const quiet = recordingLog();
      const env: NodeJS.ProcessEnv = { CCC_APPROVAL_TEST_TTL_MS: "5000" };
      if (flag !== undefined) env.CCC_ENABLE_TEST_OVERRIDES = flag;
      expect(resolveTestLifetimeMs(env, quiet)).toBeUndefined();
    }
  });

  it("ignores, with one fixed log code, a value that is not a positive integer or exceeds the default", () => {
    for (const raw of ["abc", "0", "-1", "1.5", "", "90000000"]) {
      const log = recordingLog();
      expect(
        resolveTestLifetimeMs({ ...ENABLED, CCC_APPROVAL_TEST_TTL_MS: raw }, log),
      ).toBeUndefined();
      expect(log.codes).toEqual(["test-ttl-override-ignored"]);
    }
  });

  it("says nothing when the flag is on but no value is set", () => {
    const log = recordingLog();
    expect(resolveTestLifetimeMs(ENABLED, log)).toBeUndefined();
    expect(log.codes).toEqual([]);
  });

  it("shortens only the test route's request: an enabled override gives the test approval that lifetime", async () => {
    const runtime = startApprovalServices({
      ...baseDeps(fakeOperations()),
      env: { ...ENABLED, CCC_APPROVAL_TEST_TTL_MS: "5000" },
    });
    await runtime.recover();
    const raised = runtime.services.test({}) as { proposalId: string };
    const found = runtime.services.get(raised.proposalId);
    if (found.kind !== "found") throw new Error("expected found");
    expect(Date.parse(found.summary.expiresAt) - Date.parse(found.summary.createdAt)).toBe(5000);
    await runtime.stop();
  });

  it("takes the shorter of the override and a requested lifetime", async () => {
    const runtime = startApprovalServices({
      ...baseDeps(fakeOperations()),
      env: { ...ENABLED, CCC_APPROVAL_TEST_TTL_MS: "5000" },
    });
    await runtime.recover();
    const raised = runtime.services.test({ ttlMs: 2000 }) as { proposalId: string };
    const found = runtime.services.get(raised.proposalId);
    if (found.kind !== "found") throw new Error("expected found");
    expect(Date.parse(found.summary.expiresAt) - Date.parse(found.summary.createdAt)).toBe(2000);
    await runtime.stop();
  });

  it("gives the default lifetime when the enabling flag is unset", async () => {
    const runtime = startApprovalServices({
      ...baseDeps(fakeOperations()),
      env: { CCC_APPROVAL_TEST_TTL_MS: "5000" },
    });
    await runtime.recover();
    const raised = runtime.services.test({}) as { proposalId: string };
    const found = runtime.services.get(raised.proposalId);
    if (found.kind !== "found") throw new Error("expected found");
    const lifetime = Date.parse(found.summary.expiresAt) - Date.parse(found.summary.createdAt);
    expect(lifetime).toBe(24 * 60 * 60 * 1000);
    await runtime.stop();
  });

  it("never touches the force-terminate request: its lifetime is its own", async () => {
    const ops = fakeOperations();
    const runtime = startApprovalServices({
      ...baseDeps(ops),
      env: { ...ENABLED, CCC_APPROVAL_TEST_TTL_MS: "5000" },
    });
    await runtime.recover();
    const outcome = runtime.engine.submit({
      operation: "session.force-terminate",
      subject: "run-1",
      requester: { kind: "dashboard", label: "Agent runs" },
      projectId: null,
      runId: null,
      reason: "r",
      payload: { runId: "run-1" },
    });
    if (outcome.kind !== "proposed") throw new Error("expected proposed");
    const found = runtime.services.get(outcome.proposalId);
    if (found.kind !== "found") throw new Error("expected found");
    expect(Date.parse(found.summary.expiresAt) - Date.parse(found.summary.createdAt)).toBe(
      15 * 60 * 1000,
    );
    await runtime.stop();
  });
});
