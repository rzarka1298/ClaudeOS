import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
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
  VAULT_SETUP_PATH,
} from "@ccc/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authedRequest,
  collectEvents,
  handshake,
  setUpServiceEnvironment,
  tearDownServiceEnvironment,
} from "./approval-int-support.js";
import {
  buildResearchFixtureDir,
  FIXTURE_ATOM_LABEL,
  FIXTURE_PAGE_LABEL,
  FIXTURE_RSS_LABEL,
  writeResearchSourcesFile,
} from "./research-fixture-dir.js";
import {
  requestJsonOverSocket,
  startServiceForTest,
  type TestServiceHandle,
} from "./service-harness.js";
import { withTempSocketDir } from "./socket-fixture.js";

/**
 * Plan 07-14 Task 1 (tracer, RSRCH-01, RSRCH-02, D-23, D-27, DIAG-05): the REAL built service,
 * started as a process with the guarded test override and a fixture directory, runs a research
 * run over its socket. Its event stream carries `research.updated` through the stages to the end,
 * and the report it wrote is served through the list, report and status routes. No network, no
 * model, no real key: the override swaps the fetcher for the fixture reader and the transport for
 * the extractive summariser. Throwaway runtime directory and Keychain account; every service this
 * file starts is killed in teardown and its directories are removed.
 */

const TEST_BASE = join(homedir(), ".ccc-test");
const WAIT_MS = 60_000;

let account: string;
const started: TestServiceHandle[] = [];
const extraDirs: string[] = [];

beforeEach(() => {
  account = setUpServiceEnvironment();
});

