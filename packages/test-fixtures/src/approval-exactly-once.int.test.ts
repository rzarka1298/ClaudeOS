import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLASSIFICATION, type DecideResponse, type ProposalId } from "@ccc/domain";
import { buildOperationRegistry } from "@ccc/service/approval";
import * as approvalEntry from "@ccc/service/approval";
import { afterEach, describe, expect, it } from "vitest";
import {
  addProductionRow,
  auditEvents,
  countAudit,
  createFakeConnector,
  createRigs,
  FAKE_CONNECTOR,
  type OpenedEngine,
  readExecutions,
} from "./approval-fixtures.js";

/**
 * Exactly-once under concurrency (plan 06-24 task 1, APPR-10, D-14, D-43,
 * T-06-04): the real engine over real file-backed SQLite, twenty callers at
 * once. The effect count is read from the operation's OWN counters (how many
 * times it applied an effect), never from the audit table alone.
 */

const rigs = createRigs();
afterEach(() => rigs.dispose());

const SERVICE_DIR = fileURLToPath(new URL("../../service", import.meta.url));

function tally(results: readonly DecideResponse[]): { decided: number; already: number } {
  return {
    decided: results.filter((result) => result.outcome === "decided").length,
    already: results.filter((result) => result.outcome === "already-decided").length,
  };
}

/** One shared expectation: the whole run left exactly one approval, one claim and one effect. */
function expectOneEffect(rig: OpenedEngine, id: ProposalId, op = rig.world.diagnostic): void {
  expect(op.executions).toBe(1);
  expect(op.applications).toBe(1);
  expect(op.effects).toEqual(new Set([id]));
  expect(op.tokens).toHaveLength(1);
  expect(auditEvents(rig.db, id)).toEqual(["requested", "approved", "claimed", "executed"]);
  expect(readExecutions(rig.db, id)).toHaveLength(1);
  expect(rig.store.get(id)?.state).toBe("executed");
  expect(rig.store.get(id)?.attempts).toBe(1);
}

describe("Test 2: twenty simultaneous approvals on one connection", () => {
  it.each([0, 15])(
    "yield one decision, one claim and one effect (claim facts take %i ms)",
    async (claimFactsDelayMs) => {
      const rig = rigs.start();
      rig.world.diagnostic.claimFactsDelayMs = claimFactsDelayMs;
      const id = rig.propose();
      const hash = rig.hashOf(id);

      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          rig.engine.decide({ proposalId: id, decision: "approve", payloadHash: hash, via: "plugin" }),
        ),
      );
      await rig.engine.settled();

      expect(tally(results)).toEqual({ decided: 1, already: 19 });
      for (const result of results) {
        if (result.outcome === "already-decided") {
          expect(["approved", "executing", "executed"]).toContain(result.state);
        }
      }
      expectOneEffect(rig, id);
      expect(countAudit(rig.db, id, "approved")).toBe(1);
      expect(countAudit(rig.db, id, "claimed")).toBe(1);
    },
  );
});

describe("Test 3: ten approvals on each of two database connections", () => {
  it("yield one approval, one claim and one effect in total", async () => {
    const first = rigs.start();
    const second = rigs.connect(first);
    const id = first.propose();
    // The second connection sees the committed row under the same hash.
    expect(second.hashOf(id)).toBe(first.hashOf(id));
    const hash = first.hashOf(id);

    const calls: Promise<DecideResponse>[] = [];
    for (let index = 0; index < 10; index += 1) {
      for (const rig of [first, second]) {
        calls.push(
          rig.engine.decide({ proposalId: id, decision: "approve", payloadHash: hash, via: "plugin" }),
        );
      }
    }
    const results = await Promise.all(calls);
    await Promise.all([first.engine.settled(), second.engine.settled()]);

    expect(tally(results)).toEqual({ decided: 1, already: 19 });
    expectOneEffect(first, id);
    expect(countAudit(first.db, id, "approved")).toBe(1);
    expect(countAudit(second.db, id, "claimed")).toBe(1);
  });

  it("serves the same final row to both connections", async () => {
    const first = rigs.start();
    const second = rigs.connect(first);
    const id = first.propose();
    await Promise.all([first.decide(id), second.decide(id)]);
    await Promise.all([first.engine.settled(), second.engine.settled()]);
    expect(first.store.get(id)?.state).toBe("executed");
    expect(second.store.get(id)).toEqual(first.store.get(id));
  });
});

