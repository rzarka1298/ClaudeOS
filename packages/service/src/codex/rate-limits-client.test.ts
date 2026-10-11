import { spawn } from "node:child_process";
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

// --- Task 2: the scenario matrix ----------------------------------------------

type ClientOverrides = Partial<Parameters<typeof createRateLimitsClient>[0]>;

interface Run {
  readonly snapshot: Awaited<ReturnType<ReturnType<typeof createRateLimitsClient>["read"]>>;
  readonly log: FakeLogEntry[];
  readonly logged: unknown[];
}

async function run(scenario: FakeAppServerScenario, over: ClientOverrides = {}): Promise<Run> {
  const server = fake(scenario);
  const logged: unknown[] = [];
  const client = createRateLimitsClient({
    executablePath: () => server.path,
    now: () => NOW_MS,
    logger: { warn: (fields, message) => logged.push([fields, message]) },
    ...over,
  });
  const snapshot = await client.read();
  const log = readFakeLog(server.logPath);
  expect(alive(startOf(log).pid)).toBe(false);
  return { snapshot, log, logged };
}

function windowsOf(r: Run) {
  if (r.snapshot.kind !== "available")
    throw new Error(`expected available, got ${r.snapshot.reason}`);
  return r.snapshot.windows;
}

function reasonOf(r: Run): string {
  if (r.snapshot.kind !== "unavailable") throw new Error("expected unavailable");
  return r.snapshot.reason;
}

const SHORT = { capMs: 800, killWaitMs: 150 } as const;
const TIMEOUT = 8000;

