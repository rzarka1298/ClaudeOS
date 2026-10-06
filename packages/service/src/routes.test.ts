import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { APPROVAL_LIST_PATH, APPROVAL_TEST_PATH, SNAPSHOT_PATH } from "@ccc/domain";
import { applyMigrations, type OperationalStore, openStore } from "@ccc/operational-store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approvalRoutes } from "./approval-wiring/routes.js";
import {
  createFakeServices,
  requestOverSocket,
  startRouteHarness,
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
