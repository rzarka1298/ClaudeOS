import { readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  HANDSHAKE_PATH,
  TASK_ATTENTION_PATH,
  TASK_CHANGED_PATH,
  TASK_COUNTS_PATH,
  TASK_CREATE_PATH,
  TASK_DUE_TODAY_PATH,
  TASK_GET_PATH,
  TASK_LIST_PATH,
  TASK_REBUILD_PATH,
  TaskAttentionResponseSchema,
  TaskChangedResponseSchema,
  TaskCountsResponseSchema,
  TaskCreateResponseSchema,
  TaskDueTodayResponseSchema,
  type TaskErrorBody,
  TaskGetResponseSchema,
  TaskListResponseSchema,
  TaskRebuildResponseSchema,
} from "@ccc/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFakeServices,
  type RouteHarness,
  requestOverSocket,
  startRouteHarness,
} from "../test-support/approval-fixtures.js";
import {
  makeServiceFixture,
  noteId,
  type ServiceFixture,
  seedTasks,
  taskRecord,
} from "../test-support/task-fixtures.js";
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

// ---------------------------------------------------------------------------
// Task 2: list, counts, get, due-today and attention

const ZONE_BODY = { zone: "America/New_York" };
const READ_ROUTES: readonly { path: string; body: unknown }[] = [
  { path: TASK_LIST_PATH, body: { context: { scope: "all" }, filter: "all", ...ZONE_BODY } },
  { path: TASK_COUNTS_PATH, body: { context: { scope: "all" }, ...ZONE_BODY } },
  { path: TASK_GET_PATH, body: { taskId: noteId(1) } },
  { path: TASK_DUE_TODAY_PATH, body: ZONE_BODY },
  { path: TASK_ATTENTION_PATH, body: {} },
];

describe("read routes: auth, absence and shape (Test 8)", () => {
  it("answers every read route without a valid token with the shared 401 body", async () => {
    for (const route of READ_ROUTES) {
      const none = await call(route.path, { body: route.body, token: null });
      expect(none.status).toBe(401);
      expect(none.body).toEqual(UNAUTHENTICATED);
    }
  });

  it("registers every read route", () => {
    for (const route of READ_ROUTES) expect(Object.keys(taskRoutes)).toContain(route.path);
  });

  it("answers 503 with a constant body and drains a large body on every read route", async () => {
    const bare = await startRouteHarness(fx.store, {});
    try {
      const big = JSON.stringify({ filler: "x".repeat(100 * 1024) });
      for (const route of READ_ROUTES) {
        const reply = await requestOverSocket(bare.socketPath, {
          method: "POST",
          path: route.path,
          token: bare.token,
          rawBody: big,
        });
        expect(reply.status).toBe(503);
        expect(reply.body).toEqual(UNAVAILABLE);
      }
    } finally {
      await bare.close();
    }
  });

  it("rejects an extra key, bad JSON and a bad zone with the constant invalid-body body", async () => {
    for (const route of READ_ROUTES) {
      const extra = await call(route.path, { body: { ...(route.body as object), extra: 1 } });
      expect(extra.status).toBe(400);
      expect(extra.body).toEqual(INVALID_BODY);
      const notJson = await call(route.path, { rawBody: "{nope" });
      expect(notJson.status).toBe(400);
      expect(notJson.body).toEqual(INVALID_BODY);
    }
    const badZone = await call(TASK_LIST_PATH, {
      body: { context: { scope: "all" }, filter: "all", zone: "Not/AZone" },
    });
    expect(badZone.status).toBe(400);
    expect(badZone.body).toEqual(INVALID_BODY);
    const noZone = await call(TASK_COUNTS_PATH, { body: { context: { scope: "all" } } });
    expect(noZone.status).toBe(400);
  });
});

