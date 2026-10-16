import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  RESEARCH_LIST_PATH,
  RESEARCH_REPORT_PATH,
  RESEARCH_RUN_PATH,
  RESEARCH_STATUS_PATH,
  ResearchErrorBodySchema,
  ResearchListResponseSchema,
  ResearchReportItemsPageSchema,
  ResearchReportSourcesPageSchema,
  ResearchRunResponseSchema,
  ResearchStatusResponseSchema,
} from "@ccc/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type RouteHarness,
  requestOverSocket,
  startRouteHarness,
} from "../test-support/approval-fixtures.js";
import { createResearchRouteServices } from "./route-services.js";
import { researchRoutes } from "./routes.js";
import type { ResearchServices } from "./services.js";
import {
  addWorstCaseReport,
  createReportVault,
  type ReportVault,
  testRunId,
} from "./test-support/report-vault.js";

/**
 * Plan 07-14 Task 2 (D-23, T-07-07, T-07-35, T-07-36, T-07-37): the research routes through the
 * real request listener. Auth on every route, strict small bodies, closed error bodies, the list
 * route filling the vault-relative `notePath`, and no response at or above the socket budget.
 */

const UNAUTHENTICATED = { error: "authentication required" };
const INVALID_BODY = { error: "invalid-body" };

let vault: ReportVault;
let harness: RouteHarness;
let runNow: ResearchServices["runNow"];
let vaultSetUp = true;

beforeEach(async () => {
  vault = createReportVault();
  vaultSetUp = true;
  runNow = () => ({
    ok: true,
    value: { runId: testRunId() as never, alreadyRunning: false, state: "running" },
  });
  harness = await startRouteHarness(vault.store, {
    research: createResearchRouteServices({
      db: vault.store.db,
      getVaultRoot: () => (vaultSetUp ? vault.root : null),
      services: {
        runNow: () => runNow(),
        configuredSources: () => ({
          topicLabel: "Tooling",
          sources: [{ label: "One", host: "one.example.invalid" }],
        }),
      },
    }),
  });
});

afterEach(async () => {
  await harness.close();
  vault.cleanup();
});

function call<T = unknown>(
  path: string,
  opts: { body?: unknown; rawBody?: string; token?: string | null } = {},
) {
  const token = opts.token === undefined ? harness.token : (opts.token ?? undefined);
  return requestOverSocket<T>(harness.socketPath, {
    method: "POST",
    path,
    ...(opts.body === undefined ? {} : { body: opts.body }),
    ...(opts.rawBody === undefined ? {} : { rawBody: opts.rawBody }),
    ...(token === undefined ? {} : { token }),
  });
}

const ALL_PATHS = [
  RESEARCH_RUN_PATH,
  RESEARCH_LIST_PATH,
  RESEARCH_REPORT_PATH,
  RESEARCH_STATUS_PATH,
];

describe("auth and bodies", () => {
  it("answers the shared 401 body to every route without a valid bearer token", async () => {
    for (const path of ALL_PATHS) {
      expect((await call(path, { body: {}, token: null })).body, path).toEqual(UNAUTHENTICATED);
      expect((await call(path, { body: {}, token: "not-a-token" })).status, path).toBe(401);
    }
  });

  it("registers exactly the four fixed paths, POST only", () => {
    expect(Object.keys(researchRoutes).sort()).toEqual([...ALL_PATHS].sort());
    for (const methods of Object.values(researchRoutes)) {
      expect(Object.keys(methods)).toEqual(["POST"]);
    }
  });

  it("answers invalid-body to an unknown key, a bad shape, bad JSON and an oversize body", async () => {
    const cases: [string, Parameters<typeof call>[1]][] = [
      [RESEARCH_RUN_PATH, { body: { extra: 1 } }],
      [RESEARCH_LIST_PATH, { body: { limit: 0 } }],
      [RESEARCH_LIST_PATH, { body: { limit: 26 } }],
      [RESEARCH_REPORT_PATH, { body: { noteId: "short", page: "items" } }],
      [RESEARCH_REPORT_PATH, { body: { noteId: "a".repeat(25), page: "other" } }],
      [RESEARCH_STATUS_PATH, { rawBody: "{not json" }],
      [RESEARCH_STATUS_PATH, { rawBody: JSON.stringify({ filler: "x".repeat(8 * 1024) }) }],
    ];
    for (const [path, opts] of cases) {
      const reply = await call(path, opts);
      expect(reply.status, `${path} ${JSON.stringify(opts).slice(0, 40)}`).toBe(400);
      expect(reply.body).toEqual(INVALID_BODY);
    }
  });

  it("answers 503 with a closed body when no research services are bound", async () => {
    const bare = await startRouteHarness(vault.store, {});
    try {
      const reply = await requestOverSocket<unknown>(bare.socketPath, {
        method: "POST",
        path: RESEARCH_STATUS_PATH,
        body: {},
        token: bare.token,
      });
      expect(reply.status).toBe(503);
      expect(ResearchErrorBodySchema.parse(reply.body)).toEqual({ error: "service-disconnected" });
    } finally {
      await bare.close();
    }
  });
});

