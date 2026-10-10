import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CODEX_API_BASE,
  CODEX_DOCTOR_PATH,
  CODEX_FOLLOW_LOG_PATH,
  CODEX_HEADROOM_PATH,
  CODEX_HOOK_EVENTS_PATH,
  CODEX_INTEGRATION_PATH,
  CODEX_OPEN_TRANSCRIPT_PATH,
  CODEX_SESSIONS_PATH,
  CODEX_TOKEN_ACTIVITY_PATH,
  CODEX_USAGE_PATH,
  CodexDoctorSummarySchema,
  CodexIntegrationStatusSchema,
  type CodexSessionsSnapshot,
  CodexSessionsSnapshotSchema,
  CodexTokenSummarySchema,
} from "@ccc/domain";
import { saveLauncherConfig } from "@ccc/operational-store";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CodexComposition,
  codexHomeWithThreads,
  startCodexComposition,
} from "../test-support/codex-composition.js";
import { weeklyReply } from "../test-support/fake-codex-app-server.js";
import {
  doctorReport,
  readFakeDoctorStarts,
  writeFakeDoctor,
} from "../test-support/fake-codex-doctor.js";
import { type CodexRouteDeps, codexRouteTable, codexSnapshotFor } from "./routes.js";

/**
 * Plan 05.1-28: the composed Codex route table has exactly nine paths with their
 * documented verbs; none dispatches work, ranks agents, consumes credits or
 * writes Codex configuration (CODEX-12, T-05.1-25), and the router answers its
 * constant not-found for every other verb.
 */

const NO_ROUTE = { error: "no such route" };

const READ_ONLY_PATHS = [
  CODEX_HEADROOM_PATH,
  CODEX_USAGE_PATH,
  CODEX_SESSIONS_PATH,
  CODEX_TOKEN_ACTIVITY_PATH,
  CODEX_INTEGRATION_PATH,
] as const;
const POST_ONLY_PATHS = [
  CODEX_DOCTOR_PATH,
  CODEX_OPEN_TRANSCRIPT_PATH,
  CODEX_FOLLOW_LOG_PATH,
  CODEX_HOOK_EVENTS_PATH,
] as const;
const ALL_PATHS = [...READ_ONLY_PATHS, ...POST_ONLY_PATHS] as const;

let composition: CodexComposition | null = null;

afterEach(async () => {
  await composition?.close();
  composition = null;
});

async function compose(): Promise<CodexComposition> {
  composition = await startCodexComposition({
    appServer: { read: { kind: "result", result: weeklyReply(41) } },
  });
  return composition;
}

describe("the Codex route table (CODEX-12, T-05.1-25)", () => {
  it("Test 3: holds exactly the nine paths, all under the Codex base path, with their documented verbs", () => {
    const keys = Object.keys(codexRouteTable).sort();
    expect(keys).toEqual([...ALL_PATHS].sort());
    for (const key of keys) expect(key.startsWith(`${CODEX_API_BASE}/`)).toBe(true);
    for (const path of READ_ONLY_PATHS) {
      expect(Object.keys(codexRouteTable[path] ?? {})).toEqual(["GET"]);
    }
    for (const path of POST_ONLY_PATHS) {
      expect(Object.keys(codexRouteTable[path] ?? {})).toEqual(["POST"]);
    }
  });

  it("Test 3: no path or verb names dispatch, routing, ranking, credits or resuming", () => {
    for (const key of Object.keys(codexRouteTable)) {
      expect(key).not.toMatch(/dispatch|route|rank|credit|resume|consume|recommend|assign/i);
    }
  });

  it("Test 3: every other verb on every Codex path is the router's constant not-found", async () => {
    const c = await compose();
    for (const path of ALL_PATHS) {
      for (const method of ["PUT", "DELETE", "PATCH"]) {
        const reply = await c.request(method, path, {});
        expect(reply, `${method} ${path}`).toEqual({ status: 404, body: NO_ROUTE });
      }
    }
    for (const path of READ_ONLY_PATHS) {
      const reply = await c.request("POST", path, {});
      expect(reply, `POST ${path}`).toEqual({ status: 404, body: NO_ROUTE });
    }
    for (const path of POST_ONLY_PATHS) {
      const reply = await c.request("GET", path);
      expect(reply, `GET ${path}`).toEqual({ status: 404, body: NO_ROUTE });
    }
  });

  it("Test 3: a POST to the GET-only usage and headroom paths is the router's constant 404", async () => {
    const c = await compose();
    for (const path of [CODEX_USAGE_PATH, CODEX_HEADROOM_PATH]) {
      expect(await c.request("POST", path, {})).toEqual({ status: 404, body: NO_ROUTE });
    }
    // The read-only routes never run a handler for a POST, so nothing was spawned.
    expect(c.appServerStarts()).toBe(0);
  });

  it("Test 6: unauthenticated requests to every Codex path are refused before any handler runs", async () => {
    const c = await compose();
    for (const path of READ_ONLY_PATHS) {
      const reply = await c.get(path, { token: null });
      expect(reply.status, `GET ${path}`).toBe(401);
    }
    for (const path of POST_ONLY_PATHS) {
      const reply = await c.post(path, {}, { token: null });
      expect(reply.status, `POST ${path}`).toBe(401);
    }
    expect(c.appServerStarts()).toBe(0);
  });

  it("the table source builds each route file from a dependency getter on ctx.codex only", () => {
    const source = readFileSync(fileURLToPath(new URL("./routes.ts", import.meta.url)), "utf8");
    expect(source).toMatch(/ctx\.codex\?\.headroom/);
    expect(source).toMatch(/ctx\.codex\?\.sessions/);
    expect(source).toMatch(/ctx\.codex\?\.tokens/);
    expect(source).toMatch(/ctx\.codex\?\.doctor/);
    expect(source).toMatch(/ctx\.codex\?\.hooks/);
    expect(source).toMatch(/ctx\.codex\?\.follow/);
    expect(source).toMatch(/ctx\.codex\?\.integration/);
  });
});

