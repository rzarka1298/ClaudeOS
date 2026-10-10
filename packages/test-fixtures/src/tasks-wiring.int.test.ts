import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TASK_ATTENTION_PATH,
  TASK_COUNTS_PATH,
  TASK_CREATE_PATH,
  TASK_LIST_PATH,
  TASK_REBUILD_PATH,
  type TaskAttentionResponse,
  type TaskCountsResponse,
  type TaskFilter,
  type TaskListResponse,
  VAULT_SETUP_PATH,
} from "@ccc/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authedRequest,
  handshake,
  setUpServiceEnvironment,
  tearDownServiceEnvironment,
} from "./approval-int-support.js";
import { startServiceForTest, type TestServiceHandle } from "./service-harness.js";
import { withTempSocketDir } from "./socket-fixture.js";
import {
  expectedCounts,
  expectedIds,
  type GeneratedTaskVault,
  utcDay,
  withTaskVault,
} from "./task-fixtures.js";

/**
 * Plan 06-25 Task 1 (TASK-06, D-31, D-35, SVC-11): the REAL built service started
 * on a vault that already holds tasks. The vault root is registered through the
 * real setup route; the service is then restarted, so the boot walk (and nothing
 * else) is what fills the index. No rebuild request is ever sent in the boot
 * tests. Throwaway runtime directory, short socket path, throwaway Keychain
 * account; every service this file starts is stopped in teardown.
 */

const ZONE = "UTC";

let account: string;
const started: TestServiceHandle[] = [];

beforeEach(() => {
  account = setUpServiceEnvironment();
});

afterEach(async () => {
  for (const service of started.splice(0)) await service.kill();
  tearDownServiceEnvironment(account);
});

async function start(dir: string, socketPath: string): Promise<{ token: string }> {
  mkdirSync(join(dir, "claude", "projects"), { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
  const service = await startServiceForTest({ socketPath, dbPath: join(dir, "operational.db") });
  started.push(service);
  return { token: await handshake(socketPath) };
}

async function stopLast(): Promise<void> {
  const service = started.pop();
  if (service !== undefined) await service.stop();
}

/** Registers the vault root through the real setup route, then restarts the service. */
async function registerAndRestart(
  dir: string,
  socketPath: string,
  vaultRoot: string,
): Promise<{ token: string }> {
  const first = await start(dir, socketPath);
  const setup = await authedRequest<unknown>(socketPath, first.token, {
    method: "POST",
    path: VAULT_SETUP_PATH,
    body: { vaultRoot },
  });
  expect(setup.status).toBe(200);
  await stopLast();
  return start(dir, socketPath);
}

async function listAll(
  socketPath: string,
  token: string,
  filter: TaskFilter,
  scope: string,
): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 200; page += 1) {
    const res = await authedRequest<TaskListResponse>(socketPath, token, {
      method: "POST",
      path: TASK_LIST_PATH,
      body: { context: { scope }, filter, zone: ZONE, ...(cursor === undefined ? {} : { cursor }) },
    });
    expect(res.status).toBe(200);
    ids.push(...res.body.rows.map((row) => row.id));
    if (res.body.nextCursor === null) return ids;
    cursor = res.body.nextCursor;
  }
  throw new Error("a list never ended");
}