afterEach(async () => {
  for (const service of started.splice(0)) await service.kill();
  for (const dir of extraDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  tearDownServiceEnvironment(account);
});

function makeVaultRoot(): string {
  mkdirSync(TEST_BASE, { recursive: true });
  const vaultRoot = mkdtempSync(join(TEST_BASE, "rv-"));
  mkdirSync(join(vaultRoot, ".obsidian"), { recursive: true });
  extraDirs.push(vaultRoot);
  return vaultRoot;
}

interface Running {
  readonly socketPath: string;
  readonly dir: string;
  readonly token: string;
  readonly pid: number | undefined;
}

async function withResearchService<T>(
  options: { vault: boolean },
  fn: (running: Running) => Promise<T>,
): Promise<T> {
  return withTempSocketDir(async ({ dir, socketPath }) => {
    const fixtures = buildResearchFixtureDir(join(dir, "fixtures"));
    writeResearchSourcesFile(dir, fixtures.sources);
    mkdirSync(join(dir, "claude", "projects"), { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
    const service = await startServiceForTest({
      socketPath,
      dbPath: join(dir, "operational.db"),
      env: {
        CCC_ENABLE_TEST_OVERRIDES: "1",
        CCC_RESEARCH_TEST_FIXTURE_DIR: fixtures.fixtureDir,
        CCC_RESEARCH_TEST_SUMMARISER: "extractive",
      },
    });
    started.push(service);
    try {
      const token = await handshake(socketPath);
      if (options.vault) {
        const setup = await authedRequest<unknown>(socketPath, token, {
          method: "POST",
          path: VAULT_SETUP_PATH,
          body: { vaultRoot: makeVaultRoot() },
        });
        expect(setup.status).toBe(200);
      }
      return await fn({ socketPath, dir, token, pid: service.pid });
    } finally {
      // The service ends before its runtime directory is removed, whatever the test did.
      await service.kill();
    }
  });
}

describe("Test 1 (tracer): a run over the socket produces a report the routes serve", () => {
  it("runs the three fixture sources to completion and serves the report", async () => {
    let pid: number | undefined;
    let runtimeDir = "";
    await withResearchService(
      { vault: true },
      async ({ socketPath, dir, token, pid: servicePid }) => {
        pid = servicePid;
        runtimeDir = dir;
        const events = collectEvents(socketPath, token);
        try {
          const run = await authedRequest<unknown>(socketPath, token, {
            method: "POST",
            path: RESEARCH_RUN_PATH,
            body: {},
          });
          expect(run.status).toBe(200);
          const started = ResearchRunResponseSchema.parse(run.body);
          expect(started.alreadyRunning).toBe(false);
          expect(started.state).toBe("running");

          const ended = await events.waitFor(
            (event) =>
              event.type === "research.updated" &&
              (event.payload as { outcome?: string }).outcome !== undefined,
            WAIT_MS,
          );
          expect((ended.payload as { runId: string; outcome: string }).runId).toBe(started.runId);
          expect((ended.payload as { outcome: string }).outcome).toBe("success");

          // The stream carried the run through its stages, not only the end.
          const stages = events.events
            .filter((event) => event.type === "research.updated")
            .map((event) => (event.payload as { stage?: string }).stage)
            .filter((stage): stage is string => stage !== undefined);
          expect(stages).toEqual(expect.arrayContaining(["capture", "raw", "synthesis", "output"]));

          const status = await authedRequest<unknown>(socketPath, token, {
            method: "POST",
            path: RESEARCH_STATUS_PATH,
            body: {},
          });
          expect(status.status).toBe(200);
          const parsedStatus = ResearchStatusResponseSchema.parse(status.body);
          expect(parsedStatus.lastSuccess?.runId).toBe(started.runId);
          expect(parsedStatus.lastSuccess?.sourceCount).toBe(3);
          expect(parsedStatus.lastSuccess?.sourceTotal).toBe(3);
          expect(parsedStatus.lastSuccess?.outcome).toBe("success");
          expect(parsedStatus.lastFailure).toBeNull();
          expect(parsedStatus.inFlight).toBeNull();
          expect(parsedStatus.configuredSources?.map((source) => source.label)).toEqual([
            FIXTURE_ATOM_LABEL,
            FIXTURE_RSS_LABEL,
            FIXTURE_PAGE_LABEL,
          ]);

          const list = await authedRequest<unknown>(socketPath, token, {
            method: "POST",
            path: RESEARCH_LIST_PATH,
            body: {},
          });
          expect(list.status).toBe(200);
          const parsedList = ResearchListResponseSchema.parse(list.body);
          expect(parsedList.rows).toHaveLength(1);
          const row = parsedList.rows[0];
          expect(row?.readable).toBe(true);
          if (row === undefined || !row.readable) throw new Error("expected a readable row");
          expect(row.notePath).toMatch(
            /^global\/output\/research-\d{4}-\d{2}-\d{2}-[0-9a-z]{25}\.md$/,
          );
          expect(row.sourceCount).toBe(3);
          expect(row.sourceTotal).toBe(3);
          expect(parsedStatus.lastSuccess?.reportNoteId).toBe(row.noteId);

          const itemsRes = await authedRequest<unknown>(socketPath, token, {
            method: "POST",
            path: RESEARCH_REPORT_PATH,
            body: { noteId: row.noteId, page: "items" },
          });
          expect(itemsRes.status).toBe(200);
          const items = ResearchReportItemsPageSchema.parse(itemsRes.body);
          expect(items.header.noteId).toBe(row.noteId);
          expect(items.header.jobRunId).toBe(started.runId);
          expect(items.items.length).toBeGreaterThan(0);
          for (const item of items.items) {
            expect(["source-fact", "unverified-claim"]).toContain(item.kind);
            expect(item.quote).not.toBeNull();
            expect(item.citations.length).toBeGreaterThan(0);
          }

          const sourcesRes = await authedRequest<unknown>(socketPath, token, {
            method: "POST",
            path: RESEARCH_REPORT_PATH,
            body: { noteId: row.noteId, page: "sources" },
          });
          expect(sourcesRes.status).toBe(200);
          const sources = ResearchReportSourcesPageSchema.parse(sourcesRes.body);
          expect(sources.sources).toHaveLength(3);
          expect(sources.sources.map((source) => source.number)).toEqual([1, 2, 3]);
          for (const source of sources.sources) expect(source.counts).not.toBeNull();
        } finally {
          events.close();
        }
      },
    );
    // The service is gone and its runtime directory with it.
    expect(runtimeDir).not.toBe("");
    expect(existsSync(runtimeDir)).toBe(false);
    if (pid !== undefined) {
      expect(() => process.kill(pid as number, 0)).toThrow();
    }
  }, 120_000);
});

describe("Test 2 (auth and shape)", () => {
  it("answers 401 to every route without the bearer token", async () => {
    await withResearchService({ vault: true }, async ({ socketPath }) => {
      for (const path of [
        RESEARCH_RUN_PATH,
        RESEARCH_LIST_PATH,
        RESEARCH_REPORT_PATH,
        RESEARCH_STATUS_PATH,
      ]) {
        const res = await requestJsonOverSocket<unknown>(socketPath, {
          method: "POST",
          path,
          body: {},
        });
        expect(res.status, path).toBe(401);
      }
    });
  }, 120_000);

  it("answers 400 invalid-body to an unknown body key on every route", async () => {
    await withResearchService({ vault: true }, async ({ socketPath, token }) => {
      const bodies: Record<string, unknown> = {
        [RESEARCH_RUN_PATH]: { extra: true },
        [RESEARCH_LIST_PATH]: { extra: true },
        [RESEARCH_REPORT_PATH]: { noteId: "a".repeat(25), page: "items", extra: true },
        [RESEARCH_STATUS_PATH]: { extra: true },
      };
      for (const [path, body] of Object.entries(bodies)) {
        const res = await authedRequest<unknown>(socketPath, token, {
          method: "POST",
          path,
          body,
        });
        expect(res.status, path).toBe(400);
        expect(ResearchErrorBodySchema.parse(res.body)).toEqual({ error: "invalid-body" });
      }
    });
  }, 120_000);
});

describe("Test 3 (no vault)", () => {
  it("answers vault-not-set-up to a run and shows no run in the status", async () => {
    await withResearchService({ vault: false }, async ({ socketPath, token }) => {
      const run = await authedRequest<unknown>(socketPath, token, {
        method: "POST",
        path: RESEARCH_RUN_PATH,
        body: {},
      });
      expect(run.status).toBe(409);
      expect(ResearchErrorBodySchema.parse(run.body)).toEqual({ error: "vault-not-set-up" });

      const status = await authedRequest<unknown>(socketPath, token, {
        method: "POST",
        path: RESEARCH_STATUS_PATH,
        body: {},
      });
      expect(status.status).toBe(200);
      const parsed = ResearchStatusResponseSchema.parse(status.body);
      expect(parsed.lastSuccess).toBeNull();
      expect(parsed.lastFailure).toBeNull();
      expect(parsed.inFlight).toBeNull();
      expect(parsed.latestUnknown).toBeNull();
    });
  }, 120_000);
});
