import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RESEARCH_RUN_PATH,
  RESEARCH_STATUS_PATH,
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
import { buildResearchFixtureDir, writeResearchSourcesFile } from "./research-fixture-dir.js";
import { startServiceForTest, type TestServiceHandle } from "./service-harness.js";
import { withTempSocketDir } from "./socket-fixture.js";

/**
 * Plan 07-14 (wave 4 review, opus m2; D-18): the research services are built once per process,
 * after the socket is bound.
 *
 * 1. A second service instance started against a live one's socket refuses and exits before it
 *    touches the store, so it cannot sweep the live instance's run to stale: that run finishes
 *    and is recorded as a success.
 * 2. A shutdown waits a bounded time for a run in flight and then leaves it to startup recovery:
 *    after the restart that run is the newest unknown run (stale, never an invented outcome) and a
 *    new press starts a fresh run that completes.
 *
 * Real processes, a throwaway runtime directory and Keychain account, a fixture directory (no
 * network, no model); every service is ended in teardown.
 */

const TEST_BASE = join(homedir(), ".ccc-test");
const SERVICE_ENTRY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../service/dist/main.js",
);

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

function overrides(fixtureDir: string): Record<string, string> {
  return {
    CCC_ENABLE_TEST_OVERRIDES: "1",
    CCC_RESEARCH_TEST_FIXTURE_DIR: fixtureDir,
    CCC_RESEARCH_TEST_SUMMARISER: "extractive",
  };
}

function exitCodeWithin(pid: number, ms: number): Promise<{ elapsedMs: number; gone: boolean }> {
  const begin = Date.now();
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      try {
        process.kill(pid, 0);
      } catch {
        clearInterval(timer);
        resolve({ elapsedMs: Date.now() - begin, gone: true });
        return;
      }
      if (Date.now() - begin > ms) {
        clearInterval(timer);
        resolve({ elapsedMs: Date.now() - begin, gone: false });
      }
    }, 100);
  });
}

async function statusOf(socketPath: string, token: string) {
  const reply = await authedRequest<unknown>(socketPath, token, {
    method: "POST",
    path: RESEARCH_STATUS_PATH,
    body: {},
  });
  expect(reply.status).toBe(200);
  return ResearchStatusResponseSchema.parse(reply.body);
}

async function setUpVault(socketPath: string, token: string): Promise<void> {
  mkdirSync(TEST_BASE, { recursive: true });
  const vaultRoot = mkdtempSync(join(TEST_BASE, "sv-"));
  extraDirs.push(vaultRoot);
  mkdirSync(join(vaultRoot, ".obsidian"), { recursive: true });
  const setup = await authedRequest<unknown>(socketPath, token, {
    method: "POST",
    path: VAULT_SETUP_PATH,
    body: { vaultRoot },
  });
  expect(setup.status).toBe(200);
}

describe("a second instance never sweeps the live instance's run", () => {
  it("refuses before it touches the store, and the live run finishes as a success", async () => {
    await withTempSocketDir(async ({ dir, socketPath }) => {
      const fixtures = buildResearchFixtureDir(join(dir, "fixtures"), { delayMs: 2500 });
      writeResearchSourcesFile(dir, fixtures.sources);
      mkdirSync(join(dir, "claude", "projects"), { recursive: true });
      process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
      const first = await startServiceForTest({
        socketPath,
        dbPath: join(dir, "operational.db"),
        env: overrides(fixtures.fixtureDir),
      });
      started.push(first);
      const token = await handshake(socketPath);
      await setUpVault(socketPath, token);
      const events = collectEvents(socketPath, token);
      try {
        const run = await authedRequest<unknown>(socketPath, token, {
          method: "POST",
          path: RESEARCH_RUN_PATH,
          body: {},
        });
        const runId = ResearchRunResponseSchema.parse(run.body).runId;
        expect((await statusOf(socketPath, token)).inFlight?.runId).toBe(runId);

        // The second instance, with the same environment, on the same socket and runtime directory.
        const second = spawn(process.execPath, [SERVICE_ENTRY], {
          env: {
            ...process.env,
            ...overrides(fixtures.fixtureDir),
            CCC_SOCKET_PATH: socketPath,
            CCC_RUNTIME_DIR: dir,
          },
          stdio: "ignore",
        });
        // Whatever the second process prints is drained, so a full pipe cannot hold it up.
        const printed: string[] = [];
        second.stdout?.on("data", (chunk: Buffer) => printed.push(chunk.toString("utf8")));
        second.stderr?.on("data", (chunk: Buffer) => printed.push(chunk.toString("utf8")));
        const code = await new Promise<number | null>((resolve) => {
          const timer = setTimeout(() => {
            second.kill("SIGKILL");
            resolve(null);
          }, 20_000);
          second.once("exit", (exitCode) => {
            clearTimeout(timer);
            resolve(exitCode);
          });
        });
        expect(code).toBe(1);
        // WHY it exited: the socket-claim refusal, logged by code (one log file serves both
        // processes, as they share the runtime directory). An exit for any other reason (a crash, a
        // missing file, a refused override) would also be a 1 and must not pass for this.
        const logLines = readFileSync(join(dir, "logs", "service.log"), "utf8")
          .split("\n")
          .filter((line) => line.startsWith("{"))
          .map((line) => JSON.parse(line) as { code?: string; msg?: string });
        const refusals = logLines.filter((line) => line.code === "SOCKET_IN_USE");
        expect(refusals).toHaveLength(1);
        expect(refusals[0]?.msg).toBe(
          "startup refused: another service instance is already listening on the socket",
        );
        expect(logLines.some((line) => line.msg === "fatal startup error")).toBe(false);
        expect(printed.join("")).not.toContain(dir);

        // The live run was not swept: it is still in flight, then it finishes as a success.
        const during = await statusOf(socketPath, token);
        expect(during.latestUnknown).toBeNull();
        await events.waitFor(
          (event) =>
            event.type === "research.updated" &&
            (event.payload as { runId?: string; outcome?: string }).runId === runId &&
            (event.payload as { outcome?: string }).outcome !== undefined,
          60_000,
        );
        const after = await statusOf(socketPath, token);
        expect(after.lastSuccess?.runId).toBe(runId);
        expect(after.lastSuccess?.outcome).toBe("success");
        expect(after.lastFailure).toBeNull();
        expect(after.latestUnknown).toBeNull();
      } finally {
        events.close();
        await first.kill();
      }
    });
  }, 180_000);
});