describe("read routes: answers", () => {
  it("lists a page and pages on with the cursor", async () => {
    seedTasks(
      fx.store,
      Array.from({ length: 30 }, (_, i) => taskRecord(100 + i)),
    );
    const ok = await call(TASK_LIST_PATH, { body: READ_ROUTES[0]?.body });
    expect(ok.status).toBe(200);
    const page = TaskListResponseSchema.parse(ok.body);
    expect(page.rows).toHaveLength(25);
    expect(page.total).toBe(30);
    const next = await call(TASK_LIST_PATH, {
      body: { ...(READ_ROUTES[0]?.body as object), cursor: page.nextCursor },
    });
    expect(TaskListResponseSchema.parse(next.body).rows).toHaveLength(5);
    expect(ok.raw).not.toContain(fx.vault.root);
  });

  it("answers invalid-cursor with 400 and the closed code", async () => {
    const reply = await call(TASK_LIST_PATH, {
      body: { ...(READ_ROUTES[0]?.body as object), cursor: "bad" },
    });
    expect(reply.status).toBe(400);
    expect(reply.body).toEqual({ error: "invalid-cursor" });
    const attention = await call(TASK_ATTENTION_PATH, { body: { cursor: "bad" } });
    expect(attention.status).toBe(400);
    expect(attention.body).toEqual({ error: "invalid-cursor" });
  });

  it("answers counts, get, due-today and attention in their schemas; unknown get is 404 not-found", async () => {
    seedTasks(fx.store, [taskRecord(1, { due: "2026-10-07" }), taskRecord(2)]);
    const counts = await call(TASK_COUNTS_PATH, { body: READ_ROUTES[1]?.body });
    expect(TaskCountsResponseSchema.parse(counts.body).counts.all).toBe(2);
    const get = await call(TASK_GET_PATH, { body: { taskId: noteId(1) } });
    expect(TaskGetResponseSchema.parse(get.body).task.row.id).toBe(noteId(1));
    const missing = await call(TASK_GET_PATH, { body: { taskId: noteId(99) } });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: "not-found" });
    const feed = await call(TASK_DUE_TODAY_PATH, { body: ZONE_BODY });
    expect(TaskDueTodayResponseSchema.parse(feed.body)).toBeDefined();
    const attention = await call(TASK_ATTENTION_PATH, { body: {} });
    expect(TaskAttentionResponseSchema.parse(attention.body).total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Task 3: changed and rebuild

describe("changed and rebuild routes", () => {
  it("registers exactly the eight task routes and none that could create a proposed task", () => {
    expect(Object.keys(taskRoutes).sort()).toEqual(
      [
        TASK_CREATE_PATH,
        TASK_LIST_PATH,
        TASK_COUNTS_PATH,
        TASK_GET_PATH,
        TASK_DUE_TODAY_PATH,
        TASK_ATTENTION_PATH,
        TASK_CHANGED_PATH,
        TASK_REBUILD_PATH,
      ].sort(),
    );
    for (const path of Object.keys(taskRoutes)) expect(path).not.toMatch(/propos/i);
    const source = readFileSync(join(import.meta.dirname, "task-routes.ts"), "utf8");
    expect(source).not.toMatch(/createProposedTask|startupWalk/);
  });

  it("requires a token, drains the body on 503 and refuses bad bodies with the constant body", async () => {
    for (const path of [TASK_CHANGED_PATH, TASK_REBUILD_PATH]) {
      const none = await call(path, { body: {}, token: null });
      expect(none.status).toBe(401);
      expect(none.body).toEqual(UNAUTHENTICATED);
    }
    const bare = await startRouteHarness(fx.store, {});
    try {
      const big = JSON.stringify({ filler: "x".repeat(200 * 1024) });
      for (const path of [TASK_CHANGED_PATH, TASK_REBUILD_PATH]) {
        const reply = await requestOverSocket(bare.socketPath, {
          method: "POST",
          path,
          token: bare.token,
          rawBody: big,
        });
        expect(reply.status).toBe(503);
        expect(reply.body).toEqual(UNAVAILABLE);
      }
    } finally {
      await bare.close();
    }
    for (const body of [
      {},
      { paths: [] },
      { rescan: false },
      { paths: ["../x.md"] },
      { paths: ["global/tasks/a.md"], extra: 1 },
      { paths: Array.from({ length: 201 }, (_, i) => `global/tasks/n-${i}.md`) },
    ]) {
      const reply = await call(TASK_CHANGED_PATH, { body });
      expect(reply.status).toBe(400);
      expect(reply.body).toEqual(INVALID_BODY);
    }
    const extraRebuild = await call(TASK_REBUILD_PATH, { body: { force: true } });
    expect(extraRebuild.status).toBe(400);
    expect(extraRebuild.body).toEqual(INVALID_BODY);
  });

  it("applies a changed note, answers the accepted count and the generation, and writes nothing back", async () => {
    const created = await call<{ task: { id: string } }>(TASK_CREATE_PATH, { body: VALID });
    const dir = join(fx.vault.root, "global", "tasks");
    const name = readdirSync(dir).find((n) => n !== "index.md") as string;
    const abs = join(dir, name);
    const text = readFileSync(abs, "utf8");
    writeFileSync(abs, text.replace("status: inbox", "status: done"));
    const edited = readFileSync(abs, "utf8");
    const reply = await call(TASK_CHANGED_PATH, { body: { paths: [`global/tasks/${name}`] } });
    expect(reply.status).toBe(200);
    expect(TaskChangedResponseSchema.parse(reply.body).accepted).toBe(1);
    expect(readFileSync(abs, "utf8")).toBe(edited);
    const get = await call(TASK_GET_PATH, { body: { taskId: created.body.task.id } });
    expect(TaskGetResponseSchema.parse(get.body).task.row.status).toBe("done");
  });

  it("answers invalid-path with the closed code when every named path is refused", async () => {
    const outside = join(fx.vault.root, "..", "outside-route.md");
    writeFileSync(outside, "not a task");
    symlinkSync(outside, join(fx.vault.root, "global", "tasks", "evil.md"));
    const reply = await call(TASK_CHANGED_PATH, { body: { paths: ["global/tasks/evil.md"] } });
    expect(reply.status).toBe(400);
    expect(reply.body).toEqual({ error: "invalid-path" });
    expect(reply.raw).not.toContain(fx.vault.root);
  });

  it("rebuilds and answers the counts; with no vault it answers vault-not-set-up", async () => {
    await call(TASK_CREATE_PATH, { body: VALID });
    const reply = await call(TASK_REBUILD_PATH, { body: {} });
    expect(reply.status).toBe(200);
    expect(TaskRebuildResponseSchema.parse(reply.body)).toEqual({ tasks: 1, attention: 0 });
    fx.setVaultRoot(null);
    const none = await call(TASK_REBUILD_PATH, { body: {} });
    expect(none.status).toBe(409);
    expect(none.body).toEqual({ error: "vault-not-set-up" });
  });
});
