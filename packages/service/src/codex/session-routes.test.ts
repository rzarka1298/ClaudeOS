import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http, { type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_OPEN_TRANSCRIPT_PATH,
  CODEX_SESSIONS_PATH,
  type CodexSessionsSnapshot,
  CodexSessionsSnapshotSchema,
} from "@ccc/domain";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mintToken } from "../auth/token.js";
import { createEventBus } from "../events/event-bus.js";
import { logger } from "../logging.js";
import type { Handler, RouteContext } from "../route-kit.js";
import { type SessionRouteDeps, sessionRoutes } from "./session-routes.js";
import type { TranscriptOpenOutcome } from "./transcript-open.js";

const SECRET = Buffer.from("session-routes-test-secret-0123456789ab");
const dir = mkdtempSync(join(tmpdir(), "ccc-sr-"));
const socketPath = join(dir, "s");
const NOW = new Date(Date.UTC(2026, 9, 10, 12, 0, 0)).toISOString();
const DECOY_PATH = "/Users/USERNAME/.codex/sessions/2026/10/06/rollout-decoy-thread.jsonl";

const SNAPSHOT: CodexSessionsSnapshot = CodexSessionsSnapshotSchema.parse({
  kind: "available",
  sessions: [
    {
      threadId: "thread-a",
      projectId: null,
      projectName: null,
      origin: "interactive",
      state: "completed",
      model: null,
      effort: null,
      startedAt: NOW,
      lastActivityAt: NOW,
      resumesAfter: null,
      title: null,
      hasTranscript: true,
      liveLogRunId: null,
    },
  ],
  hiddenCount: 0,
  analysisOn: false,
  observedAt: NOW,
  freshness: "live",
  partiality: { partial: false },
});

const state = {
  snapshot: SNAPSHOT as unknown,
  afterPoll: SNAPSHOT as unknown,
  outcome: { ok: true } as TranscriptOpenOutcome,
  refreshes: 0,
  polls: 0,
  opened: [] as Array<{ threadId: string; via: string }>,
  present: true,
};

const deps: SessionRouteDeps = {
  mirror: {
    snapshot: () => state.snapshot as CodexSessionsSnapshot | null,
    refreshIfStale: () => {
      state.refreshes += 1;
    },
    pollNow: async () => {
      state.polls += 1;
      state.snapshot = state.afterPoll;
    },
  },
  opener: {
    open: async (input) => {
      state.opened.push({ threadId: input.threadId, via: input.via });
      return state.outcome;
    },
  },
};

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
  body?: string,
  token = true,
): Promise<{ status: number; body: unknown; raw: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path,
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
    req.end(body);
  });
}

const logged: string[] = [];

beforeAll(async () => {
  const table = sessionRoutes(() => (state.present ? deps : undefined));
  server = http.createServer(listener(table, ctx));
  await new Promise<void>((resolve) => server?.listen(socketPath, resolve));
  for (const level of ["info", "warn", "error", "debug"] as const) {
    vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
      logged.push(JSON.stringify(args));
    }) as never);
  }
});
afterEach(() => {
  state.snapshot = SNAPSHOT;
  state.afterPoll = SNAPSHOT;
  state.outcome = { ok: true };
  state.refreshes = 0;
  state.polls = 0;
  state.opened.length = 0;
  state.present = true;
});
afterAll(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  rmSync(dir, { recursive: true, force: true });
});

const OPEN_BODY = JSON.stringify({ threadId: "thread-a", via: "reveal" });

describe("Test 4: GET sessions", () => {
  it("answers 200 with the validated cached snapshot and starts a read-through", async () => {
    const reply = await request("GET", CODEX_SESSIONS_PATH);
    expect(reply.status).toBe(200);
    expect(CodexSessionsSnapshotSchema.parse(reply.body)).toEqual(SNAPSHOT);
    expect(state.refreshes).toBe(1);
    expect(state.polls).toBe(0);
  });

  it("polls once when no snapshot exists yet and answers 503 if there is still none", async () => {
    state.snapshot = null;
    state.afterPoll = SNAPSHOT;
    const first = await request("GET", CODEX_SESSIONS_PATH);
    expect(first.status).toBe(200);
    expect(state.polls).toBe(1);
    state.snapshot = null;
    state.afterPoll = null;
    const second = await request("GET", CODEX_SESSIONS_PATH);
    expect(second).toMatchObject({ status: 503, body: { error: "unavailable" } });
  });

  it("answers the constant 500 and never sends a snapshot that fails the domain schema", async () => {
    state.snapshot = {
      ...SNAPSHOT,
      sessions: [{ ...(SNAPSHOT as { sessions: object[] }).sessions[0], cwd: DECOY_PATH }],
    };
    const reply = await request("GET", CODEX_SESSIONS_PATH);
    expect(reply.status).toBe(500);
    expect(reply.raw).not.toContain(DECOY_PATH);
  });

  it("answers 503 with the constant body when the mirror dependency is absent, and 401 without a token", async () => {
    state.present = false;
    expect(await request("GET", CODEX_SESSIONS_PATH)).toMatchObject({
      status: 503,
      body: { error: "unavailable" },
    });
    state.present = true;
    expect((await request("GET", CODEX_SESSIONS_PATH, undefined, false)).status).toBe(401);
  });
});

