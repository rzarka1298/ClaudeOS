import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  HANDSHAKE_PATH,
  TASK_CREATE_PATH,
  TaskCreateResponseSchema,
  type TaskErrorBody,
} from "@ccc/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFakeServices,
  type RouteHarness,
  requestOverSocket,
  startRouteHarness,
} from "../test-support/approval-fixtures.js";
import { makeServiceFixture, type ServiceFixture } from "../test-support/task-fixtures.js";
import { taskRoutes } from "./task-routes.js";
import { createTaskServices } from "./task-service.js";

const UNAUTHENTICATED = { error: "authentication required" };
const INVALID_BODY: TaskErrorBody = { error: "invalid-body" };
const UNAVAILABLE: TaskErrorBody = { error: "service-disconnected" };

let fx: ServiceFixture;
let harness: RouteHarness;
let approvals: ReturnType<typeof createFakeServices>;

beforeEach(async () => {
  fx = makeServiceFixture();
  approvals = createFakeServices();
  harness = await startRouteHarness(fx.store, {
    tasks: createTaskServices({ ...fx.deps, eventBus: fx.bus }),
    approvals: approvals as never,
  });
});

afterEach(async () => {
  await harness.close();
  fx.cleanup();
});

function call<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; rawBody?: string; token?: string | null } = {},
) {
  const token = opts.token === undefined ? harness.token : (opts.token ?? undefined);
  return requestOverSocket<T>(harness.socketPath, {
    method: opts.method ?? "POST",
    path,
    ...(opts.body === undefined ? {} : { body: opts.body }),
    ...(opts.rawBody === undefined ? {} : { rawBody: opts.rawBody }),
    ...(token === undefined ? {} : { token }),
  });
}

const VALID = { title: "Route created task", intent: "inbox", zone: "America/New_York" };

function noteCount(): number {
  return readdirSync(join(fx.vault.root, "global", "tasks")).filter((name) => name !== "index.md")
    .length;
}

describe("auth", () => {
  it("answers the create route without a valid bearer token with the shared 401 body", async () => {
    const none = await call(TASK_CREATE_PATH, { body: VALID, token: null });
    expect(none.status).toBe(401);
    expect(none.body).toEqual(UNAUTHENTICATED);
    const bad = await call(TASK_CREATE_PATH, { body: VALID, token: "not-a-token" });
    expect(bad.status).toBe(401);
    expect(bad.body).toEqual(UNAUTHENTICATED);
    expect(noteCount()).toBe(0);
  });

  it("registers every task route behind the token and never the handshake", () => {
    for (const [path, methods] of Object.entries(taskRoutes)) {
      expect(path).not.toBe(HANDSHAKE_PATH);
      for (const handler of Object.values(methods)) expect(typeof handler).toBe("function");
    }
    expect(Object.keys(taskRoutes)).toContain(TASK_CREATE_PATH);
  });
});

describe("no services", () => {
  it("answers 503 with a constant body and drains the request body", async () => {
    const bare = await startRouteHarness(fx.store, {});
    try {
      const big = JSON.stringify({ filler: "x".repeat(100 * 1024) });
      const reply = await requestOverSocket(bare.socketPath, {
        method: "POST",
        path: TASK_CREATE_PATH,
        token: bare.token,
        rawBody: big,
      });
      expect(reply.status).toBe(503);
      expect(reply.body).toEqual(UNAVAILABLE);
    } finally {
      await bare.close();
    }
  });
});

describe("create", () => {
  it("writes the note, answers 200 with the strict row and calls no approval function", async () => {
    const reply = await call(TASK_CREATE_PATH, { body: VALID });
    expect(reply.status).toBe(200);
    const parsed = TaskCreateResponseSchema.parse(reply.body);
    expect(parsed.task.title).toBe("Route created task");
    expect(noteCount()).toBe(1);
    expect(reply.raw).not.toContain(fx.vault.root);
    expect(approvals.decideCalls).toHaveLength(0);
    expect(approvals.testCalls).toHaveLength(0);
    expect(approvals.getCalls).toHaveLength(0);
    expect(approvals.snapshotBudgets).toHaveLength(0);
  });

  it("answers 400 with the constant invalid-body body and writes nothing for a bad body", async () => {
    const bodies: unknown[] = [
      { ...VALID, extra: true },
      { intent: "inbox", zone: "America/New_York" },
      { ...VALID, title: "x".repeat(201) },
      { ...VALID, intent: "proposed" },
      { ...VALID, intent: "later" },
      { ...VALID, zone: "Not/AZone" },
      { ...VALID, id: "0mfk1a2b3c4d5e6f7a8b9c000" },
      { ...VALID, status: "done" },
      { ...VALID, path: "global/tasks/x.md" },
      { ...VALID, dueTime: "10:00" },
    ];
    for (const body of bodies) {
      const reply = await call(TASK_CREATE_PATH, { body });
      expect(reply.status).toBe(400);
      expect(reply.body).toEqual(INVALID_BODY);
    }
    const notJson = await call(TASK_CREATE_PATH, { rawBody: "{not json" });
    expect(notJson.status).toBe(400);
    expect(notJson.body).toEqual(INVALID_BODY);
    expect(noteCount()).toBe(0);
  });

  it("answers vault-not-set-up when no vault root is registered", async () => {
    fx.setVaultRoot(null);
    const reply = await call(TASK_CREATE_PATH, { body: VALID });
    expect(reply.status).toBe(409);
    expect(reply.body).toEqual({ error: "vault-not-set-up" });
  });

  it("answers invalid-scope for a workspace that does not exist", async () => {
    const reply = await call(TASK_CREATE_PATH, {
      body: { ...VALID, scope: "workspace:0000000000000000000000000" },
    });
    expect(reply.status).toBe(400);
    expect(reply.body).toEqual({ error: "invalid-scope" });
  });

  it("answers write-failed with a constant body that names no path or title", async () => {
    rmSync(join(fx.vault.root, "global", "tasks"), { recursive: true, force: true });
    writeFileSync(join(fx.vault.root, "global", "tasks"), "in the way");
    const reply = await call(TASK_CREATE_PATH, { body: { ...VALID, title: "Secret title text" } });
    expect(reply.status).toBe(500);
    expect(reply.body).toEqual({ error: "write-failed" });
    expect(reply.raw).not.toContain("Secret title text");
    expect(reply.raw).not.toContain(fx.vault.root);
  });
});
