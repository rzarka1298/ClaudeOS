import { randomUUID } from "node:crypto";
import {
  CODEX_HEADROOM_PATH,
  CODEX_USAGE_PATH,
  CodexUsageSnapshotSchema,
  HEALTH_PATH,
  HeadroomSignalSchema,
  SNAPSHOT_PATH,
  SnapshotResponseSchema,
} from "@ccc/domain";
import { saveLauncherConfig } from "@ccc/operational-store";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CodexComposition,
  type CodexCompositionOptions,
  startCodexComposition,
} from "../test-support/codex-composition.js";
import { readFakeLog, weeklyReply } from "../test-support/fake-codex-app-server.js";
import { CODEX_UNAVAILABLE_BODY } from "./route-support.js";

/**
 * Plan 05.1-28 Task 1 (tracer): the composed Codex services answer GET headroom
 * through the REAL request listener against a fake Codex home, a fake
 * app-server and the real Phase 5 usage services. Nothing here opens the
 * owner's runtime directory, the real Codex home or the real bridge state.
 */

const open: CodexComposition[] = [];

afterEach(async () => {
  for (const composition of open.splice(0)) await composition.close();
});

async function compose(options: CodexCompositionOptions): Promise<CodexComposition> {
  const composition = await startCodexComposition(options);
  open.push(composition);
  return composition;
}

/** A status-line snapshot at 62 percent of the five-hour window, as the wrapper forwards it. */
function claudeStatusLine(): Record<string, unknown> {
  return {
    eventId: randomUUID(),
    observedAt: new Date().toISOString(),
    session_id: "sess-codex-composition-1",
    model_id: "claude-opus-4-8",
    version: "2.1.283",
    rate_limits: {
      five_hour: {
        used_percentage: 62,
        resets_at: Math.floor(Date.now() / 1000) + 5 * 3600,
      },
    },
  };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("Task 1 (tracer): GET headroom through the composed services", () => {
  it("Test 1: answers a strict signal with the Codex read and the Claude view", async () => {
    const c = await compose({
      appServer: { read: { kind: "result", result: weeklyReply(41) } },
      usage: "real",
    });
    expect(c.usage?.handleStatusLine(claudeStatusLine())).toBe("applied");

    const reply = await c.get(CODEX_HEADROOM_PATH);

    expect(reply.status).toBe(200);
    const signal = HeadroomSignalSchema.parse(reply.body);
    expect(signal.codex.verdict).toBe("allow");
    expect(signal.codex.reason).toBeNull();
    expect(signal.codex.source).toBe("app-server");
    expect(signal.codex.freshness).toBe("live");
    expect(signal.codex.worstWindow?.usedPercent).toBe(41);
    expect(signal.claude.kind).toBe("available");
    if (signal.claude.kind !== "available") throw new Error("unreachable");
    expect(signal.claude.usedPercent).toBe(62);
    expect(signal.claude.window).toBe("five-hour");
    expect(signal.claude.source).toBe("claude-code-status-line");
    expect(c.appServerStarts()).toBe(1);
  });

  it("Test 1b: the usage route answers the same read as a plain usage snapshot", async () => {
    const c = await compose({
      appServer: { read: { kind: "result", result: weeklyReply(41) } },
    });
    const reply = await c.get(CODEX_USAGE_PATH);
    expect(reply.status).toBe(200);
    const usage = CodexUsageSnapshotSchema.parse(reply.body);
    expect(usage.kind).toBe("available");
  });

  it("Test 2: without the codex member every Codex route is the constant 503 and nothing else changes", async () => {
    const c = await compose({ codex: false });

    const headroom = await c.get(CODEX_HEADROOM_PATH);
    expect(headroom.status).toBe(503);
    expect(headroom.body).toEqual(CODEX_UNAVAILABLE_BODY);

    const health = await c.get(HEALTH_PATH);
    expect(health.status).toBe(200);

    const snapshot = await c.get(SNAPSHOT_PATH);
    expect(snapshot.status).toBe(200);
    const parsed = SnapshotResponseSchema.parse(snapshot.body);
    expect(parsed.state.codex).toBeUndefined();
    expect(JSON.stringify(snapshot.body)).not.toContain("codex");
  });

  it("Test 4: stop() is idempotent, clears every timer it armed and leaves no child process", async () => {
    const c = await compose({
      appServer: { read: { kind: "result", result: weeklyReply(41) } },
    });
    expect(c.codex).toBeDefined();
    c.codex?.start();
    expect(c.timers.armed()).toBeGreaterThan(0);

    await c.get(CODEX_HEADROOM_PATH);
    const pids = (c.appServer === null ? [] : readFakeLog(c.appServer.logPath)).flatMap((entry) =>
      entry.t === "start" ? [entry.pid] : [],
    );
    expect(pids.length).toBeGreaterThan(0);

    await c.codex?.stop();
    await c.codex?.stop();

    expect(c.timers.armed()).toBe(0);
    for (const pid of pids) expect(pidAlive(pid)).toBe(false);
  });

  it("Test 4b: stop() kills a read that is still in flight", async () => {
    const c = await compose({ appServer: { read: { kind: "hang" } } });
    const pending = c.get(CODEX_HEADROOM_PATH);
    const deadline = Date.now() + 5000;
    while (c.appServerStarts() === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(c.appServerStarts()).toBe(1);
    const pids = (c.appServer === null ? [] : readFakeLog(c.appServer.logPath)).flatMap((entry) =>
      entry.t === "start" ? [entry.pid] : [],
    );

    await c.codex?.stop();

    for (const pid of pids) expect(pidAlive(pid)).toBe(false);
    const reply = await pending;
    expect(reply.status).toBe(200);
    expect(HeadroomSignalSchema.parse(reply.body).codex.verdict).toBe("refuse");
  });

  it("Test 5: with no saved Codex row nothing is spawned; saving a row makes the next read spawn the fake", async () => {
    const clock = { ms: Date.now() };
    const c = await compose({
      appServer: { read: { kind: "result", result: weeklyReply(41) } },
      saveRow: false,
      now: () => clock.ms,
    });

    const headroom = await c.get(CODEX_HEADROOM_PATH);
    expect(headroom.status).toBe(200);
    const signal = HeadroomSignalSchema.parse(headroom.body);
    expect(signal.codex.verdict).toBe("refuse");
    expect(signal.codex.reason).toBe("usage-unavailable");

    const usage = await c.get(CODEX_USAGE_PATH);
    expect(usage.status).toBe(200);
    expect(CodexUsageSnapshotSchema.parse(usage.body).kind).toBe("unavailable");
    expect(c.appServerStarts()).toBe(0);

    if (c.appServer === null) throw new Error("unreachable");
    saveLauncherConfig(c.store.db, "codex", { executablePath: c.appServer.path, args: [] });
    clock.ms += 30_000;

    const after = await c.get(CODEX_HEADROOM_PATH);
    expect(HeadroomSignalSchema.parse(after.body).codex.verdict).toBe("allow");
    expect(c.appServerStarts()).toBe(1);
  });
});