// ---------------------------------------------------------------------------
// Task 2: the full route set through the composed services

const SESSION_A = "thread-route-aaaa1111";
const SESSION_B = "thread-route-bbbb2222";

async function composeWithThreads(
  extra: Partial<Parameters<typeof startCodexComposition>[0]> = {},
): Promise<CodexComposition> {
  const now = Date.now();
  composition = await startCodexComposition({
    appServer: { read: { kind: "result", result: weeklyReply(41) } },
    home: codexHomeWithThreads(
      [
        { id: SESSION_A, agoMs: 2 * 60_000, lifecycle: [["task_started", 90_000]] },
        {
          id: SESSION_B,
          agoMs: 3 * 3_600_000,
          lifecycle: [
            ["task_started", 3 * 3_600_000 + 5000],
            ["task_complete", 3 * 3_600_000],
          ],
        },
      ],
      now,
    ),
    ...extra,
  });
  return composition;
}

describe("the composed Codex routes (Task 2)", () => {
  it("Test 1: GET sessions answers the strict snapshot and no path", async () => {
    const c = await composeWithThreads();
    const reply = await c.get(CODEX_SESSIONS_PATH);
    expect(reply.status).toBe(200);
    const snapshot = CodexSessionsSnapshotSchema.parse(reply.body);
    expect(snapshot.kind).toBe("available");
    if (snapshot.kind !== "available") throw new Error("unreachable");
    expect(snapshot.sessions.map((s) => s.threadId).sort()).toEqual([SESSION_A, SESSION_B].sort());
    expect(JSON.stringify(reply.body)).not.toContain("/Users/");
    expect(JSON.stringify(reply.body)).not.toContain("rollout-");
  });

  it("Test 1: GET token-activity answers the strict summary, analysis off", async () => {
    const c = await composeWithThreads();
    const reply = await c.get(CODEX_TOKEN_ACTIVITY_PATH);
    expect(reply.status).toBe(200);
    const summary = CodexTokenSummarySchema.parse(reply.body);
    for (const range of Object.values(summary.ranges)) {
      expect(range.kind).toBe("unavailable");
      if (range.kind === "unavailable") expect(range.reason).toBe("analysis-off");
    }
  });

  it("Test 1: GET integration answers the strict status and spawns nothing", async () => {
    const c = await composeWithThreads();
    const reply = await c.get(CODEX_INTEGRATION_PATH);
    expect(reply.status).toBe(200);
    const status = CodexIntegrationStatusSchema.parse(reply.body);
    expect(status.hooks.state).toBe("not-installed");
    expect(status.bridge.state).toBe("not-installed");
    expect(status.codex.installed).toBe(true);
    expect(status.doctor).toBeNull();
    expect(c.spawner.calls).toEqual([]);
    expect(c.spawner.detached).toEqual([]);
    expect(c.appServerStarts()).toBe(0);
  });

  it("Test 1: POST doctor runs the saved executable once with the fixed argv and answers the summary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccc-doctor-route-"));
    try {
      const doctor = writeFakeDoctor(dir, {
        behavior: { kind: "print", stdout: doctorReport({ overallStatus: "ok" }) },
      });
      composition = await startCodexComposition({});
      const c = composition;
      saveLauncherConfig(c.store.db, "codex", { executablePath: doctor.path, args: [] });
      const reply = await c.post(CODEX_DOCTOR_PATH, {});
      expect(reply.status).toBe(200);
      const summary = CodexDoctorSummarySchema.parse(reply.body);
      expect(summary.overall).toBe("ok");
      const starts = readFakeDoctorStarts(doctor.logPath);
      expect(starts).toHaveLength(1);
      expect(starts[0]?.argv).toEqual(["doctor", "--json"]);
      // The last summary is cached for the integration status.
      const integration = CodexIntegrationStatusSchema.parse(
        (await c.get(CODEX_INTEGRATION_PATH)).body,
      );
      expect(integration.doctor?.overall).toBe("ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Test 1: POST doctor with no saved executable is the constant 503 and spawns nothing", async () => {
    const c = await composeWithThreads({ saveRow: false });
    const reply = await c.post(CODEX_DOCTOR_PATH, {});
    expect(reply.status).toBe(503);
    expect(reply.body).toEqual({ error: "unavailable" });
  });

  it("Test 1: POST open-transcript hands the contained rollout to open and nothing else", async () => {
    const c = await composeWithThreads();
    await c.get(CODEX_SESSIONS_PATH);
    const reply = await c.post(CODEX_OPEN_TRANSCRIPT_PATH, { threadId: SESSION_A, via: "reveal" });
    expect(reply).toEqual({ status: 200, body: { ok: true } });
    expect(c.spawner.calls).toHaveLength(1);
    const argv = c.spawner.calls[0]?.argv ?? [];
    expect(argv.slice(1, 2)).toEqual(["-R"]);
    expect(argv.at(-1)?.endsWith(`rollout-${SESSION_A}.jsonl`)).toBe(true);
    expect(argv.at(-1)?.startsWith(c.home.root)).toBe(true);
  });

  it("Test 1: POST open-transcript for an unknown thread is the fixed not-found code", async () => {
    const c = await composeWithThreads();
    await c.get(CODEX_SESSIONS_PATH);
    const reply = await c.post(CODEX_OPEN_TRANSCRIPT_PATH, {
      threadId: "thread-unknown-0000",
      via: "open",
    });
    expect(reply.status).toBe(404);
    expect(reply.body).toEqual({ error: "not-found" });
    expect(c.spawner.calls).toEqual([]);
  });

  it("Test 1: POST follow-log for a run that does not exist is the fixed not-found code", async () => {
    const c = await composeWithThreads();
    const reply = await c.post(CODEX_FOLLOW_LOG_PATH, { runId: "20261010T120000000Z" });
    expect(reply.status).toBe(404);
    expect(reply.body).toEqual({ error: "not-found" });
  });

  it("Test 1: POST hook-events applies a Stop to a session the rollout still reads as running", async () => {
    const c = await composeWithThreads();
    const before = CodexSessionsSnapshotSchema.parse((await c.get(CODEX_SESSIONS_PATH)).body);
    if (before.kind !== "available") throw new Error("unreachable");
    expect(before.sessions.find((s) => s.threadId === SESSION_A)?.state).toBe("running");

    const reply = await c.post(CODEX_HOOK_EVENTS_PATH, {
      eventId: randomUUID(),
      observedAt: new Date().toISOString(),
      hook_event_name: "Stop",
      session_id: SESSION_A,
      turn_id: "turn-1",
    });
    expect(reply).toEqual({ status: 202, body: { accepted: true } });

    const after = CodexSessionsSnapshotSchema.parse((await c.get(CODEX_SESSIONS_PATH)).body);
    if (after.kind !== "available") throw new Error("unreachable");
    expect(after.sessions.find((s) => s.threadId === SESSION_A)?.state).toBe("completed");
  });

  it("Test 1: every Codex path answers the constant 503 when the codex member is absent", async () => {
    composition = await startCodexComposition({ codex: false });
    const c = composition;
    for (const path of READ_ONLY_PATHS) {
      expect(await c.get(path), `GET ${path}`).toEqual({
        status: 503,
        body: { error: "unavailable" },
      });
    }
    for (const path of POST_ONLY_PATHS) {
      expect(await c.post(path, {}), `POST ${path}`).toEqual({
        status: 503,
        body: { error: "unavailable" },
      });
    }
  });
});

