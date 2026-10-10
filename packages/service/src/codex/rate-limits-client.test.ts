import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexUsageSnapshotSchema } from "@ccc/domain";
import { afterAll, describe, expect, it } from "vitest";
import {
  FAKE_ACCOUNT_ID,
  type FakeAppServerScenario,
  type FakeLogEntry,
  readFakeLog,
  weeklyReply,
  writeFakeAppServer,
} from "../test-support/fake-codex-app-server.js";
import { createRateLimitsClient } from "./rate-limits-client.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ccc-rl-"));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const NOW_MS = Date.UTC(2026, 9, 10, 12, 0, 0);

function fake(scenario: FakeAppServerScenario) {
  return writeFakeAppServer(tempDir(), scenario);
}

function startOf(log: readonly FakeLogEntry[]) {
  const start = log.find((entry) => entry.t === "start");
  if (start?.t !== "start") throw new Error("the fake never started");
  return start;
}

function linesOf(log: readonly FakeLogEntry[]): unknown[] {
  return log.flatMap((entry) => (entry.t === "line" ? [JSON.parse(entry.line)] : []));
}

/** True while a process with this pid exists (signal 0 sends nothing). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("createRateLimitsClient (tracer, CODEX-08, CODEX-09, D-21)", () => {
  it("Test 1: a weekly-window reply becomes a normalised snapshot without the account id", async () => {
    const server = fake({ read: { kind: "result", result: weeklyReply(41) } });
    const client = createRateLimitsClient({ executablePath: () => server.path, now: () => NOW_MS });
    const snapshot = await client.read();
    expect(snapshot.kind).toBe("available");
    if (snapshot.kind !== "available") return;
    expect(snapshot.source).toBe("app-server");
    expect(snapshot.windows).toHaveLength(1);
    expect(snapshot.windows[0]?.windowMinutes).toBe(10_080);
    expect(snapshot.windows[0]?.usedPercent).toBe(41);
    expect(CodexUsageSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain(FAKE_ACCOUNT_ID);
  });

  it("Test 2: the child received argv [app-server] and exactly the three messages, in order", async () => {
    const server = fake({ read: { kind: "result", result: weeklyReply(41) } });
    const client = createRateLimitsClient({ executablePath: () => server.path, now: () => NOW_MS });
    await client.read();
    const log = readFakeLog(server.logPath);
    expect(startOf(log).argv).toEqual(["app-server"]);
    const lines = linesOf(log) as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ id: 1, method: "initialize" });
    const params = lines[0]?.params as { clientInfo: { name: string } };
    expect(params.clientInfo.name).toBe("ccc_codex_collector");
    expect(lines[1]).toEqual({ method: "initialized" });
    expect(lines[2]).toEqual({
      id: 2,
      method: "account/rateLimits/read",
      params: { excludeResetCreditDetails: true, supportsLunaReserve: false },
    });
  });

  it("Test 3: the child environment holds exactly the allowlisted names", async () => {
    const server = fake({ read: { kind: "result", result: weeklyReply(41) } });
    const client = createRateLimitsClient({ executablePath: () => server.path, now: () => NOW_MS });
    await client.read();
    expect(startOf(readFakeLog(server.logPath)).envKeys).toEqual(["HOME", "LC_ALL", "PATH"]);

    const withHome = fake({ read: { kind: "result", result: weeklyReply(41) } });
    const configured = createRateLimitsClient({
      executablePath: () => withHome.path,
      codexHome: () => "/Users/USERNAME/codex-home",
      now: () => NOW_MS,
    });
    await configured.read();
    expect(startOf(readFakeLog(withHome.logPath)).envKeys).toEqual([
      "CODEX_HOME",
      "HOME",
      "LC_ALL",
      "PATH",
    ]);
  });

  it("Test 4: the child is gone once read() has resolved", async () => {
    const server = fake({ read: { kind: "result", result: weeklyReply(41) } });
    const client = createRateLimitsClient({ executablePath: () => server.path, now: () => NOW_MS });
    await client.read();
    const { pid } = startOf(readFakeLog(server.logPath));
    expect(alive(pid)).toBe(false);
  });

  it("Test 5: with no executable path read() answers unavailable read-failed without spawning", async () => {
    const client = createRateLimitsClient({ executablePath: () => null, now: () => NOW_MS });
    const snapshot = await client.read();
    expect(snapshot).toEqual({
      kind: "unavailable",
      reason: "read-failed",
      version: null,
      observedAt: new Date(NOW_MS).toISOString(),
    });
  });
});