describe("a shutdown waits a bounded time, then startup recovery marks the run stale", () => {
  it("leaves the run unknown after the restart and lets a new press start a fresh run", async () => {
    await withTempSocketDir(async ({ dir, socketPath }) => {
      const slow = buildResearchFixtureDir(join(dir, "fixtures"), { delayMs: 28_000 });
      writeResearchSourcesFile(dir, slow.sources);
      mkdirSync(join(dir, "claude", "projects"), { recursive: true });
      process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
      const first = await startServiceForTest({
        socketPath,
        dbPath: join(dir, "operational.db"),
        env: overrides(slow.fixtureDir),
      });
      started.push(first);
      const token = await handshake(socketPath);
      await setUpVault(socketPath, token);
      const run = await authedRequest<unknown>(socketPath, token, {
        method: "POST",
        path: RESEARCH_RUN_PATH,
        body: {},
      });
      const interrupted = ResearchRunResponseSchema.parse(run.body).runId;
      expect((await statusOf(socketPath, token)).inFlight?.runId).toBe(interrupted);

      // A polite stop: the service waits for the run (about ten seconds), then exits without it.
      const pid = first.pid;
      expect(pid).toBeDefined();
      process.kill(pid as number, "SIGTERM");
      const ended = await exitCodeWithin(pid as number, 25_000);
      expect(ended.gone).toBe(true);
      expect(ended.elapsedMs).toBeGreaterThan(5_000);
      expect(ended.elapsedMs).toBeLessThan(22_000);
      started.splice(0);

      // The restart: no delay now. Recovery has marked the cut-off run stale.
      buildResearchFixtureDir(join(dir, "fixtures"));
      const second = await startServiceForTest({
        socketPath,
        dbPath: join(dir, "operational.db"),
        env: overrides(slow.fixtureDir),
      });
      started.push(second);
      const secondToken = await handshake(socketPath);
      const restarted = await statusOf(socketPath, secondToken);
      expect(restarted.inFlight).toBeNull();
      expect(restarted.latestUnknown?.runId).toBe(interrupted);
      expect(restarted.lastSuccess).toBeNull();
      expect(restarted.lastFailure).toBeNull();

      const events = collectEvents(socketPath, secondToken);
      try {
        const fresh = await authedRequest<unknown>(socketPath, secondToken, {
          method: "POST",
          path: RESEARCH_RUN_PATH,
          body: {},
        });
        const parsed = ResearchRunResponseSchema.parse(fresh.body);
        expect(parsed.runId).not.toBe(interrupted);
        expect(parsed.alreadyRunning).toBe(false);
        await events.waitFor(
          (event) =>
            event.type === "research.updated" &&
            (event.payload as { runId?: string; outcome?: string }).runId === parsed.runId &&
            (event.payload as { outcome?: string }).outcome !== undefined,
          60_000,
        );
        const done = await statusOf(socketPath, secondToken);
        expect(done.lastSuccess?.runId).toBe(parsed.runId);
        // A stale run stops being a row of its own once a later run exists.
        expect(done.latestUnknown).toBeNull();
      } finally {
        events.close();
      }
    });
  }, 180_000);
});