describe("Test 4: a deny racing an approve", () => {
  it("resolves to exactly the first caller's decision, and the loser is told already-decided", async () => {
    const rig = rigs.start();
    const approveFirst = rig.propose();
    const denyFirst = rig.propose();
    const call = (id: string, decision: "approve" | "deny") =>
      rig.engine.decide({ proposalId: id, decision, payloadHash: rig.hashOf(id), via: "plugin" });

    const [won, lost] = await Promise.all([call(approveFirst, "approve"), call(approveFirst, "deny")]);
    expect(won.outcome).toBe("decided");
    expect(lost.outcome).toBe("already-decided");
    const [denied, late] = await Promise.all([call(denyFirst, "deny"), call(denyFirst, "approve")]);
    expect(denied.outcome).toBe("decided");
    expect(late).toEqual({ outcome: "already-decided", state: "denied" });
    await rig.engine.settled();

    expect(rig.store.get(approveFirst)?.state).toBe("executed");
    expect(rig.store.get(denyFirst)?.state).toBe("denied");
    expect(rig.world.diagnostic.effects).toEqual(new Set([approveFirst]));
    expect(rig.world.diagnostic.applications).toBe(1);
    expect(auditEvents(rig.db, denyFirst)).toEqual(["requested", "denied"]);
  });

  it("holds for twenty mixed calls in a fixed shuffle on two connections", async () => {
    for (const seed of [1, 7, 42]) {
      const first = rigs.start();
      const second = rigs.connect(first);
      const id = first.propose();
      const hash = first.hashOf(id);
      // A fixed linear-congruential shuffle, so a failure reproduces.
      let state = seed;
      const next = (): number => {
        state = (state * 1103515245 + 12345) % 2147483648;
        return state;
      };
      const plan = Array.from({ length: 20 }, (_, index) => ({
        decision: index % 2 === 0 ? ("approve" as const) : ("deny" as const),
        rig: index % 3 === 0 ? second : first,
        order: next(),
      })).sort((a, b) => a.order - b.order);

      const results = await Promise.all(
        plan.map((step) =>
          step.rig.engine.decide({ proposalId: id, decision: step.decision, payloadHash: hash, via: "plugin" }),
        ),
      );
      await Promise.all([first.engine.settled(), second.engine.settled()]);

      expect(tally(results)).toEqual({ decided: 1, already: 19 });
      const winner = plan[results.findIndex((result) => result.outcome === "decided")];
      const finalState = first.store.get(id)?.state;
      if (winner?.decision === "approve") {
        expect(finalState).toBe("executed");
        expect(first.world.diagnostic.applications).toBe(1);
      } else {
        expect(finalState).toBe("denied");
        expect(first.world.diagnostic.applications).toBe(0);
      }
      rigs.dispose();
    }
  });
});

describe("Test 5: the idempotency key", () => {
  it("is the proposal id on every call and is never regenerated", async () => {
    const rig = rigs.start();
    const id = rig.propose();
    await rig.decide(id);
    await rig.engine.settled();
    // Further decisions change nothing and call nothing.
    await rig.decide(id);
    await rig.decide(id, "deny");
    await rig.engine.settled();

    const op = rig.world.diagnostic;
    expect(op.calls).toEqual([{ kind: "execute", attempt: 1, key: id }]);
    const [token] = op.tokens;
    const row = rig.store.get(id);
    expect(token?.proposalId).toBe(id);
    expect(token?.operation).toBe("diagnostic.test");
    expect(token?.subject).toBe(row?.subject);
    // The token expires with the approval's age (five minutes), earlier than the request's own expiry.
    expect(token?.expiresAt).toBe(
      new Date(Date.parse(row?.approvedAt ?? "") + CLASSIFICATION["diagnostic.test"].maxApprovalAgeMs).toISOString(),
    );
    expect(op.effects).toEqual(new Set([id]));
  });
});