describe("run", () => {
  it("returns the run id, and the running run for a second press", async () => {
    const first = await call(RESEARCH_RUN_PATH, { body: {} });
    expect(first.status).toBe(200);
    expect(ResearchRunResponseSchema.parse(first.body).alreadyRunning).toBe(false);
    const id = testRunId() as never;
    runNow = () => ({ ok: true, value: { runId: id, alreadyRunning: true, state: "running" } });
    const second = await call(RESEARCH_RUN_PATH, { body: {} });
    expect(ResearchRunResponseSchema.parse(second.body)).toEqual({
      runId: id,
      alreadyRunning: true,
      state: "running",
    });
  });

  it("answers vault-not-set-up with the closed code", async () => {
    runNow = () => ({ ok: false, code: "vault-not-set-up" });
    const reply = await call(RESEARCH_RUN_PATH, { body: {} });
    expect(reply.status).toBe(409);
    expect(reply.body).toEqual({ error: "vault-not-set-up" });
  });

  it("answers a thrown start with the closed internal code (500) and keeps serving", async () => {
    runNow = () => {
      throw new Error("a secret detail that must not leave the process");
    };
    const reply = await call(RESEARCH_RUN_PATH, { body: {} });
    expect(reply.status).toBe(500);
    expect(reply.body).toEqual({ error: "internal" });
    expect(reply.raw).not.toContain("secret");
    const after = await call(RESEARCH_STATUS_PATH, { body: {} });
    expect(after.status).toBe(200);
  });
});

describe("list, report and status", () => {
  it("serves the list with a vault-relative notePath and the report pages", async () => {
    const built = vault.addReport();
    const list = await call(RESEARCH_LIST_PATH, { body: {} });
    expect(list.status).toBe(200);
    const parsed = ResearchListResponseSchema.parse(list.body);
    const row = parsed.rows[0];
    if (row === undefined || !row.readable) throw new Error("expected a readable row");
    expect(row.notePath).toBe(built.path);
    expect(row.noteId).toBe(built.noteId);

    const items = await call(RESEARCH_REPORT_PATH, {
      body: { noteId: built.noteId, page: "items" },
    });
    expect(items.status).toBe(200);
    expect(ResearchReportItemsPageSchema.parse(items.body).header.notePath).toBe(built.path);
    const sources = await call(RESEARCH_REPORT_PATH, {
      body: { noteId: built.noteId, page: "sources" },
    });
    expect(ResearchReportSourcesPageSchema.parse(sources.body).sources).toHaveLength(1);

    const status = await call(RESEARCH_STATUS_PATH, { body: {} });
    expect(ResearchStatusResponseSchema.parse(status.body).configuredSources).toEqual([
      { label: "One", host: "one.example.invalid" },
    ]);
  });

  it("answers not-found, unreadable-report, invalid-cursor and vault-not-set-up with closed bodies", async () => {
    const built = vault.addReport();
    const missing = await call(RESEARCH_REPORT_PATH, {
      body: { noteId: "z".repeat(25), page: "items" },
    });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: "not-found" });

    const badCursor = await call(RESEARCH_REPORT_PATH, {
      body: { noteId: built.noteId, page: "items", cursor: "abc" },
    });
    expect(badCursor.status).toBe(400);
    expect(badCursor.body).toEqual({ error: "invalid-cursor" });
    const badListCursor = await call(RESEARCH_LIST_PATH, { body: { cursor: "abc" } });
    expect(badListCursor.body).toEqual({ error: "invalid-cursor" });

    const path = join(vault.root, built.path);
    const original = readFileSync(path, "utf8");
    writeFileSync(path, original.replace("type: report", "type: invalid-type"));
    const unreadable = await call(RESEARCH_REPORT_PATH, {
      body: { noteId: built.noteId, page: "items" },
    });
    expect(unreadable.status).toBe(422);
    expect(unreadable.body).toEqual({ error: "unreadable-report" });

    vaultSetUp = false;
    const noVault = await call(RESEARCH_LIST_PATH, { body: {} });
    expect(noVault.status).toBe(409);
    expect(noVault.body).toEqual({ error: "vault-not-set-up" });
  });

  it("keeps every response of a worst-case report under the socket budget", async () => {
    const built = addWorstCaseReport(vault, 25);
    const sizes: number[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 12; page += 1) {
      const reply = await call<{ nextCursor: string | null }>(RESEARCH_REPORT_PATH, {
        body: { noteId: built.noteId, page: "items", ...(cursor === undefined ? {} : { cursor }) },
      });
      expect(reply.status).toBe(200);
      sizes.push(Buffer.byteLength(reply.raw, "utf8"));
      if (reply.body.nextCursor === null) break;
      cursor = reply.body.nextCursor;
    }
    const sources = await call(RESEARCH_REPORT_PATH, {
      body: { noteId: built.noteId, page: "sources" },
    });
    sizes.push(Buffer.byteLength(sources.raw, "utf8"));
    const list = await call(RESEARCH_LIST_PATH, { body: {} });
    sizes.push(Buffer.byteLength(list.raw, "utf8"));
    for (const size of sizes) expect(size).toBeLessThan(57344);
    expect(sizes.length).toBeGreaterThan(3);
  });
});
