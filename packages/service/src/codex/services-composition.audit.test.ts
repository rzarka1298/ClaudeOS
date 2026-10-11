import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ApprovalsSnapshot,
  CODEX_DOCTOR_PATH,
  CODEX_FOLLOW_LOG_PATH,
  CODEX_HEADROOM_PATH,
  CODEX_HOOK_EVENTS_PATH,
  CODEX_INTEGRATION_PATH,
  CODEX_OPEN_TRANSCRIPT_PATH,
  CODEX_SESSIONS_PATH,
  CODEX_TOKEN_ACTIVITY_PATH,
  CODEX_USAGE_PATH,
  fitApprovalsSnapshotToBudget,
  HEALTH_PATH,
  SNAPSHOT_PATH,
  SnapshotResponseSchema,
} from "@ccc/domain";
import { afterEach, describe, expect, it } from "vitest";
import { CLIENT_RESPONSE_CAP_BYTES } from "../approval-wiring/types.js";
import {
  createFakeServices,
  requestOverSocket,
  startRouteHarness,
  summary,
} from "../test-support/approval-fixtures.js";
import {
  type CodexComposition,
  type CompositionThread,
  codexHomeWithThreads,
  startCodexComposition,
  waitFor,
} from "../test-support/codex-composition.js";
import { CodexHomeAccessError, type CodexHomePort } from "./codex-home.js";

/**
 * Wave-7 audit of plan 05.1-28: boot without Codex, failure containment, the snapshot cap with
 * approvals, and auth on all nine routes. Temporary directories only.
 */

const READ_PATHS = [
  CODEX_HEADROOM_PATH,
  CODEX_USAGE_PATH,
  CODEX_SESSIONS_PATH,
  CODEX_TOKEN_ACTIVITY_PATH,
  CODEX_INTEGRATION_PATH,
] as const;
const POST_PATHS = [
  CODEX_DOCTOR_PATH,
  CODEX_OPEN_TRANSCRIPT_PATH,
  CODEX_FOLLOW_LOG_PATH,
  CODEX_HOOK_EVENTS_PATH,
] as const;

const open: CodexComposition[] = [];
afterEach(async () => {
  for (const c of open.splice(0)) await c.close();
});
async function compose(
  options: Parameters<typeof startCodexComposition>[0],
): Promise<CodexComposition> {
  const c = await startCodexComposition(options);
  open.push(c);
  return c;
}

/** A port whose every read throws an unexpected (non-access) error. */
function explodingPort(): CodexHomePort {
  const boom = (): never => {
    throw new Error("boom /Users/USERNAME/.codex");
  };
  return {
    stateDbPath: boom,
    readNamed: boom,
    listRolloutFiles: boom,
    listNewestRolloutFiles: boom,
    statRollout: boom,
    readRolloutRange: () => {
      throw new CodexHomeAccessError("unreadable");
    },
    resolveSessionsFile: boom,
  };
}

describe("boot with Codex absent", () => {
  it("publishes no Codex event and spawns nothing across start, timer ticks and every read", async () => {
    const c = await compose({ subscribers: 1, home: {} });
    c.codex?.start();
    for (let i = 0; i < 5; i += 1) {
      c.timers.tick();
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    for (const path of READ_PATHS) {
      if (path !== CODEX_INTEGRATION_PATH) expect((await c.get(path)).status).toBeLessThan(500);
    }
    await c.get(SNAPSHOT_PATH);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(c.spawner.calls).toHaveLength(0);
    expect(c.appServerStarts()).toBe(0);
    expect(c.events("codex.tokens.updated")).toHaveLength(0);
    // Likewise the headroom service announces its unavailable state once, never a number.
    const usage = c.events("codex.usage.updated");
    expect(usage.length).toBeLessThanOrEqual(1);
    for (const event of usage) {
      expect(JSON.stringify(event.payload)).not.toMatch(/usedPercent/);
      expect(
        (event.payload as { kind?: unknown }).kind ??
          (event.payload as { usage?: { kind?: unknown } }).usage?.kind,
      ).toBe("unavailable");
    }
    // The mirror announces the not-installed state ONCE to a connected subscriber (the card
    // needs the setup state); five ticks and every read after that add nothing.
    const sessions = c.events("codex.sessions.updated");
    expect(sessions.length).toBeLessThanOrEqual(1);
    for (const event of sessions) {
      expect(event.payload).toEqual({
        kind: "unavailable",
        reason: "not-installed",
        version: null,
      });
    }
  });

  it("the integration route also spawns nothing and publishes nothing on first read", async () => {
    const c = await compose({ subscribers: 1, home: {} });
    c.codex?.start();
    await c.get(CODEX_INTEGRATION_PATH);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(c.spawner.calls).toHaveLength(0);
    expect(c.events("codex.integration.updated")).toHaveLength(0);
  });
});

describe("a failure inside the Codex services is contained", () => {
  it("startCodexServices does not reject when the thread port throws on every read", async () => {
    const c = await compose({ usage: "real", subscribers: 1, deps: { port: explodingPort() } });
    c.codex?.start();
    c.timers.tick();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(c.codex).toBeDefined();
    expect((await c.get(HEALTH_PATH)).status).toBe(200);
    const snap = SnapshotResponseSchema.parse((await c.get(SNAPSHOT_PATH)).body);
    expect(snap.state.usage).toBeDefined();
    expect(snap.state.claudeIntegration).toBeDefined();
  });

  it("startCodexServices does not reject when the runtime directory is unusable (a regular file)", async () => {
    const c = await compose({
      usage: "real",
      prepare: ({ dir }) => {
        writeFileSync(join(dir, "not-a-dir"), "x");
      },
      deps: {},
    });
    // Rebuild a second composition whose runtime dir is a file; the first proves the harness.
    expect(c.codex).toBeDefined();
    const { startCodexServices } = await import("./services.js");
    const bad = join(c.dir, "not-a-dir");
    const { createLogger } = await import("../logging.js");
    await expect(
      startCodexServices({
        db: c.store.db,
        bus: { publish: (type, payload) => c.bus.publish(type, payload), subscriberCount: () => 0 },
        logger: createLogger(join(c.dir, "logs2", "service.log")),
        env: {},
        home: c.homeDir,
        runtimeDir: bad,
        spawner: c.spawner,
        usageSummary: () => null,
        port: c.port,
      }).then((s) => s.stop()),
    ).resolves.toBeUndefined();
  });

  it("a bus that throws on Codex events neither breaks the Phase 5 snapshot nor the listener", async () => {
    const c = await compose({
      usage: "real",
      subscribers: 1,
      home: codexHomeWithThreads([{ id: "thread-aaa", agoMs: 3_600_000 }]),
      deps: {
        bus: {
          publish: () => {
            throw new Error("bus down");
          },
          subscriberCount: () => 1,
        },
      },
    });
    c.codex?.start();
    c.timers.tick();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await c.get(SNAPSHOT_PATH)).status).toBe(200);
    expect((await c.get(HEALTH_PATH)).status).toBe(200);
  });
});