describe("Test 6: the ./approval export subpath", () => {
  it("exposes exactly the allowed names and no minter", () => {
    expect(Object.keys(approvalEntry).sort()).toEqual(
      [
        "DEFAULT_SWEEP_INTERVAL_MS",
        "PAYLOAD_RETENTION_MS",
        "buildOperationRegistry",
        "createApprovalEngine",
        "createExpirySweeper",
      ].sort(),
    );
    expect(Object.keys(approvalEntry).some((name) => /mint|token|ledger/i.test(name))).toBe(false);
  });

  it("is declared in the service manifest, pointing at the built nested project", () => {
    const manifest = JSON.parse(readFileSync(join(SERVICE_DIR, "package.json"), "utf8")) as {
      exports: Record<string, unknown>;
    };
    expect(manifest.exports["./approval"]).toEqual({
      types: "./dist/approval/index.d.ts",
      default: "./dist/approval/index.js",
    });
    // The main entry still boots the service and is unchanged.
    expect(manifest.exports["."]).toBe("./dist/main.js");
  });
});

/** Every non-test TypeScript file under a directory. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") && !path.includes(".test.") ? [path] : [];
  });
}

describe("Test 7: the Phase 7 contract is the operation definition alone (D-43)", () => {
  it("runs a connector defined only in the fixtures exactly once, with no engine change", async () => {
    const connector = createFakeConnector();
    const rig = rigs.start({ extraOperations: [connector.operation], table: connector.table });
    const requester = { kind: "connector" as const, label: "Fake connector" };

    // The registry built from the injected copy accepts the extra definition; the engine is unchanged.
    expect(rig.engine.submit({
      operation: FAKE_CONNECTOR,
      subject: "message-1",
      requester,
      projectId: null,
      runId: null,
      reason: "Send the fixture message.",
      payload: { note: "hello" },
    }).kind).toBe("proposed");
    const id = rig.store.list("pending", 10).find((row) => row.operation === FAKE_CONNECTOR)?.proposalId;
    expect(id).toBeDefined();
    if (id === undefined) return;

    // The SQL store classifies through the production table (T-06-15, defence in depth), so an
    // injected copy alone cannot make it decide the request: it refuses, and nothing runs.
    const refused = await rig.decide(id);
    expect(refused).toEqual({ outcome: "operation-reserved" });
    expect(connector.operation.executions).toBe(0);
    expect(rig.store.get(id)?.state).toBe("pending");

    // A later phase adds the row to the production table too; only then does the flow run.
    const restore = addProductionRow(FAKE_CONNECTOR, connector.row);
    try {
      const hash = rig.hashOf(id);
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          rig.engine.decide({ proposalId: id, decision: "approve", payloadHash: hash, via: "plugin" }),
        ),
      );
      await rig.engine.settled();
      expect(tally(results)).toEqual({ decided: 1, already: 19 });
    } finally {
      restore();
    }
    expect(Object.hasOwn(CLASSIFICATION, FAKE_CONNECTOR)).toBe(false);

    expectOneEffect(rig, id, connector.operation);
    const detail = rig.engine.get(id);
    expect(detail.kind).toBe("found");
    if (detail.kind === "found") {
      expect(detail.summary.requesterKind).toBe("connector");
      expect(detail.view?.requester.kind).toBe("connector");
      expect(detail.summary.operationLabel).toBe("Send a fake message");
    }
  });

  it("is rejected as unknown by an engine built with the production table", () => {
    const connector = createFakeConnector();
    const rig = rigs.start();
    const outcome = rig.engine.submit({
      operation: FAKE_CONNECTOR,
      subject: "message-1",
      requester: { kind: "connector", label: "Fake connector" },
      projectId: null,
      runId: null,
      reason: "Send the fixture message.",
      payload: {},
    });
    expect(outcome).toEqual({ kind: "rejected", reason: "operation-unknown" });
    // The registry builder refuses the definition against the production table too.
    expect(() => buildOperationRegistry([connector.operation.definition])).toThrow(
      /not in the classification table/,
    );
  });

  it("builds the production registry from the definitions argument only", () => {
    const calls: { file: string; args: string }[] = [];
    for (const file of sourceFiles(join(SERVICE_DIR, "src"))) {
      if (file.endsWith(join("approval", "registry.ts"))) continue;
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/buildOperationRegistry\(([^)]*)\)/g)) {
        calls.push({ file, args: (match[1] ?? "").trim() });
      }
    }
    // Not vacuous: the composition root's call site is found.
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.args, `${call.file} passes more than the definitions`).not.toContain(",");
      expect(call.args).not.toBe("");
    }
  });
});
