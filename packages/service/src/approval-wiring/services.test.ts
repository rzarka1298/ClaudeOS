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
import { type ApprovalRuntimeDeps, startApprovalServices } from "./services.js";

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
    store.db.exec("DROP TABLE proposals");
    const runtime = startApprovalServices(baseDeps(fakeOperations()));
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