describe("createRateLimitsClient spawn options (T-05.1-08, rule 8)", () => {
  it("starts the child with an argument array, no shell and piped stdin and stdout", async () => {
    const server = fake({ read: { kind: "result", result: weeklyReply(41) } });
    const seen: Array<{ file: string; args: readonly string[]; options: unknown }> = [];
    const client = createRateLimitsClient({
      executablePath: () => server.path,
      now: () => NOW_MS,
      spawn: (file, args, options) => {
        seen.push({ file, args, options });
        return spawn(file, [...args], { ...options, env: { ...options.env } });
      },
    });
    await client.read();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.file).toBe(server.path);
    expect(seen[0]?.args).toEqual(["app-server"]);
    expect(seen[0]?.options).toMatchObject({
      shell: false,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
  });
});

describe("createRateLimitsClient scenario matrix (T-05.1-06, T-05.1-11, T-05.1-12)", () => {
  it("Test 1a: two windows are both kept", async () => {
    const r = await run({
      read: {
        kind: "result",
        result: weeklyReply(45, {
          rateLimits: {
            primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1_789_990_000 },
            secondary: { usedPercent: 45, windowDurationMins: 10_080, resetsAt: 1_790_000_000 },
          },
        }),
      },
    });
    expect(windowsOf(r).map((w) => [w.windowMinutes, w.usedPercent])).toEqual([
      [300, 20],
      [10_080, 45],
    ]);
  });

  it("Test 1b: a reached type, allowed false and allowed null all stay available", async () => {
    const reached = await run({
      read: {
        kind: "result",
        result: weeklyReply(100, {
          rateLimits: {
            primary: { usedPercent: 100, windowDurationMins: 10_080, resetsAt: null },
            rateLimitReachedType: "rate_limit_reached",
          },
        }),
      },
    });
    expect(reached.snapshot).toMatchObject({
      kind: "available",
      rateLimitReached: true,
      rateLimitReachedType: "rate_limit_reached",
    });
    const notAllowed = await run({
      read: { kind: "result", result: weeklyReply(10, { ordinaryUsageAllowed: false }) },
    });
    expect(notAllowed.snapshot).toMatchObject({ kind: "available", ordinaryUsageAllowed: false });
    const unknown = await run({
      read: { kind: "result", result: weeklyReply(10, { ordinaryUsageAllowed: null }) },
    });
    expect(unknown.snapshot).toMatchObject({ kind: "available", ordinaryUsageAllowed: null });
  });

  it("Test 1c: an absent rateLimits member is no-limits and an error reply is read-failed", async () => {
    const absent = await run({
      read: { kind: "result", result: { accountId: FAKE_ACCOUNT_ID } },
    });
    expect(reasonOf(absent)).toBe("no-limits");
    const error = await run({ read: { kind: "error" } });
    expect(reasonOf(error)).toBe("read-failed");
  });

  it("Test 1d: unknown keys at every level change nothing", async () => {
    const plain = await run({ read: { kind: "result", result: weeklyReply(41) } });
    const noisy = await run({
      read: {
        kind: "result",
        result: {
          ...weeklyReply(41),
          futureTopLevel: { a: 1 },
          rateLimits: {
            limitId: "codex",
            futureMember: [1, 2],
            primary: {
              usedPercent: 41,
              windowDurationMins: 10_080,
              resetsAt: 1_790_000_000,
              futureWindowMember: "x",
            },
            secondary: null,
            planType: "prolite",
            rateLimitReachedType: null,
          },
        },
      },
    });
    expect(windowsOf(noisy)).toEqual(windowsOf(plain));
  });

  it("Test 1e: percent shapes: float kept, over 100 clamped, string/negative/non-object are shape-changed", async () => {
    expect(
      windowsOf(await run({ read: { kind: "result", result: weeklyReply(41.5) } }))[0]?.usedPercent,
    ).toBe(41.5);
    expect(
      windowsOf(await run({ read: { kind: "result", result: weeklyReply(130) } }))[0]?.usedPercent,
    ).toBe(100);
    for (const bad of ["41", -5]) {
      const r = await run({ read: { kind: "result", result: weeklyReply(bad) } });
      expect(reasonOf(r)).toBe("shape-changed");
      expect(JSON.stringify(r.snapshot)).not.toContain("41");
    }
    const nonObject = await run({ read: { kind: "result", result: "not an object" } });
    expect(reasonOf(nonObject)).toBe("shape-changed");
  });

  it("Test 2: banner noise, a notification, out-of-order ids and a duplicate reply are ignored", async () => {
    const r = await run({
      read: { kind: "result", result: weeklyReply(41) },
      banner: true,
      notificationBeforeReply: true,
      outOfOrderIds: true,
      duplicateReply: true,
    });
    expect(windowsOf(r)).toHaveLength(1);
    expect(windowsOf(r)[0]?.usedPercent).toBe(41);
  });

  it(
    "Test 3a: an oversized line ends the read as read-failed and the child is killed",
    async () => {
      const r = await run(
        { read: { kind: "oversized-line", bytes: 5000 } },
        { ...SHORT, capMs: 5000, lineCapBytes: 1024, totalCapBytes: 64 * 1024 },
      );
      expect(reasonOf(r)).toBe("read-failed");
    },
    TIMEOUT,
  );

  it(
    "Test 3b: an endless stream without a newline ends the read as read-failed",
    async () => {
      const r = await run(
        { read: { kind: "endless" } },
        { ...SHORT, capMs: 5000, lineCapBytes: 10_000_000, totalCapBytes: 40_000 },
      );
      expect(reasonOf(r)).toBe("read-failed");
    },
    TIMEOUT,
  );

  it(
    "Test 4a: crashes before and after initialize resolve read-failed",
    async () => {
      const early = await run({ read: { kind: "hang" }, crashOnStart: true }, SHORT);
      expect(reasonOf(early)).toBe("read-failed");
      const late = await run({ read: { kind: "crash-after-initialize" } }, SHORT);
      expect(reasonOf(late)).toBe("read-failed");
      const refused = await run({ read: { kind: "hang" }, initializeError: true }, SHORT);
      expect(reasonOf(refused)).toBe("read-failed");
    },
    TIMEOUT,
  );

  it(
    "Test 4b: a hang resolves read-failed at the injected cap and leaves no child",
    async () => {
      const started = Date.now();
      const r = await run({ read: { kind: "hang" } }, SHORT);
      expect(reasonOf(r)).toBe("read-failed");
      expect(Date.now() - started).toBeLessThan(5000);
    },
    TIMEOUT,
  );

  it(
    "Test 5: a child that ignores the default termination signal is ended by the escalation",
    async () => {
      const started = Date.now();
      const r = await run(
        { read: { kind: "result", result: weeklyReply(41) }, ignoreTermination: true },
        SHORT,
      );
      expect(windowsOf(r)[0]?.usedPercent).toBe(41);
      expect(Date.now() - started).toBeGreaterThanOrEqual(SHORT.killWaitMs - 20);
    },
    TIMEOUT,
  );

  it("Test 6: simultaneous reads share one child; a later read starts a fresh one", async () => {
    const server = fake({ read: { kind: "result", result: weeklyReply(41) } });
    const client = createRateLimitsClient({ executablePath: () => server.path, now: () => NOW_MS });
    const [a, b] = await Promise.all([client.read(), client.read()]);
    expect(a).toEqual(b);
    expect(readFakeLog(server.logPath).filter((e) => e.t === "start")).toHaveLength(1);
    await client.read();
    expect(readFakeLog(server.logPath).filter((e) => e.t === "start")).toHaveLength(2);
  });

  it(
    "Test 7: dispose() during an in-flight read kills the child and resolves read-failed",
    async () => {
      const server = fake({ read: { kind: "hang" } });
      const client = createRateLimitsClient({
        executablePath: () => server.path,
        now: () => NOW_MS,
        capMs: 10_000,
        killWaitMs: 150,
      });
      const pending = client.read();
      const deadline = Date.now() + 4000;
      while (readFakeLog(server.logPath).filter((e) => e.t === "line").length < 3) {
        if (Date.now() > deadline) throw new Error("the fake never saw the read request");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      client.dispose();
      const snapshot = await pending;
      expect(snapshot).toMatchObject({ kind: "unavailable", reason: "read-failed" });
      expect(alive(startOf(readFakeLog(server.logPath)).pid)).toBe(false);
      expect(await client.read()).toMatchObject({ kind: "unavailable", reason: "read-failed" });
    },
    TIMEOUT,
  );

  it(
    "Test 8: the account id appears in no snapshot, no log call and no thrown value",
    async () => {
      const scenarios: FakeAppServerScenario[] = [
        { read: { kind: "result", result: weeklyReply(41) }, stderrNoise: true },
        { read: { kind: "result", result: weeklyReply("41") } },
        { read: { kind: "result", result: { accountId: FAKE_ACCOUNT_ID } } },
        { read: { kind: "error" }, stderrNoise: true },
        {
          read: { kind: "result", result: weeklyReply(41) },
          notificationBeforeReply: true,
          duplicateReply: true,
        },
        { read: { kind: "crash-after-initialize" }, stderrNoise: true },
      ];
      for (const scenario of scenarios) {
        const r = await run(scenario, SHORT);
        expect(JSON.stringify(r.snapshot)).not.toContain(FAKE_ACCOUNT_ID);
        expect(JSON.stringify(r.logged)).not.toContain(FAKE_ACCOUNT_ID);
      }
    },
    TIMEOUT,
  );
});