describe("the snapshot cap with approvals and 250 Codex threads", () => {
  it("keeps the whole snapshot under 64 KiB with a large approvals inbox", async () => {
    const hour = 3_600_000;
    const threads: CompositionThread[] = Array.from({ length: 250 }, (_, i) => ({
      id: `thread-cap-${String(i).padStart(4, "0")}`,
      agoMs: 2 * hour + i * 1000,
    }));
    const c = await compose({ home: codexHomeWithThreads(threads), subscribers: 1 });
    c.codex?.start();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      c.timers.tick();
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    const fake = createFakeServices();
    const big: ApprovalsSnapshot = {
      ready: true,
      pending: Array.from({ length: 45 }, (_, i) => summary(i + 1)),
      decided: Array.from({ length: 45 }, (_, i) => summary(i + 100, "approved")),
      expired: [],
      counts: { pending: 45, decided: 45, expired: 0 },
      truncated: false,
    } as unknown as ApprovalsSnapshot;
    fake.snapshot = (budget?: number) => fitApprovalsSnapshotToBudget(big, budget);
    const harness = await startRouteHarness(c.store, {
      approvals: fake as never,
      codex: c.codex?.routeDeps,
    });
    try {
      const reply = await requestOverSocket<unknown>(harness.socketPath, {
        method: "GET",
        path: SNAPSHOT_PATH,
        token: harness.token,
      });
      expect(reply.status).toBe(200);
      const bytes = Buffer.byteLength(JSON.stringify(reply.body), "utf8");
      expect(bytes).toBeLessThanOrEqual(CLIENT_RESPONSE_CAP_BYTES);
      const parsed = SnapshotResponseSchema.parse(reply.body);
      expect(parsed.state.codex?.sessions?.kind).toBe("available");
      expect(parsed.state.approvals?.pending.length ?? 0).toBeGreaterThan(0);
    } finally {
      await harness.close();
    }
  });
});

describe("auth on all nine Codex routes", () => {
  it("a garbage bearer token is refused with one constant body on every path, Codex composed or not", async () => {
    for (const codex of [true, false]) {
      const c = await compose({ codex });
      const bodies = new Set<string>();
      for (const path of READ_PATHS) {
        const reply = await requestOverSocket<unknown>(join(c.dir, "t.sock"), {
          method: "GET",
          path,
          token: "garbage.token.value",
        });
        expect(reply.status, path).toBe(401);
        bodies.add(JSON.stringify(reply.body));
      }
      for (const path of POST_PATHS) {
        const reply = await requestOverSocket<unknown>(join(c.dir, "t.sock"), {
          method: "POST",
          path,
          body: {},
          token: "garbage.token.value",
        });
        expect(reply.status, path).toBe(401);
        bodies.add(JSON.stringify(reply.body));
      }
      expect(bodies.size).toBe(1);
      expect(c.spawner.calls).toHaveLength(0);
    }
  });
});

void mkdirSync;
void waitFor;