// ---------------------------------------------------------------------------
// codexSnapshotFor: the optional snapshot member, read synchronously then refreshed

const NOW_ISO = "2026-10-10T12:00:00.000Z";

function sessionList(count: number): CodexSessionsSnapshot {
  return CodexSessionsSnapshotSchema.parse({
    kind: "available",
    sessions: Array.from({ length: count }, (_, index) => ({
      threadId: `thread-snapshot-${String(index).padStart(4, "0")}`,
      projectId: null,
      projectName: null,
      origin: "interactive",
      state: "stale",
      model: null,
      effort: null,
      startedAt: NOW_ISO,
      lastActivityAt: NOW_ISO,
      resumesAfter: null,
      title: null,
      hasTranscript: true,
      liveLogRunId: null,
    })),
    hiddenCount: 3,
    analysisOn: false,
    observedAt: NOW_ISO,
    freshness: "live",
    partiality: { partial: false },
  });
}

const INTEGRATION = CodexIntegrationStatusSchema.parse({
  hooks: { state: "not-installed", lastEventAt: null, installedSince: null },
  bridge: { state: "not-installed", lastWindowAt: null },
  codex: { installed: false, version: null },
  doctor: null,
});

function fakeDeps(
  order: string[],
  parts: { sessions?: CodexSessionsSnapshot | null } = {},
): CodexRouteDeps {
  const sessions = parts.sessions === undefined ? sessionList(2) : parts.sessions;
  return {
    sessions: {
      mirror: {
        snapshot: () => {
          order.push("read:sessions");
          return sessions;
        },
        refreshIfStale: () => {
          order.push("refresh:sessions");
        },
        pollNow: async () => undefined,
      },
      opener: { open: async () => ({ ok: true }) },
    },
    headroom: {
      getUsage: async () => {
        throw new Error("the snapshot never awaits a read");
      },
      getHeadroom: async () => {
        throw new Error("the snapshot never awaits a read");
      },
      peekUsage: () => {
        order.push("read:usage");
        return null;
      },
      peekHeadroom: () => {
        order.push("read:headroom");
        return null;
      },
      refreshIfStale: () => {
        order.push("refresh:headroom");
      },
    },
    integration: {
      status: () => {
        order.push("read:integration");
        return INTEGRATION;
      },
      refresh: () => INTEGRATION,
    },
  };
}

