import {
  TASK_ATTENTION_PATH,
  TASK_CHANGED_PATH,
  TASK_COUNTS_PATH,
  TASK_CREATE_PATH,
  TASK_DUE_TODAY_PATH,
  TASK_ERROR_CODES,
  TASK_GET_PATH,
  TASK_LIST_PATH,
  TASK_REBUILD_PATH,
} from "@ccc/domain";
import { describe, expect, it } from "vitest";
import type { SocketApiClient, SocketRequestOptions, SocketResponse } from "./socket-api-client.js";
import { SocketUnreachableError } from "./socket-api-client.js";
import { createTasksClient, TaskRequestError } from "./tasks-client.js";

/**
 * The tasks client (plan 06-20, task 3): one typed, validated client over the
 * eight fixed routes. A fake `SocketApiClient` stands in for the transport, so
 * this file proves request shapes, outgoing validation and the mapping from a
 * response or a transport failure onto a closed code that carries no socket
 * path and no message text.
 */

const ID = "0mfk1a2b3c4d5e6f7a8b9c001";
const ZONE = "America/New_York";

const ROW = {
  id: ID,
  title: "A task",
  status: "ready",
  scope: "global",
  tags: [],
  tagCount: 0,
  unmetDependencies: 0,
  overdue: false,
  updatedAt: "2026-10-07T12:00:00.000Z",
};

function recording(status: number, body: unknown) {
  const calls: SocketRequestOptions[] = [];
  const client: SocketApiClient = {
    request: <T>(opts: SocketRequestOptions) => {
      calls.push(opts);
      return Promise.resolve({ status, body } as SocketResponse<T>);
    },
  };
  return { client, calls };
}

function failing(error: unknown): SocketApiClient {
  return { request: () => Promise.reject(error) };
}

function unreachable(errno: string): SocketUnreachableError {
  return new SocketUnreachableError(
    "/Users/USERNAME/private/socket.sock",
    Object.assign(new Error(`connect failed ${errno}`), { code: errno }),
  );
}

describe("Test 9 (client): request shapes", () => {
  it("posts each request to its fixed path with the parsed body and returns the parsed response", async () => {
    const cases: readonly {
      path: string;
      body: unknown;
      response: unknown;
      call: (client: ReturnType<typeof createTasksClient>) => Promise<unknown>;
    }[] = [
      {
        path: TASK_CREATE_PATH,
        body: { title: "A task", intent: "inbox", zone: ZONE },
        response: { task: ROW },
        call: (c) => c.create({ title: "A task", intent: "inbox", zone: ZONE }),
      },
      {
        path: TASK_LIST_PATH,
        body: { context: { scope: "all" }, filter: "today", zone: ZONE },
        response: { rows: [ROW], total: 1, nextCursor: null, chooseProject: false },
        call: (c) => c.list({ context: { scope: "all" }, filter: "today", zone: ZONE }),
      },
      {
        path: TASK_COUNTS_PATH,
        body: { context: { scope: "all" }, zone: ZONE },
        response: {
          counts: {
            all: 1,
            today: 0,
            upcoming: 0,
            overdue: 0,
            project: 0,
            proposed: 0,
            blocked: 0,
            completed: 0,
          },
          open: 1,
        },
        call: (c) => c.counts({ context: { scope: "all" }, zone: ZONE }),
      },
      {
        path: TASK_GET_PATH,
        body: { taskId: ID },
        response: {
          task: {
            row: ROW,
            path: "global/tasks/a-task-00000001.md",
            createdAt: "2026-10-07T12:00:00.000Z",
            sourceType: "manual",
            blockedBy: [],
            aiGenerated: false,
            confidence: "unverified",
          },
        },
        call: (c) => c.get({ taskId: ID }),
      },
      {
        path: TASK_CHANGED_PATH,
        body: { paths: ["global/tasks/a-task-00000001.md"] },
        response: { accepted: 1, generation: 5 },
        call: (c) => c.changed({ paths: ["global/tasks/a-task-00000001.md"] }),
      },
      {
        path: TASK_REBUILD_PATH,
        body: {},
        response: { tasks: 3, attention: 1 },
        call: (c) => c.rebuild(),
      },
      {
        path: TASK_ATTENTION_PATH,
        body: {},
        response: { items: [], total: 0, nextCursor: null },
        call: (c) => c.attention(),
      },
      {
        path: TASK_DUE_TODAY_PATH,
        body: { zone: ZONE },
        response: { due: [], overdue: [] },
        call: (c) => c.dueToday({ zone: ZONE }),
      },
    ];
    for (const entry of cases) {
      const { client, calls } = recording(200, entry.response);
      const result = await entry.call(createTasksClient(client));
      expect(calls).toHaveLength(1);
      expect(calls[0]?.method).toBe("POST");
      expect(calls[0]?.path).toBe(entry.path);
      expect(calls[0]?.body).toEqual(entry.body);
      expect(result).toEqual(entry.response);
    }
  });
});

