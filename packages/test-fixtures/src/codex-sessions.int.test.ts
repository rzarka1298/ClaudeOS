import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CODEX_HEADROOM_PATH,
  CodexIntegrationUpdatedPayloadSchema,
  CodexSessionsUpdatedPayloadSchema,
  HeadroomSignalSchema,
  type ServiceEvent,
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
  accessTimeMs,
  type CodexHomeOnDisk,
  createCodexHomeOnDisk,
  entryNames,
  HOOK_BUDGET_MS,
  installCodexHook,
  markThreadRunning,
  ROLLOUT_BUDGET_MS,
  runInstalledCodexHook,
  writeBridgeState,
} from "./codex-real-process-support.js";
import { startServiceForTest } from "./service-harness.js";
import { withTempSocketDir } from "./socket-fixture.js";

/**
 * Plan 05.1-29 Task 3: the realtime budgets measured on a REAL built service process
 * (UI-SPEC "Realtime and cost of reads", PRD ten-second budget, D-24), against a fake Codex home.
 *
 * - A rollout change reaches an SSE subscriber as a sessions event within ROLLOUT_BUDGET_MS at the
 *   default poll cadence (the mirror polls every 5 s while someone is subscribed).
 * - A hook-delivered event reaches it within HOOK_BUDGET_MS of the hook invocation.
 * - With nobody subscribed the service performs no mirror poll at all.
 *
 * The measured times are written with console.info for the plan SUMMARY. The ceilings are the
 * stated budgets, named once in the support module; a run on a loaded machine that exceeds one
 * should be re-run alone before it is read as a regression.
 *
 * Safety. Every directory is temporary. The service runs with a throwaway Keychain account, a
 * short socket directory under the test base, CCC_CODEX_HOME and XDG_STATE_HOME pointed at
 * temporary directories (a simulated bridge state in the latter, so the first candidate answers),
 * and CLAUDE_CONFIG_DIR at an empty temporary folder. No launcher is saved and the integration
 * route is never called: the first call to it would run the install detection, which probes the
 * known locations of the Codex executable under the owner's real home. The single residual read of
 * the owner's home is the bridge's second state-directory candidate, which the service lists
 * read-only at start (the Keychain needs the real HOME, so the service cannot be started under a
 * temporary one).
 */

let account: string;

beforeEach(() => {
  account = setUpServiceEnvironment();
});

afterEach(() => {
  tearDownServiceEnvironment(account, ["CCC_CODEX_HOME", "XDG_STATE_HOME"]);
});

const sha256 = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

/** The name of a thread's state in a sessions event, or null when it does not carry the thread. */
function stateIn(event: ServiceEvent, threadId: string): string | null {
  if (event.type !== "codex.sessions.updated") return null;
  const payload = CodexSessionsUpdatedPayloadSchema.safeParse(event.payload);
  if (!payload.success || payload.data.kind !== "available") return null;
  return payload.data.sessions.find((session) => session.threadId === threadId)?.state ?? null;
}

interface RealWorld {
  readonly home: CodexHomeOnDisk;
  readonly dir: string;
  readonly socketPath: string;
  readonly stateHome: string;
}

/** Temporary directories, the fake Codex home and the environment the service inherits. */
function prepareWorld(dir: string, socketPath: string): RealWorld {
  const home = createCodexHomeOnDisk(dir, Date.now());
  const stateHome = join(dir, "xdg");
  writeBridgeState(stateHome);
  mkdirSync(join(dir, "claude", "projects"), { recursive: true });
  process.env.CCC_CODEX_HOME = home.root;
  process.env.XDG_STATE_HOME = stateHome;
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
  return { home, dir, socketPath, stateHome };
}

describe("Test 1 (tracer, real process): a rollout change reaches a subscriber within the ten second budget", () => {
  it("shows the thread running in a sessions event after a started turn is appended", async () => {
    await withTempSocketDir(async ({ dir, socketPath }) => {
      const world = prepareWorld(dir, socketPath);
      const service = await startServiceForTest({
        socketPath,
        dbPath: join(dir, "operational.db"),
      });
      const token = await handshake(socketPath);
      const stream = collectEvents(socketPath, token);
      try {
        await stream.waitFor(
          (event) => stateIn(event, world.home.threadId) === "completed",
          ROLLOUT_BUDGET_MS + 5000,
        );
        const startedAt = Date.now();
        markThreadRunning(world.home, startedAt);
        await stream.waitFor(
          (event) => stateIn(event, world.home.threadId) === "running",
          ROLLOUT_BUDGET_MS,
        );
        const elapsed = Date.now() - startedAt;
        console.info(
          `[realtime] rollout append to sessions event: ${elapsed} ms (budget ${ROLLOUT_BUDGET_MS} ms)`,
        );
        expect(elapsed).toBeLessThan(ROLLOUT_BUDGET_MS);
      } finally {
        stream.close();
        await service.stop();
      }
    });
  }, 60_000);
});

