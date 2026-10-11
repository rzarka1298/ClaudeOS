import { mkdtempSync, rmSync } from "node:fs";
import http, { type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_HOOK_EVENTS_PATH } from "@ccc/domain";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mintToken } from "../auth/token.js";
import { createEventBus } from "../events/event-bus.js";
import { logger } from "../logging.js";
import type { Handler, RouteContext } from "../route-kit.js";
import { HOOK_DECOYS, hookRecord } from "../test-support/codex-hook-kit.js";
import { type HookRouteDeps, hookRoutes } from "./hook-routes.js";

const SECRET = Buffer.from("hook-routes-test-secret-0123456789abcd");
const dir = mkdtempSync(join(tmpdir(), "ccc-hr-"));
const socketPath = join(dir, "s");

type Outcome = Awaited<ReturnType<HookRouteDeps["ingest"]>>;
const state = {
  outcome: "applied" as Outcome,
  throws: false,
  present: true,
  received: [] as Array<{ input: unknown; via: string }>,
};

const deps: HookRouteDeps = {
  ingest: async (input, via) => {
    state.received.push({ input, via });
    if (state.throws) throw new Error(`boom ${HOOK_DECOYS.cwd}`);
    return state.outcome;
  },
};

function listener(table: Record<string, Record<string, Handler>>, ctx: RouteContext) {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    const path = new URL(req.url ?? "", "http://localhost").pathname;
    const handler = table[path]?.[req.method ?? "GET"];
    if (!handler) {
      req.resume();
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
const logged: string[] = [];

function request(
  method: string,
  body?: string,
  token = true,
): Promise<{ status: number; raw: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path: CODEX_HOOK_EVENTS_PATH,
        method,
        headers: token
          ? {
              authorization: `Bearer ${mintToken(SECRET, { nowMs: Date.now() })}`,
              "content-type": "application/json",
            }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, raw: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

beforeAll(async () => {
  const table = hookRoutes(() => (state.present ? deps : undefined));
  server = http.createServer(listener(table, ctx));
  await new Promise<void>((resolve) => server?.listen(socketPath, resolve));
  for (const level of ["info", "warn", "error", "debug"] as const) {
    vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
      logged.push(JSON.stringify(args));
    }) as never);
  }
});
afterEach(() => {
  state.outcome = "applied";
  state.throws = false;
  state.present = true;
  state.received.length = 0;
  logged.length = 0;
});
afterAll(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  rmSync(dir, { recursive: true, force: true });
});

describe("Test 8: the Codex hook ingest route", () => {
  it("answers 202 with the constant body for applied, duplicate, unknown and shape-invalid records", async () => {
    for (const outcome of ["applied", "duplicate", "unknown-event", "shape-invalid"] as const) {
      state.outcome = outcome;
      const reply = await request("POST", JSON.stringify(hookRecord()));
      expect(reply).toEqual({ status: 202, raw: JSON.stringify({ accepted: true }) });
    }
    expect(state.received.every((entry) => entry.via === "socket")).toBe(true);
  });

  it("answers the constant 400 for an envelope-invalid outcome, a non-JSON body, a non-object and an oversize body", async () => {
    state.outcome = "envelope-invalid";
    const invalid = JSON.stringify({ error: "invalid request body" });
    expect(await request("POST", JSON.stringify(hookRecord()))).toEqual({
      status: 400,
      raw: invalid,
    });
    state.outcome = "applied";
    expect(await request("POST", "{not json")).toEqual({ status: 400, raw: invalid });
    expect(await request("POST", "[]")).toEqual({ status: 400, raw: invalid });
    expect(await request("POST", '"text"')).toEqual({ status: 400, raw: invalid });
    const big = JSON.stringify({ ...hookRecord(), filler: "a".repeat(9 * 1024) });
    expect(await request("POST", big)).toEqual({ status: 400, raw: invalid });
    expect(state.received).toHaveLength(1);
  });

  it("is POST only and refuses a request without a bearer token before the handler", async () => {
    for (const method of ["GET", "PUT", "DELETE"]) {
      const reply = await request(method, undefined);
      expect(reply.status).toBe(404);
      expect(JSON.parse(reply.raw)).toEqual({ error: "no such route" });
    }
    const unauth = await request("POST", JSON.stringify(hookRecord()), false);
    expect(unauth.status).toBe(401);
    expect(state.received).toHaveLength(0);
  });

  it("answers the constant 503 when the Codex services are absent", async () => {
    state.present = false;
    expect(await request("POST", JSON.stringify(hookRecord()))).toEqual({
      status: 503,
      raw: JSON.stringify({ error: "unavailable" }),
    });
  });

  it("answers the constant 500 when ingest throws and echoes nothing", async () => {
    state.throws = true;
    const reply = await request("POST", JSON.stringify(hookRecord({ cwd: HOOK_DECOYS.cwd })));
    expect(reply).toEqual({ status: 500, raw: JSON.stringify({ error: "internal error" }) });
    expect(reply.raw).not.toContain("DECOY");
  });

  it("leaks no record value or event name through a response or a log line", async () => {
    const record = hookRecord({
      hook_event_name: "SessionEnd",
      cwd: HOOK_DECOYS.cwd,
      model: HOOK_DECOYS.model,
      session_id: "thread-decoy-not-real",
    });
    const replies = [
      await request("POST", JSON.stringify(record)),
      await request("POST", JSON.stringify({ ...record, prompt: HOOK_DECOYS.prompt })),
      await request("POST", `{"cwd":"${HOOK_DECOYS.cwd}", broken`),
    ];
    state.throws = true;
    replies.push(await request("POST", JSON.stringify(record)));
    const all = JSON.stringify([replies, logged]);
    for (const value of [
      HOOK_DECOYS.cwd,
      HOOK_DECOYS.model,
      HOOK_DECOYS.prompt,
      "thread-decoy-not-real",
      "SessionEnd",
      record.eventId,
    ]) {
      expect(all).not.toContain(value);
    }
  });
});