describe("Test 4: POST open-transcript", () => {
  it("accepts the strict body and answers the constant ok", async () => {
    const reply = await request("POST", CODEX_OPEN_TRANSCRIPT_PATH, OPEN_BODY);
    expect(reply).toMatchObject({ status: 200, body: { ok: true } });
    expect(state.opened).toEqual([{ threadId: "thread-a", via: "reveal" }]);
  });

  it("answers an error body with exactly one code and the matching status", async () => {
    const cases: Array<[TranscriptOpenOutcome, number, string]> = [
      [{ ok: false, error: "not-found" }, 404, "not-found"],
      [{ ok: false, error: "outside-sessions-folder" }, 403, "outside-sessions-folder"],
      [{ ok: false, error: "failed" }, 500, "failed"],
      [{ ok: false, error: "unavailable" }, 503, "unavailable"],
    ];
    for (const [outcome, status, code] of cases) {
      state.outcome = outcome;
      const reply = await request("POST", CODEX_OPEN_TRANSCRIPT_PATH, OPEN_BODY);
      expect(reply).toMatchObject({ status, body: { error: code } });
      expect(Object.keys(reply.body as object)).toEqual(["error"]);
    }
  });

  it("answers the constant 400 for an extra key, a path-like key, a bad thread id or a malformed body", async () => {
    const bodies = [
      JSON.stringify({ threadId: "thread-a", via: "reveal", path: DECOY_PATH }),
      JSON.stringify({ threadId: "thread-a", via: "reveal", rolloutPath: DECOY_PATH }),
      JSON.stringify({ path: DECOY_PATH, via: "open" }),
      JSON.stringify({ threadId: "../etc/passwd", via: "open" }),
      JSON.stringify({ threadId: DECOY_PATH, via: "open" }),
      JSON.stringify({ threadId: "", via: "open" }),
      JSON.stringify({ threadId: "thread-a" }),
      JSON.stringify({ threadId: "thread-a", via: "edit" }),
      JSON.stringify([]),
      "not json",
      "",
    ];
    for (const body of bodies) {
      const reply = await request("POST", CODEX_OPEN_TRANSCRIPT_PATH, body);
      expect(reply).toMatchObject({ status: 400, body: { error: "invalid-request" } });
      expect(reply.raw).not.toContain(DECOY_PATH);
    }
    expect(state.opened).toHaveLength(0);
  });

  it("answers 503 without the mirror dependency and refuses an oversized body", async () => {
    state.present = false;
    expect(await request("POST", CODEX_OPEN_TRANSCRIPT_PATH, OPEN_BODY)).toMatchObject({
      status: 503,
      body: { error: "unavailable" },
    });
    state.present = true;
    const huge = JSON.stringify({ threadId: "thread-a", via: "open", pad: "x".repeat(20_000) });
    expect(await request("POST", CODEX_OPEN_TRANSCRIPT_PATH, huge)).toMatchObject({
      status: 400,
      body: { error: "invalid-request" },
    });
  });

  it("an opener that throws answers the constant 500 without its message", async () => {
    const original = deps.opener.open;
    (deps.opener as { open: unknown }).open = async () => {
      throw Object.assign(new Error(`failed on ${DECOY_PATH}`), { code: "ENOENT" });
    };
    try {
      const reply = await request("POST", CODEX_OPEN_TRANSCRIPT_PATH, OPEN_BODY);
      expect(reply.status).toBe(500);
      expect(reply.raw).not.toContain(DECOY_PATH);
    } finally {
      (deps.opener as { open: unknown }).open = original;
    }
  });
});

describe("the route table", () => {
  it("holds exactly GET sessions and POST open-transcript; other verbs reach the constant not-found", async () => {
    const table = sessionRoutes(() => deps);
    expect(Object.keys(table).sort()).toEqual(
      [CODEX_OPEN_TRANSCRIPT_PATH, CODEX_SESSIONS_PATH].sort(),
    );
    expect(Object.keys(table[CODEX_SESSIONS_PATH] ?? {})).toEqual(["GET"]);
    expect(Object.keys(table[CODEX_OPEN_TRANSCRIPT_PATH] ?? {})).toEqual(["POST"]);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(await request(method, CODEX_SESSIONS_PATH, "{}")).toEqual({
        status: 404,
        body: { error: "no such route" },
        raw: JSON.stringify({ error: "no such route" }),
      });
    }
    for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
      expect((await request(method, CODEX_OPEN_TRANSCRIPT_PATH)).status).toBe(404);
    }
  });
});

describe("Test 5: no path, rollout name or cwd in responses or logs; no write allowlist", () => {
  it("logged lines from the earlier requests carry no path", () => {
    const text = logged.join("\n");
    expect(text).not.toContain("/Users/");
    expect(text).not.toContain("rollout-");
  });

  it("the route and opener sources register no write allowlist and open no file", () => {
    for (const file of ["session-routes.ts", "transcript-open.ts"]) {
      const source = readFileSync(join(import.meta.dirname, file), "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      expect(source, file).not.toMatch(
        /node:fs|writeFile|appendFile|allowlist|ALLOWLIST|registerWrite|WRITE_ALLOW/,
      );
    }
  });
});