function logLines(dir: string): Record<string, unknown>[] {
  return readFileSync(join(dir, "logs", "service.log"), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("boot walk on a vault that already holds tasks (Task 1, Tests 2 and 5)", () => {
  it("serves right lists and counts on the first request after start, with no rebuild", async () => {
    await withTaskVault({ count: 200 }, async (vault: GeneratedTaskVault) => {
      await withTempSocketDir(async ({ dir, socketPath }) => {
        const { token } = await registerAndRestart(dir, socketPath, vault.vaultRoot);
        const day = utcDay(new Date());

        // The very first task request after the socket opens already sees every task.
        const counts = await authedRequest<TaskCountsResponse>(socketPath, token, {
          method: "POST",
          path: TASK_COUNTS_PATH,
          body: { context: { scope: "all" }, zone: ZONE },
        });
        expect(counts.status).toBe(200);
        expect(counts.body).toEqual(expectedCounts(vault.tasks, "all", day));
        expect(counts.body.counts.all).toBe(200);

        for (const filter of [
          "today",
          "overdue",
          "upcoming",
          "proposed",
          "blocked",
          "completed",
        ] as const) {
          const got = await listAll(socketPath, token, filter, "all");
          expect(got.length, filter).toBeGreaterThan(0);
          expect(new Set(got), filter).toEqual(
            new Set(expectedIds(vault.tasks, filter, "all", day)),
          );
        }

        for (const scope of vault.scopes) {
          const scoped = await authedRequest<TaskCountsResponse>(socketPath, token, {
            method: "POST",
            path: TASK_COUNTS_PATH,
            body: { context: { scope }, zone: ZONE },
          });
          expect(scoped.body).toEqual(expectedCounts(vault.tasks, scope, day));
        }
      });
    });
  }, 120_000);

  it("runs the walk after the migrations and the vault root, and before the socket opens", () => {
    const main = readFileSync(
      fileURLToPath(new URL("../../service/src/main.ts", import.meta.url)),
      "utf8",
    );
    const at = (needle: string): number => {
      const first = main.indexOf(needle);
      expect(first, needle).toBeGreaterThan(-1);
      return first;
    };
    expect(at("applyMigrations(store.db)")).toBeLessThan(at("registerPersistedVaultRoot(store)"));
    expect(at("registerPersistedVaultRoot(store)")).toBeLessThan(at("taskHost.startupWalk()"));
    expect(at("taskHost.startupWalk()")).toBeLessThan(at("await startSocketServer({"));
  });
});

describe("a service with no vault (Task 1, Test 3)", () => {
  it("starts, answers the closed vault-not-set-up code and logs one fixed code", async () => {
    await withTempSocketDir(async ({ dir, socketPath }) => {
      const { token } = await start(dir, socketPath);

      const created = await authedRequest<{ error: string }>(socketPath, token, {
        method: "POST",
        path: TASK_CREATE_PATH,
        body: { title: "Write it down", intent: "inbox", zone: ZONE },
      });
      expect(created.status).toBe(409);
      expect(created.body).toEqual({ error: "vault-not-set-up" });

      const rebuilt = await authedRequest<{ error: string }>(socketPath, token, {
        method: "POST",
        path: TASK_REBUILD_PATH,
        body: {},
      });
      expect(rebuilt.status).toBe(409);
      expect(rebuilt.body).toEqual({ error: "vault-not-set-up" });

      await stopLast();
      const walkLines = logLines(dir).filter(
        (line) => typeof line.msg === "string" && line.msg.startsWith("startup: task index"),
      );
      expect(walkLines).toHaveLength(1);
      expect(walkLines[0]).toMatchObject({
        msg: "startup: task index not built",
        code: "vault-not-set-up",
      });
    });
  }, 60_000);
});

describe("a vault holding a note the walk cannot read (Task 1, Test 4)", () => {
  it("starts anyway and lists the note under attention, in no list", async () => {
    await withTaskVault({ count: 30 }, async (vault: GeneratedTaskVault) => {
      writeFileSync(
        join(vault.vaultRoot, "global", "tasks", "broken-note.md"),
        "---\nid: [unclosed\n---\nbody\n",
      );
      writeFileSync(join(vault.vaultRoot, "global", "tasks", "no-frontmatter.md"), "just text\n");
      await withTempSocketDir(async ({ dir, socketPath }) => {
        const { token } = await registerAndRestart(dir, socketPath, vault.vaultRoot);
        const day = utcDay(new Date());

        const counts = await authedRequest<TaskCountsResponse>(socketPath, token, {
          method: "POST",
          path: TASK_COUNTS_PATH,
          body: { context: { scope: "all" }, zone: ZONE },
        });
        expect(counts.body).toEqual(expectedCounts(vault.tasks, "all", day));
        expect(counts.body.counts.all).toBe(30);

        const attention = await authedRequest<TaskAttentionResponse>(socketPath, token, {
          method: "POST",
          path: TASK_ATTENTION_PATH,
          body: {},
        });
        expect(attention.status).toBe(200);
        const paths = attention.body.items.map((item) => item.path).sort();
        expect(paths).toEqual(["global/tasks/broken-note.md", "global/tasks/no-frontmatter.md"]);
        expect(attention.body.total).toBe(2);
        expect(
          attention.body.items.every((item) => ["unreadable", "missing-id"].includes(item.reason)),
        ).toBe(true);

        await stopLast();
        const built = logLines(dir).filter((line) => line.msg === "startup: task index built");
        expect(built).toHaveLength(1);
        expect(built[0]).toMatchObject({ tasks: 30, attention: 2 });
      });
    });
  }, 120_000);
});
