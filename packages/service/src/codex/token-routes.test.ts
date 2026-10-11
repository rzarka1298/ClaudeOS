import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import http, { type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_TOKEN_ACTIVITY_PATH,
  type CodexTokenSummary,
  CodexTokenSummarySchema,
} from "@ccc/domain";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mintToken } from "../auth/token.js";
import { createEventBus } from "../events/event-bus.js";
import { logger } from "../logging.js";
import type { Handler, RouteContext } from "../route-kit.js";
import { type TokenRouteDeps, tokenRoutes } from "./token-routes.js";

const SECRET = Buffer.from("token-routes-test-secret-0123456789abc");
const dir = mkdtempSync(join(tmpdir(), "ccc-tr-"));
const socketPath = join(dir, "s");
const NOW = new Date(Date.UTC(2026, 9, 10, 12, 0, 0)).toISOString();
/** The UI-SPEC billing expression: no response member or word may match it. */
const BILLING =
  /\b(cost|price[sd]?|pricing|bill(ed|ing|s)?|charge[sd]?|spend|spent|credits?|dollars?|usd|invoice|paid|pay)\b|\$/i;

const COUNTERS = {
  input: 10,
  cachedInput: 4,
  cacheWrite: 0,
  output: 5,
  reasoningOutput: 2,
  total: 21,
};

function available(
  range: "today" | "last-7-days" | "this-month",
): CodexTokenSummary["ranges"]["today"] {
  return {
    kind: "available",
    range,
    bounds: { start: "2026-10-10T00:00:00.000Z", end: NOW },
    totals: COUNTERS,
    observedAt: NOW,
    source: "codex-session-logs",
    freshness: "live",
    partiality: { partial: false },
    coverage: { horizonDate: null, uncoveredDays: 0, analysisOffDays: 0 },
  };
}

const READY: CodexTokenSummary = CodexTokenSummarySchema.parse({
  ranges: {
    today: available("today"),
    "last-7-days": available("last-7-days"),
    "this-month": available("this-month"),
  },
  firstScanPending: false,
  observedAt: NOW,
});

function unavailable(reason: "analysis-off" | "first-scan-pending"): CodexTokenSummary {
  const range = { kind: "unavailable" as const, reason, version: null };
  return CodexTokenSummarySchema.parse({
    ranges: { today: range, "last-7-days": range, "this-month": range },
    firstScanPending: reason === "first-scan-pending",
    observedAt: NOW,
  });
}

const state = {
  summary: READY as unknown,
  refreshes: 0,
  scans: 0,
  present: true,
};

const deps: TokenRouteDeps = {
  summary: () => state.summary as CodexTokenSummary,
  refreshIfStale: () => {
    state.refreshes += 1;
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

function request(
  method: string,
  token = true,
): Promise<{ status: number; body: unknown; raw: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path: CODEX_TOKEN_ACTIVITY_PATH,
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
            raw,
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const logged: string[] = [];

beforeAll(async () => {
  const table = tokenRoutes(() => (state.present ? deps : undefined));
  server = http.createServer(listener(table, ctx));
  await new Promise<void>((resolve) => server?.listen(socketPath, resolve));
  for (const level of ["info", "warn", "error", "debug"] as const) {
    vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
      logged.push(JSON.stringify(args));
    }) as never);
  }
});
afterEach(() => {
  state.summary = READY;
  state.refreshes = 0;
  state.scans = 0;
  state.present = true;
  logged.length = 0;
});
afterAll(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  rmSync(dir, { recursive: true, force: true });
});

