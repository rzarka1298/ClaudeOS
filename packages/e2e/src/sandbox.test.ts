import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { CleanupResult } from "./keychain-cleanup.js";
import { appendLedger, type ProcessEntry } from "./ledger.js";
import { type SandboxOptions, withSandbox } from "./sandbox.js";

let base: string;

beforeEach(() => {
  base = mkdtempSync("/tmp/ccc-e2e-sb.");
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const NEVER = (): Promise<void> => new Promise<void>(() => undefined);
const START = "Sun Oct 11 10:00:01 2026";

interface FakeService {
  pid: number;
  stop: Mock<() => Promise<void>>;
  kill: Mock<() => Promise<void>>;
}

/** A service handle whose process lives in the fake table until stop (or kill) removes it. */
function fakeService(
  table: ProcessEntry[],
  pid: number,
  opts: { exitsOnStop: boolean; exitsOnKill?: boolean },
): FakeService {
  table.push({ pid, start: START, command: "node /repo/packages/service/dist/main.js" });
  const remove = (): void => {
    const at = table.findIndex((entry) => entry.pid === pid);
    if (at >= 0) table.splice(at, 1);
  };
  return {
    pid,
    stop: vi.fn(() => {
      if (!opts.exitsOnStop) return new Promise<void>(() => undefined);
      remove();
      return Promise.resolve();
    }),
    kill: vi.fn(() => {
      if (opts.exitsOnKill ?? true) remove();
      return Promise.resolve();
    }),
  };
}

function baseOptions(
  table: ProcessEntry[],
  overrides: Omit<Partial<SandboxOptions>, "deleteAccount"> & {
    deleteAccount?: Mock<(account: string) => Promise<CleanupResult>>;
  } = {},
): SandboxOptions & { deleteAccount: Mock<(account: string) => Promise<CleanupResult>> } {
  return {
    base,
    home: join(base, "home"),
    env: {},
    platform: "darwin",
    ownerPid: 99990,
    readTable: () => Promise.resolve([...table]),
    deleteAccount: vi.fn<(account: string) => Promise<CleanupResult>>(() =>
      Promise.resolve("deleted"),
    ),
    wait: NEVER,
    ...overrides,
  };
}

describe("withSandbox sweep wiring (Task 2, Test 7)", () => {
  it("calls the sweep before creating a new run root and returns its summary", async () => {
    const table: ProcessEntry[] = [];
    const order: string[] = [];
    const summary = {
      status: "swept" as const,
      terminated: [1],
      accountsDeleted: ["ccc-uat-old00001"],
      removed: ["/tmp/ccc-uat.old000"],
      stillAlive: [],
      errors: [],
    };
    const sweep = vi.fn(() => {
      order.push(`sweep:${readdirSync(base).length}`);
      return Promise.resolve(summary);
    });
    const outcome = await withSandbox(baseOptions(table, { sweep }), () => {
      order.push(`body:${readdirSync(base).length}`);
      return Promise.resolve();
    });
    expect(order).toEqual(["sweep:0", "body:1"]);
    expect(outcome.sweep).toEqual(summary);
  });

  it("throws a fixed 'another UAT run is active' error without creating anything when the sweep is busy", async () => {
    const table: ProcessEntry[] = [];
    const sweep = vi.fn(() =>
      Promise.resolve({ status: "busy" as const, runRoot: "/tmp/ccc-uat.abc123" }),
    );
    const body = vi.fn(() => Promise.resolve());
    await expect(withSandbox(baseOptions(table, { sweep }), body)).rejects.toThrow(
      /another UAT run is active/i,
    );
    expect(body).not.toHaveBeenCalled();
    expect(readdirSync(base)).toEqual([]);
  });

  it("the default sweep removes a stale run root left by a dead owner", async () => {
    const table: ProcessEntry[] = [];
    const stale = join(base, "ccc-uat.stale1");
    mkdirSync(stale);
    appendLedger(join(stale, "ledger.jsonl"), {
      kind: "run",
      runId: "deadbeef",
      runRoot: stale,
      startedAt: "2026-10-11T10:00:00.000Z",
      ownerPid: 88888,
      ownerStart: "Sun Oct 11 09:00:00 2026",
    });
    appendLedger(join(stale, "ledger.jsonl"), { kind: "account", account: "ccc-uat-deadbeef" });
    const options = baseOptions(table);
    const outcome = await withSandbox(options, () => Promise.resolve());
    expect(existsSync(stale)).toBe(false);
    expect(outcome.sweep.status).toBe("swept");
    expect(options.deleteAccount).toHaveBeenCalledWith("ccc-uat-deadbeef");
  });
});

describe("withSandbox tracer (Test 9)", () => {
  it("tears everything down after a failing body: stop, account delete, root removed, no leaks", async () => {
    const table: ProcessEntry[] = [];
    const options = baseOptions(table);
    const service = fakeService(table, 5001, { exitsOnStop: true });
    let observedRoot = "";
    let observedAccount = "";
    const boom = new Error("body failed");

    const outcome = await withSandbox(options, async (sandbox) => {
      observedRoot = sandbox.paths.root;
      observedAccount = sandbox.account;
      expect(existsSync(sandbox.paths.ledgerPath)).toBe(true);
      await sandbox.registerService(service);
      throw boom;
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe(boom);
    expect(outcome.leaks).toEqual([]);
    expect(outcome.cleanupErrors).toEqual([]);
    expect(service.stop).toHaveBeenCalledTimes(1);
    expect(service.kill).not.toHaveBeenCalled();
    expect(options.deleteAccount).toHaveBeenCalledTimes(1);
    expect(options.deleteAccount).toHaveBeenCalledWith(observedAccount);
    expect(observedAccount).toBe(`ccc-uat-${outcome.runId}`);
    expect(existsSync(observedRoot)).toBe(false);
    expect(readdirSync(base)).toEqual([]);
  });

  it("returns the body's value when everything is clean", async () => {
    const table: ProcessEntry[] = [];
    const outcome = await withSandbox(baseOptions(table), () => Promise.resolve(42));
    expect(outcome.ok).toBe(true);
    expect(outcome.value).toBe(42);
    expect(outcome.error).toBeUndefined();
  });

  it("deletes every registered account once, in addition to the run account", async () => {
    const table: ProcessEntry[] = [];
    const options = baseOptions(table);
    await withSandbox(options, async (sandbox) => {
      await sandbox.registerAccount("ccc-uat-extra01");
      await sandbox.registerAccount("ccc-uat-extra01");
    });
    const calls = options.deleteAccount.mock.calls.map((call) => call[0]).sort();
    expect(calls).toHaveLength(2);
    expect(calls).toContain("ccc-uat-extra01");
  });

  it("refuses to register the default install-secret account", async () => {
    const table: ProcessEntry[] = [];
    const options = baseOptions(table);
    const outcome = await withSandbox(options, async (sandbox) => {
      await sandbox.registerAccount("install-secret");
    });
    expect(outcome.ok).toBe(false);
    expect(options.deleteAccount).toHaveBeenCalledTimes(1);
  });

  it("escalates to kill after the injected deadline and reports a leak when the process stays", async () => {
    const table: ProcessEntry[] = [];
    const options = baseOptions(table, { wait: () => Promise.resolve() });
    const service = fakeService(table, 5002, { exitsOnStop: false, exitsOnKill: false });
    let root = "";

    const outcome = await withSandbox(options, async (sandbox) => {
      root = sandbox.paths.root;
      await sandbox.registerService(service);
    });

    expect(service.stop).toHaveBeenCalledTimes(1);
    expect(service.kill).toHaveBeenCalledTimes(1);
    expect(outcome.ok).toBe(false);
    expect(outcome.leaks).toEqual([
      expect.objectContaining({ pid: 5002, reason: "ledgered process still alive" }),
    ]);
    // A leaked root is kept for the next start's sweep, and the account is still deleted.
    expect(existsSync(root)).toBe(true);
    expect(options.deleteAccount).toHaveBeenCalledTimes(1);
  });

  it("flags a process that merely names the run root, and excludes the runner itself", async () => {
    const table: ProcessEntry[] = [];
    const options = baseOptions(table);
    let root = "";
    const outcome = await withSandbox(options, async (sandbox) => {
      root = sandbox.paths.root;
      table.push({
        pid: 6001,
        start: START,
        command: `/Applications/Obsidian.app --user-data-dir=${root}/wdio/x`,
      });
      table.push({ pid: 99990, start: START, command: `node runner ${root}` });
    });
    expect(outcome.leaks.map((leak) => leak.pid)).toEqual([6001]);
    expect(outcome.ok).toBe(false);
    expect(existsSync(root)).toBe(true);
  });

  it("records a cleanup failure without hiding the body's own error", async () => {
    const table: ProcessEntry[] = [];
    const options = baseOptions(table, {
      deleteAccount: vi.fn<(account: string) => Promise<CleanupResult>>(() =>
        Promise.reject(new Error("keychain locked")),
      ),
    });
    const boom = new Error("body failed");
    const outcome = await withSandbox(options, () => Promise.reject(boom));
    expect(outcome.error).toBe(boom);
    expect(outcome.cleanupErrors).toHaveLength(1);
    expect(outcome.ok).toBe(false);
  });

  it("refuses in CI and off darwin before creating anything", async () => {
    const table: ProcessEntry[] = [];
    await expect(
      withSandbox(baseOptions(table, { env: { CI: "true" } }), () => Promise.resolve(1)),
    ).rejects.toThrow(/CI/);
    await expect(
      withSandbox(baseOptions(table, { platform: "linux" }), () => Promise.resolve(1)),
    ).rejects.toThrow(/macOS/);
    expect(readdirSync(base)).toEqual([]);
  });

  it("scrubs inherited overrides from the injected environment before the body runs", async () => {
    const table: ProcessEntry[] = [];
    const env: Record<string, string | undefined> = {
      PATH: "/usr/bin",
      CCC_ENABLE_TEST_OVERRIDES: "1",
      CCC_SOCKET_PATH: "/somewhere/svc.sock",
    };
    let seen: Record<string, string | undefined> = {};
    await withSandbox(baseOptions(table, { env }), () => {
      seen = { ...env };
      return Promise.resolve();
    });
    expect(seen).toEqual({ PATH: "/usr/bin" });
  });
});
