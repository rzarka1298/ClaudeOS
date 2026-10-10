import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http, { type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_HEADROOM_PATH,
  CODEX_USAGE_PATH,
  CodexUsageSnapshotSchema,
  HeadroomSignalSchema,
} from "@ccc/domain";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mintToken } from "../auth/token.js";
import { createEventBus } from "../events/event-bus.js";
import type { Handler, RouteContext } from "../route-kit.js";
import { headroomRoutes } from "./headroom-routes.js";
import type { HeadroomService } from "./headroom-service.js";

const SECRET = Buffer.from("headroom-routes-test-secret-0123456789ab");
const dir = mkdtempSync(join(tmpdir(), "ccc-hr-"));
const socketPath = join(dir, "s");
const NOW = new Date(Date.UTC(2026, 9, 10, 12, 0, 0)).toISOString();

const USAGE = CodexUsageSnapshotSchema.parse({
  kind: "available",
  windows: [{ windowMinutes: 10_080, usedPercent: 41, resetsAt: null, limitLabel: null }],
  ordinaryUsageAllowed: true,
  rateLimitReached: false,
  rateLimitReachedType: null,
  source: "app-server",
  observedAt: NOW,
  freshness: "live",
});
const SIGNAL = HeadroomSignalSchema.parse({
  generatedAt: NOW,
  codex: {
    verdict: "allow",
    reason: null,
    worstWindow: { windowMinutes: 10_080, usedPercent: 41, resetsAt: null },
    source: "app-server",
    observedAt: NOW,
    freshness: "live",
    pausedRuns: { count: 0, earliestResetAt: null },
  },
  claude: { kind: "unavailable", reason: "no-report-yet" },
});

const service: Pick<HeadroomService, "getUsage" | "getHeadroom"> = {
  getUsage: async () => USAGE,
  getHeadroom: async () => SIGNAL,
};

/** The router's lookup and constant not-found body, mirrored from `createRequestListener`. */
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
let present = true;

function startServer(): Promise<void> {
  const table = headroomRoutes(() => (present ? service : undefined));
  server = http.createServer(listener(table, ctx));
  return new Promise((resolve) => server?.listen(socketPath, resolve));
}

function request(
  method: string,
  path: string,
  token = true,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path,
        method,
        headers: token
          ? { authorization: `Bearer ${mintToken(SECRET, { nowMs: Date.now() })}` }
          : {},
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
    req.end();
  });
}

beforeAll(startServer);
afterEach(() => {
  present = true;
});
afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  rmSync(dir, { recursive: true, force: true });
});

describe("headroom routes (D-04, CODEX-12)", () => {
  it("Test 8a: GET answers 200 with the parsed usage and headroom", async () => {
    const usage = await request("GET", CODEX_USAGE_PATH);
    expect(usage.status).toBe(200);
    expect(CodexUsageSnapshotSchema.parse(usage.body)).toEqual(USAGE);
    const headroom = await request("GET", CODEX_HEADROOM_PATH);
    expect(headroom.status).toBe(200);
    expect(HeadroomSignalSchema.parse(headroom.body)).toEqual(SIGNAL);
  });

  it("Test 8b: a request without a token is refused", async () => {
    expect((await request("GET", CODEX_USAGE_PATH, false)).status).toBe(401);
  });

  it("Test 8c: without the Codex services both answer 503 with the constant body", async () => {
    present = false;
    for (const path of [CODEX_USAGE_PATH, CODEX_HEADROOM_PATH]) {
      const reply = await request("GET", path);
      expect(reply).toEqual({ status: 503, body: { error: "unavailable" } });
    }
  });

  it("Test 8d: POST, PUT, PATCH and DELETE answer the constant not-found on both paths", async () => {
    for (const path of [CODEX_USAGE_PATH, CODEX_HEADROOM_PATH]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        expect(await request(method, path)).toEqual({
          status: 404,
          body: { error: "no such route" },
        });
      }
    }
  });

  it("Test 8e: the route table holds only GET entries for exactly the two paths", () => {
    const table = headroomRoutes(() => service);
    expect(Object.keys(table).sort()).toEqual([CODEX_HEADROOM_PATH, CODEX_USAGE_PATH].sort());
    for (const verbs of Object.values(table)) expect(Object.keys(verbs)).toEqual(["GET"]);
  });

  it("Test 8f: the route and service sources reach nothing that launches, spawns or writes", () => {
    for (const file of ["headroom-routes.ts", "headroom-service.ts", "route-support.ts"]) {
      const source = readFileSync(join(import.meta.dirname, file), "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      expect(source, file).not.toMatch(
        /child_process|\bspawn\b|execFile|node:fs|writeFile|appendFile|\blaunch|dispatch|rankAgent|consume/i,
      );
    }
  });
});
