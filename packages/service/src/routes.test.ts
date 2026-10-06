import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  APPROVAL_LIST_PATH,
  APPROVAL_RESPONSE_BUDGET_BYTES,
  APPROVAL_TEST_PATH,
  type ApprovalSummary,
  type ApprovalsSnapshot,
  fitApprovalsSnapshotToBudget,
  SNAPSHOT_PATH,
  SnapshotResponseSchema,
} from "@ccc/domain";
import { applyMigrations, type OperationalStore, openStore } from "@ccc/operational-store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approvalRoutes } from "./approval-wiring/routes.js";
import type { ProjectServices } from "./projects/project-routes.js";
import {
  createFakeServices,
  requestOverSocket,
  startRouteHarness,
  summary,
} from "./test-support/approval-fixtures.js";

let baseDir: string;
let store: OperationalStore;

beforeAll(() => {
  const base = join(homedir(), ".ccc-test");
  mkdirSync(base, { recursive: true });
  baseDir = mkdtempSync(join(base, "routes-store-"));
  store = openStore(join(baseDir, "operational.db"));
  applyMigrations(store.db);
});

afterAll(() => {
  store.close();
  rmSync(baseDir, { recursive: true, force: true });
});

describe("the one route table carries the approval routes (plan 06-13)", () => {
  it("serves the approval routes behind the token from the shared route table", async () => {
    const harness = await startRouteHarness(store, {
      approvals: createFakeServices() as never,
    });
    try {
      expect(Object.keys(approvalRoutes)).toContain(APPROVAL_LIST_PATH);
      const noToken = await requestOverSocket(harness.socketPath, {
        method: "GET",
        path: APPROVAL_LIST_PATH,
      });
      expect(noToken.status).toBe(401);
      const withToken = await requestOverSocket(harness.socketPath, {
        method: "GET",
        path: APPROVAL_LIST_PATH,
        token: harness.token,
      });
      expect(withToken.status).toBe(200);
      const test = await requestOverSocket(harness.socketPath, {
        method: "POST",
        path: APPROVAL_TEST_PATH,
        token: harness.token,
        body: {},
      });
      expect(test.status).toBe(200);
    } finally {
      await harness.close();
    }
  });

  it("keeps the existing snapshot route working with no approval services in the context", async () => {
    const harness = await startRouteHarness(store, {});
    try {
      const reply = await requestOverSocket<{ state: Record<string, unknown> }>(
        harness.socketPath,
        { method: "GET", path: SNAPSHOT_PATH, token: harness.token },
      );
      expect(reply.status).toBe(200);
      expect("approvals" in reply.body.state).toBe(false);
    } finally {
      await harness.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Task 2: the optional approvals member of the snapshot

const CAP = 64 * 1024;

function getSnapshot(harness: { socketPath: string; token: string }) {
  return requestOverSocket<{ lastEventId: number; state: Record<string, unknown> }>(
    harness.socketPath,
    { method: "GET", path: SNAPSHOT_PATH, token: harness.token },
  );
}

describe("snapshot approvals member (task 2 test 3)", () => {
  it("includes approvals when the context has approval services and omits it when it does not", async () => {
    const fake = createFakeServices();
    const withServices = await startRouteHarness(store, { approvals: fake as never });
    const without = await startRouteHarness(store, {});
    try {
      const present = await getSnapshot(withServices);
      expect(present.status).toBe(200);
      expect(present.body.state.approvals).toEqual(fake.script.snapshot);
      const absent = await getSnapshot(without);
      expect("approvals" in absent.body.state).toBe(false);
    } finally {
      await withServices.close();
      await without.close();
    }
  });

  it("reads the member in the same tick as the last event id", async () => {
    const fake = createFakeServices();
    const harness = await startRouteHarness(store, { approvals: fake as never });
    try {
      harness.eventBus.publish("service.heartbeat", {});
      harness.eventBus.publish("service.heartbeat", {});
      let idDuringRead = -1;
      const original = fake.snapshot.bind(fake);
      fake.snapshot = (budget?: number) => {
        idDuringRead = harness.eventBus.buffer.latestId();
        return original(budget);
      };
      const reply = await getSnapshot(harness);
      expect(idDuringRead).toBe(reply.body.lastEventId);
      // The next event is strictly after the snapshot's id: nothing is missed or doubled.
      expect(harness.eventBus.publish("service.heartbeat", {}).id).toBe(reply.body.lastEventId + 1);
    } finally {
      await harness.close();
    }
  });

  it("still parses with an old consumer's schema, with or without the member", async () => {
    const fake = createFakeServices();
    const withServices = await startRouteHarness(store, { approvals: fake as never });
    const without = await startRouteHarness(store, {});
    const legacy = SnapshotResponseSchema.shape.state.omit({ approvals: true });
    try {
      for (const harness of [withServices, without]) {
        const reply = await getSnapshot(harness);
        expect(legacy.safeParse(reply.body.state).success).toBe(true);
        expect(SnapshotResponseSchema.safeParse(reply.body).success).toBe(true);
      }
    } finally {
      await withServices.close();
      await without.close();
    }
  });

  it("reports the ready flag from the services", async () => {
    const fake = createFakeServices();
    fake.script.ready = false;
    const harness = await startRouteHarness(store, { approvals: fake as never });
    try {
      const reply = await getSnapshot(harness);
      expect((reply.body.state.approvals as ApprovalsSnapshot).ready).toBe(false);
      fake.script.ready = true;
      const again = await getSnapshot(harness);
      expect((again.body.state.approvals as ApprovalsSnapshot).ready).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("still serves the snapshot, without the member, when the approval services throw", async () => {
    const fake = createFakeServices();
    fake.script.snapshotThrows = true;
    const harness = await startRouteHarness(store, { approvals: fake as never });
    try {
      const reply = await getSnapshot(harness);
      expect(reply.status).toBe(200);
      expect("approvals" in reply.body.state).toBe(false);
    } finally {
      await harness.close();
    }
  });
});

describe("the whole snapshot stays under the client cap (task 2 test 5, T-06-30)", () => {
  /** Project services whose snapshot is large but synthetic: the route only serialises it. */
  function bigProjects(bytes: number): ProjectServices {
    const entry = { filler: "\u6f22".repeat(Math.floor(bytes / 3 / 20)) };
    return {
      snapshot: () =>
        ({ projects: Array.from({ length: 20 }, () => entry), launchers: [] }) as never,
      onRegistryChanged() {},
      refresh() {},
      homeDir: "/Users/USERNAME",
      runtimeDir: "/Users/USERNAME/.ccc",
    };
  }

  it("hands the services only the budget the rest of the snapshot leaves, in UTF-8 bytes", async () => {
    const fake = createFakeServices();
    const wide: ApprovalsSnapshot = {
      ready: true,
      pending: Array.from(
        { length: 50 },
        (_, i) =>
          summary(i + 1, "pending", {
            title: "\u6f22".repeat(120),
            projectName: "\u6f22".repeat(120),
            requesterLabel: "\u6f22".repeat(64),
            operationLabel: "\u6f22".repeat(80),
          }) as ApprovalSummary,
      ),
      decided: [],
      expired: [],
      counts: { pending: 50, decided: 0, expired: 0 },
      truncated: false,
    };
    // The services trim to whatever budget they are given, as the engine does.
    fake.snapshot = (budget?: number) => {
      fake.snapshotBudgets.push(budget);
      return fitApprovalsSnapshotToBudget(wide, budget ?? APPROVAL_RESPONSE_BUDGET_BYTES);
    };
    const harness = await startRouteHarness(store, {
      approvals: fake as never,
      projects: bigProjects(30 * 1024),
    });
    try {
      const reply = await getSnapshot(harness);
      expect(reply.status).toBe(200);
      const bytes = Buffer.byteLength(reply.raw, "utf8");
      expect(bytes).toBeLessThan(CAP);
      expect(fake.snapshotBudgets).toHaveLength(1);
      const budget = fake.snapshotBudgets[0] as number;
      expect(budget).toBeLessThan(APPROVAL_RESPONSE_BUDGET_BYTES);
      expect(budget).toBeGreaterThan(0);
      // The member was actually cut, and still reports true totals.
      const approvals = reply.body.state.approvals as ApprovalsSnapshot;
      expect(approvals.pending.length).toBeLessThan(50);
      expect(approvals.truncated).toBe(true);
      expect(approvals.counts.pending).toBe(50);
    } finally {
      await harness.close();
    }
  });

  it("uses the default budget when the rest of the snapshot is small", async () => {
    const fake = createFakeServices();
    const harness = await startRouteHarness(store, { approvals: fake as never });
    try {
      await getSnapshot(harness);
      expect(fake.snapshotBudgets).toEqual([APPROVAL_RESPONSE_BUDGET_BYTES]);
    } finally {
      await harness.close();
    }
  });
});