describe("Test 1: GET token-activity", () => {
  it("answers 200 with the three-range summary validated against the domain schema", async () => {
    const reply = await request("GET");
    expect(reply.status).toBe(200);
    const parsed = CodexTokenSummarySchema.parse(reply.body);
    expect(parsed).toEqual(READY);
    expect(Object.keys(parsed.ranges)).toEqual(["today", "last-7-days", "this-month"]);
  });

  it("answers 401 without a token", async () => {
    expect((await request("GET", false)).status).toBe(401);
  });

  it("answers 503 with the constant body when the dependency is absent", async () => {
    state.present = false;
    const reply = await request("GET");
    expect(reply.status).toBe(503);
    expect(reply.body).toEqual({ error: "unavailable" });
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("answers not-found for %s", async (method) => {
    expect((await request(method)).status).toBe(404);
  });

  it("requests a read-through while the first scan is pending and not when analysis is off", async () => {
    state.summary = unavailable("first-scan-pending");
    expect((await request("GET")).status).toBe(200);
    expect(state.refreshes).toBe(1);

    state.summary = unavailable("analysis-off");
    expect((await request("GET")).status).toBe(200);
    expect(state.refreshes).toBe(1);
  });

  it("refuses to send a summary that fails the schema and logs only a reason code", async () => {
    state.summary = { ...READY, cost: 1.5 };
    const reply = await request("GET");
    expect(reply.status).toBe(500);
    expect(reply.raw).not.toContain("cost");
    const lines = logged.join("\n");
    expect(lines).toContain("invalid-output");
    expect(lines).not.toContain("1.5");
  });
});

describe("Test 2: no billing, price, cost or path member", () => {
  it("the response carries no key or string matching the billing expression, and no path or title", async () => {
    const reply = await request("GET");
    const seen: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value !== null && typeof value === "object") {
        for (const [key, inner] of Object.entries(value)) {
          seen.push(key);
          walk(inner);
        }
      } else if (typeof value === "string") seen.push(value);
    };
    walk(reply.body);
    for (const text of seen) expect(text).not.toMatch(BILLING);
    for (const key of seen) expect(key).not.toMatch(/path|title|cwd|account|email/i);
  });

  it("the route source contains no billing word", () => {
    const source = readFileSync(join(__dirname, "token-routes.ts"), "utf8");
    expect(source).not.toMatch(BILLING);
  });
});

describe("Test 3: analysis off means no read at all", () => {
  it("answers analysis-off for every range and never asks the scanner for a read-through", async () => {
    state.summary = unavailable("analysis-off");
    const reply = await request("GET");
    const body = CodexTokenSummarySchema.parse(reply.body);
    for (const range of Object.values(body.ranges)) {
      expect(range).toMatchObject({ kind: "unavailable", reason: "analysis-off" });
    }
    expect(state.refreshes).toBe(0);
  });
});

describe("Test 4: the whole-folder audit of non-test Codex sources", () => {
  const files = readdirSync(__dirname)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => ({ name, source: readFileSync(join(__dirname, name), "utf8") }));

  it("finds the Codex sources", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("imports no network client", () => {
    for (const { name, source } of files) {
      expect(source, name).not.toMatch(/from "node:(https|net|tls|dgram|http2)"/);
      expect(source, name).not.toMatch(/\bfetch\(|new WebSocket\(|undici|axios/);
    }
  });

  it("spawns a process only in the two files that take an injected spawner", () => {
    const spawners = files
      .filter(({ source }) => /from "node:child_process"/.test(source))
      .map(({ name }) => name)
      .sort();
    expect(spawners).toEqual(["doctor-probe.ts", "rate-limits-client.ts"]);
    for (const { name, source } of files) {
      if (spawners.includes(name)) continue;
      expect(source, name).not.toMatch(/\b(spawn|exec|execFile|fork)Sync?\(/);
    }
  });

  it("names no rollout path in a log call", () => {
    for (const { name, source } of files) {
      const calls = source.match(/logger\.(info|warn|error|debug)\([\s\S]*?\);/g) ?? [];
      for (const call of calls) {
        expect(call, name).not.toMatch(/\b(path|rolloutPath|ref\.path|cwd)\b\s*[:,}]/);
        expect(call, name).not.toMatch(/\$\{[^}]*path[^}]*\}/i);
      }
    }
  });
});