describe("codexSnapshotFor", () => {
  it("reads every cache first and asks for the fire-and-forget refreshes after, never awaiting one", () => {
    const order: string[] = [];
    const member = codexSnapshotFor(fakeDeps(order));
    expect(member?.sessions?.kind).toBe("available");
    expect(member?.integration).toEqual(INTEGRATION);
    const firstRefresh = order.findIndex((entry) => entry.startsWith("refresh:"));
    expect(firstRefresh).toBeGreaterThan(-1);
    expect(order.slice(0, firstRefresh).every((entry) => entry.startsWith("read:"))).toBe(true);
    expect(order.slice(firstRefresh).every((entry) => entry.startsWith("refresh:"))).toBe(true);
    expect(order).toContain("refresh:sessions");
    expect(order).toContain("refresh:headroom");
  });

  it("omits a part nothing has observed and returns null when no part exists", () => {
    const member = codexSnapshotFor(fakeDeps([], { sessions: null }));
    expect(member?.sessions).toBeUndefined();
    expect(member?.usage).toBeUndefined();
    expect(member?.headroom).toBeUndefined();
    expect(codexSnapshotFor({})).toBeNull();
  });

  it("trims a long session list to the byte budget and counts the trimmed sessions as hidden", () => {
    const full = sessionList(200);
    const member = codexSnapshotFor(fakeDeps([], { sessions: full }), 6 * 1024);
    const trimmed = member?.sessions;
    if (trimmed?.kind !== "available" || full.kind !== "available") throw new Error("unreachable");
    expect(Buffer.byteLength(JSON.stringify(member), "utf8")).toBeLessThanOrEqual(6 * 1024);
    expect(trimmed.sessions.length).toBeLessThan(200);
    expect(trimmed.sessions.length).toBeGreaterThan(0);
    expect(trimmed.sessions).toEqual(full.sessions.slice(0, trimmed.sessions.length));
    expect(trimmed.sessions.length + trimmed.hiddenCount).toBe(200 + 3);
  });

  it("drops the session part entirely when even an empty list would not fit, keeping the rest", () => {
    const integrationOnly = Buffer.byteLength(JSON.stringify({ integration: INTEGRATION }), "utf8");
    const member = codexSnapshotFor(
      fakeDeps([], { sessions: sessionList(5) }),
      integrationOnly + 40,
    );
    expect(member?.sessions).toBeUndefined();
    expect(member?.integration).toEqual(INTEGRATION);
  });

  it("a service that throws loses only its own part", () => {
    const deps = fakeDeps([]);
    const broken: CodexRouteDeps = {
      ...deps,
      sessions: {
        mirror: {
          snapshot: () => {
            throw new Error("fault");
          },
          refreshIfStale: () => {
            throw new Error("fault");
          },
          pollNow: async () => undefined,
        },
        opener: { open: async () => ({ ok: true }) },
      },
    };
    const member = codexSnapshotFor(broken);
    expect(member?.sessions).toBeUndefined();
    expect(member?.integration).toEqual(INTEGRATION);
  });
});