describe("Test 2 (real process): a hook-delivered event reaches a subscriber within two seconds", () => {
  it("installs the hook copy into temporary directories, delivers a prompt event and reports installed", async () => {
    await withTempSocketDir(async ({ dir, socketPath }) => {
      const world = prepareWorld(dir, socketPath);
      // A decoy configuration file beside the hook file: the installer and the hook must not touch it.
      const decoyConfig = join(world.home.root, ["config", "toml"].join("."));
      writeFileSync(decoyConfig, 'notify = ["decoy-value-not-real"]\n');
      const decoyHash = sha256(decoyConfig);
      const service = await startServiceForTest({
        socketPath,
        dbPath: join(dir, "operational.db"),
      });
      const token = await handshake(socketPath);
      const stream = collectEvents(socketPath, token);
      try {
        await stream.waitFor(
          (event) => stateIn(event, world.home.threadId) === "completed",
          ROLLOUT_BUDGET_MS + 5000,
        );
        expect(installCodexHook(world.home.root, dir)).toBe(0);

        const startedAt = Date.now();
        await runInstalledCodexHook(dir, {
          hook_event_name: "UserPromptSubmit",
          session_id: world.home.threadId,
          turn_id: "turn-2",
        });
        await stream.waitFor(
          (event) => stateIn(event, world.home.threadId) === "running",
          HOOK_BUDGET_MS,
        );
        const elapsed = Date.now() - startedAt;
        console.info(
          `[realtime] hook invocation to sessions event: ${elapsed} ms (budget ${HOOK_BUDGET_MS} ms)`,
        );
        expect(elapsed).toBeLessThan(HOOK_BUDGET_MS);

        // The integration status over the real socket: the event the hook caused says installed.
        const integration = await stream.waitFor(
          (event) =>
            event.type === "codex.integration.updated" &&
            CodexIntegrationUpdatedPayloadSchema.safeParse(event.payload).data?.hooks.state ===
              "installed",
          5000,
        );
        expect(
          CodexIntegrationUpdatedPayloadSchema.parse(integration.payload).hooks.lastEventAt,
        ).not.toBeNull();
        expect(sha256(decoyConfig)).toBe(decoyHash);
      } finally {
        stream.close();
        await service.stop();
      }
    });
  }, 60_000);
});

describe("Test 3 (real process): nothing is polled without a subscriber", () => {
  it("leaves the Codex home untouched while idle, answers headroom unavailable without a spawn, and polls once subscribed", async () => {
    await withTempSocketDir(async ({ dir, socketPath }) => {
      const world = prepareWorld(dir, socketPath);
      const before = entryNames(world.home.root);
      const rolloutAccessBefore = accessTimeMs(world.home.rolloutFile);
      const service = await startServiceForTest({
        socketPath,
        dbPath: join(dir, "operational.db"),
      });
      const token = await handshake(socketPath);
      try {
        // Longer than one poll interval: a poll with nobody watching would have run by now.
        await new Promise((done) => setTimeout(done, 6500));
        expect(entryNames(world.home.root)).toEqual(before);
        expect(accessTimeMs(world.home.rolloutFile)).toBe(rolloutAccessBefore);

        // No Codex launcher is saved: the headroom is the unavailable state and nothing is spawned.
        const headroom = await authedRequest<unknown>(socketPath, token, {
          method: "GET",
          path: CODEX_HEADROOM_PATH,
        });
        expect(headroom.status).toBe(200);
        const signal = HeadroomSignalSchema.parse(headroom.body);
        expect(signal.codex.verdict).toBe("refuse");
        expect(signal.codex.reason).toBe("usage-unavailable");
        expect(entryNames(world.home.root)).toEqual(before);

        // Subscribing starts the polls: the thread appears and the store was opened (its sidecars exist).
        const stream = collectEvents(socketPath, token);
        try {
          await stream.waitFor(
            (event) => stateIn(event, world.home.threadId) === "completed",
            ROLLOUT_BUDGET_MS + 5000,
          );
        } finally {
          stream.close();
        }
        expect(entryNames(world.home.root).length).toBeGreaterThan(before.length);
      } finally {
        await service.stop();
      }
    });
  }, 60_000);
});
