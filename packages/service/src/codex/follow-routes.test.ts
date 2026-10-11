import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http, { type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_FOLLOW_LOG_PATH, CODEX_OPEN_TRANSCRIPT_PATH } from "@ccc/domain";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mintToken } from "../auth/token.js";
import { createEventBus } from "../events/event-bus.js";
import type { Handler, RouteContext } from "../route-kit.js";
import type { FollowResult } from "./follow-log.js";
import { type FollowRouteDeps, followRoutes } from "./follow-routes.js";

const SECRET = Buffer.from("follow-routes-test-secret-0123456789abc");
const dir = mkdtempSync(join(tmpdir(), "ccc-fr-"));
const socketPath = join(dir, "s");
const RUN_ID = "20261010T120000123Z";

const state = {
  result: { ok: true } as FollowResult,
  throwWith: null as Error | null,
  calls: [] as Array<{ runId: string; aborted: boolean }>,
  present: true,
};

const follow = vi.fn(async (input: { runId: string; signal?: AbortSignal }) => {
  state.calls.push({ runId: input.runId, aborted: input.signal?.aborted ?? false });
  if (state.throwWith !== null) throw state.throwWith;
  return state.result;
});
const deps: FollowRouteDeps = { follow: { follow } };

function listener(table: Record<string, Record<string, Handler>>, ctx: RouteContext) {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    const path = new URL(req.url ?? "", "http://localhost").pathname;
    const handler = table[path]?.[req.method ?? "GET"];
    if (!handler) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "no such route" }));
      return;
    }
    handler(req, res, ctx);
  };
}

const ctx = {
  store: {},
  getSecret: () => SECRET,
  eventBus: createEventBus(),
} as unknown as RouteContext;

let server: Server | null = null;

function request(
  method: string,
  path: string,
  body?: unknown,
  token = true,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        socketPath,
        path,
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${mintToken(SECRET, { nowMs: Date.now() })}` } : {}),
          ...(payload === undefined
            ? {}
            : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            body: raw.length > 0 ? JSON.parse(raw) : undefined,
          });
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

beforeAll(() => {
  const table = followRoutes(() => (state.present ? deps : undefined));
  server = http.createServer(listener(table, ctx));
  return new Promise<void>((resolve) => server?.listen(socketPath, resolve));
});
afterEach(() => {
  state.result = { ok: true };
  state.throwWith = null;
  state.calls = [];
  state.present = true;
  follow.mockClear();
});
afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  rmSync(dir, { recursive: true, force: true });
});

describe("follow-log route (D-29, CODEX-07)", () => {
  it("answers the constant { ok: true } and hands the service the run id only", async () => {
    const reply = await request("POST", CODEX_FOLLOW_LOG_PATH, { runId: RUN_ID });
    expect(reply).toEqual({ status: 200, body: { ok: true } });
    expect(state.calls).toEqual([{ runId: RUN_ID, aborted: false }]);
  });

  it("maps every service error to its fixed status and constant body", async () => {
    const table: Array<[FollowResult, number, string]> = [
      [{ ok: false, error: "not-found" }, 404, "not-found"],
      [{ ok: false, error: "run-ended" }, 409, "run-ended"],
      [{ ok: false, error: "bridge-not-installed" }, 409, "bridge-not-installed"],
      [{ ok: false, error: "window-not-ready" }, 409, "window-not-ready"],
      [{ ok: false, error: "failed" }, 500, "failed"],
    ];
    for (const [result, status, code] of table) {
      state.result = result;
      const reply = await request("POST", CODEX_FOLLOW_LOG_PATH, { runId: RUN_ID });
      expect(reply, code).toEqual({ status, body: { error: code } });
    }
  });

  it("refuses a path, rollout, log, argv or any extra key with the constant invalid-request body, before any lookup", async () => {
    const bad: unknown[] = [
      {},
      { runId: "../../etc/passwd" },
      { runId: "/Users/USERNAME/.planning/codex/live/x.log" },
      { runId: "20261010T120000123" },
      { runId: 20261010 },
      { runId: RUN_ID, path: "/tmp/x.log" },
      { runId: RUN_ID, liveLog: "/tmp/x.log" },
      { runId: RUN_ID, rolloutPath: "/tmp/r.jsonl" },
      { runId: RUN_ID, argv: ["codex"] },
      { runId: RUN_ID, cwd: "/tmp" },
      { runId: [RUN_ID] },
      { log: "/tmp/x.log" },
      "20261010T120000123Z",
      [RUN_ID],
      null,
    ];
    for (const body of bad) {
      const reply = await request("POST", CODEX_FOLLOW_LOG_PATH, body);
      expect(reply, JSON.stringify(body)).toEqual({
        status: 400,
        body: { error: "invalid-request" },
      });
    }
    expect(follow).not.toHaveBeenCalled();
  });

  it("refuses a malformed and an oversize body", async () => {
    const reply = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(
        {
          socketPath,
          path: CODEX_FOLLOW_LOG_PATH,
          method: "POST",
          headers: { authorization: `Bearer ${mintToken(SECRET, { nowMs: Date.now() })}` },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
        },
      );
      req.on("error", reject);
      req.end("{not json");
    });
    expect(reply.status).toBe(400);
    const big = await request("POST", CODEX_FOLLOW_LOG_PATH, {
      runId: RUN_ID,
      pad: "x".repeat(10_000),
    });
    expect(big).toEqual({ status: 400, body: { error: "invalid-request" } });
    expect(follow).not.toHaveBeenCalled();
  });

  it("is POST only: GET, PUT, PATCH and DELETE answer the router's constant not-found", async () => {
    for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
      expect(await request(method, CODEX_FOLLOW_LOG_PATH)).toEqual({
        status: 404,
        body: { error: "no such route" },
      });
    }
    expect(follow).not.toHaveBeenCalled();
  });

  it("answers the constant 503 when the Codex services are absent and refuses an unauthenticated request", async () => {
    state.present = false;
    expect(await request("POST", CODEX_FOLLOW_LOG_PATH, { runId: RUN_ID })).toEqual({
      status: 503,
      body: { error: "unavailable" },
    });
    state.present = true;
    const unauthenticated = await request("POST", CODEX_FOLLOW_LOG_PATH, { runId: RUN_ID }, false);
    expect(unauthenticated.status).toBe(401);
    expect(follow).not.toHaveBeenCalled();
  });

  it("answers a constant 500 for a service that throws, never naming the error", async () => {
    state.throwWith = new Error("boom /Users/USERNAME/.planning/codex/live/secret.log");
    const reply = await request("POST", CODEX_FOLLOW_LOG_PATH, { runId: RUN_ID });
    expect(reply.status).toBe(500);
    expect(JSON.stringify(reply.body)).not.toContain("/Users/");
    expect(JSON.stringify(reply.body)).not.toContain("secret");
  });

  it("the route table has exactly one path with one POST entry and does not touch the open-transcript route", () => {
    const table = followRoutes(() => deps);
    expect(Object.keys(table)).toEqual([CODEX_FOLLOW_LOG_PATH]);
    expect(Object.keys(table[CODEX_FOLLOW_LOG_PATH] ?? {})).toEqual(["POST"]);
    expect(table[CODEX_OPEN_TRANSCRIPT_PATH]).toBeUndefined();
  });

  it("the route source starts no process, sends no signal and reads no file", () => {
    const source = readFileSync(join(import.meta.dirname, "follow-routes.ts"), "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    expect(source).not.toMatch(/child_process|\bspawn\b|execFile|node:fs|process\.kill|SIGINT/);
  });
});