describe("Test 9 (client): outgoing validation", () => {
  it("throws before any request for an extra key, a bad zone or a bad path", async () => {
    const { client, calls } = recording(200, {});
    const tasks = createTasksClient(client);
    const bad: (() => Promise<unknown>)[] = [
      () => tasks.create({ title: "x", intent: "inbox", zone: ZONE, extra: 1 } as never),
      () => tasks.create({ title: "x", intent: "proposed", zone: ZONE } as never),
      () => tasks.create({ title: "x", intent: "inbox", zone: "Not/AZone" }),
      () => tasks.list({ context: { scope: "all" }, filter: "nope", zone: ZONE } as never),
      () => tasks.get({ taskId: "short" }),
      () => tasks.changed({ paths: ["../outside.md"] }),
      () => tasks.changed({}),
      () => tasks.dueToday({ zone: ZONE, path: "x" } as never),
    ];
    for (const run of bad) {
      await expect(run()).rejects.toMatchObject({ name: "TaskRequestError", code: "invalid-body" });
    }
    expect(calls).toHaveLength(0);
  });
});

describe("Test 9 (client): failures map to closed codes", () => {
  it("maps a timeout to timeout and any other transport failure to service-disconnected, naming no path", async () => {
    const timeout = await createTasksClient(failing(unreachable("ETIMEDOUT")))
      .rebuild()
      .catch((e: unknown) => e);
    expect(timeout).toBeInstanceOf(TaskRequestError);
    expect((timeout as TaskRequestError).code).toBe("timeout");
    const refused = await createTasksClient(failing(unreachable("ECONNREFUSED")))
      .rebuild()
      .catch((e: unknown) => e);
    expect((refused as TaskRequestError).code).toBe("service-disconnected");
    for (const error of [timeout, refused] as TaskRequestError[]) {
      expect(error.message).toBe(error.code);
      expect(String(error.stack)).not.toContain("/Users/USERNAME");
      expect(JSON.stringify(error)).not.toContain("socket.sock");
    }
  });

  it("maps a non-200 closed error body to its code and anything else to unrecognised-response", async () => {
    for (const code of TASK_ERROR_CODES) {
      const { client } = recording(409, { error: code });
      await expect(createTasksClient(client).rebuild()).rejects.toMatchObject({
        code,
        status: 409,
      });
    }
    for (const body of [
      { error: "invalid request body" },
      { error: "internal error" },
      {},
      "nope",
      null,
    ]) {
      const { client } = recording(500, body);
      await expect(createTasksClient(client).rebuild()).rejects.toMatchObject({
        code: "unrecognised-response",
        status: 500,
      });
    }
    const extra = recording(400, { error: "not-found", message: "/Users/USERNAME/x" });
    await expect(createTasksClient(extra.client).rebuild()).rejects.toMatchObject({
      code: "unrecognised-response",
    });
  });

  it("maps a 200 body that fails its schema to unrecognised-response", async () => {
    const { client } = recording(200, { tasks: "three", attention: 0 });
    await expect(createTasksClient(client).rebuild()).rejects.toMatchObject({
      code: "unrecognised-response",
      status: 200,
    });
    const extra = recording(200, { tasks: 1, attention: 0, extra: true });
    await expect(createTasksClient(extra.client).rebuild()).rejects.toMatchObject({
      code: "unrecognised-response",
    });
  });
});
