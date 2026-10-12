import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CleanupResult } from "./keychain-cleanup.js";
import { appendLedger, type ProcessEntry } from "./ledger.js";
import { createRunRoot } from "./run-root.js";
import { type SandboxOptions, type Stoppable, stopWithDeadline, withSandbox } from "./sandbox.js";
import { createServiceFixture } from "./service-fixture.js";
import { executeSweep, type SweepPlan } from "./sweep.js";

/**
 * Wave 2 review MEDIUM-2 (parent teardown, early ledgering, signals, identity-matched leftovers),
 * LOW-1 (sweep re-verifies identity before TERM) and LOW-2 (stopWithDeadline).
 */

let base: string;
beforeEach(() => {
  base = mkdtempSync("/tmp/ccc-e2e-td.");
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const START = "Sun Oct 11 10:00:01 2026";
const OTHER_START = "Mon Oct 12 11:11:11 2026";
const SERVICE_MARKER = "/repo/packages/service/dist/main.js";
const immediate = (): Promise<void> => Promise.resolve();

function options(
  table: ProcessEntry[],
  extra: Partial<SandboxOptions> = {},
): SandboxOptions & { sent: number[] } {
  const sent: number[] = [];
  return {
    base,
    home: join(base, "home"),
    env: {},
    platform: "darwin",
    ownerPid: 99990,
    readTable: () => Promise.resolve([...table]),
    deleteAccount: () => Promise.resolve<CleanupResult>("deleted"),
    wait: immediate,
    sweep: () => Promise.resolve({ status: "none" as const }),
    signals: { on: () => undefined, off: () => undefined },
    sendTerm: (pid: number) => {
      sent.push(pid);
      const at = table.findIndex((row) => row.pid === pid);
      if (at >= 0) table.splice(at, 1);
      return Promise.resolve();
    },
    sent,
    ...extra,
  } as SandboxOptions & { sent: number[] };
}

describe("parent teardown stops services a spec ledgered (MEDIUM-2a)", () => {
  it("terminates a ledgered, identity-matching service the handle list never saw", async () => {
    const table: ProcessEntry[] = [];
    const opts = options(table);
    const outcome = await withSandbox(opts, (sandbox) => {
      table.push({ pid: 555, start: START, command: `node ${SERVICE_MARKER}` });
      appendLedger(sandbox.paths.ledgerPath, {
        kind: "pid",
        role: "service",
        pid: 555,
        start: START,
        marker: SERVICE_MARKER,
      });
      return Promise.resolve();
    });
    expect(opts.sent).toEqual([555]);
    expect(outcome.leaks).toEqual([]);
    expect(outcome.cleanupErrors).toEqual([]);
    expect(outcome.runRootRemoved).toBe(true);
  });

  it("never signals a recycled pid (same pid, other start time)", async () => {
    const table: ProcessEntry[] = [];
    const opts = options(table);
    await withSandbox(opts, (sandbox) => {
      table.push({ pid: 556, start: OTHER_START, command: "/usr/bin/vim" });
      appendLedger(sandbox.paths.ledgerPath, {
        kind: "pid",
        role: "service",
        pid: 556,
        start: START,
        marker: SERVICE_MARKER,
      });
      return Promise.resolve();
    });
    expect(opts.sent).toEqual([]);
  });

  it("never signals the owner process, even if the ledger names it", async () => {
    const table: ProcessEntry[] = [{ pid: 99990, start: START, command: "node cli.js" }];
    const opts = options(table);
    await withSandbox(opts, (sandbox) => {
      appendLedger(sandbox.paths.ledgerPath, {
        kind: "pid",
        role: "service",
        pid: 99990,
        start: START,
      });
      return Promise.resolve();
    });
    expect(opts.sent).toEqual([]);
  });

  it("a hard-killed wdio leaves an Obsidian naming the run root: ledgered with its identity, then terminated", async () => {
    const table: ProcessEntry[] = [];
    const opts = options(table);
    let ledgerPath = "";
    const outcome = await withSandbox(opts, (sandbox) => {
      ledgerPath = sandbox.paths.ledgerPath;
      table.push({
        pid: 700,
        start: START,
        command: `/Applications/Obsidian.app/Contents/MacOS/Obsidian --user-data-dir=${sandbox.paths.root}/obsidian`,
      });
      table.push({ pid: 701, start: START, command: "/usr/bin/vim notes.md" });
      return Promise.resolve();
    });
    expect(opts.sent).toEqual([700]);
    expect(outcome.leaks.map((leak) => leak.pid)).toEqual([]);
    expect(ledgerPath).not.toBe("");
  });

  it("an Obsidian that survives TERM stays a leak and the run root is kept", async () => {
    const table: ProcessEntry[] = [];
    const opts = options(table, { sendTerm: () => Promise.resolve() });
    const outcome = await withSandbox(opts, (sandbox) => {
      table.push({
        pid: 700,
        start: START,
        command: `Obsidian --user-data-dir=${sandbox.paths.root}/obsidian`,
      });
      return Promise.resolve();
    });
    expect(outcome.leaks.length).toBeGreaterThan(0);
    expect(outcome.runRootRemoved).toBe(false);
    expect(outcome.ok).toBe(false);
  });
});

describe("signal handlers run the same teardown (MEDIUM-2c)", () => {
  it("SIGINT tears the sandbox down once and exits 130; handlers are removed afterwards", async () => {
    const table: ProcessEntry[] = [];
    const handlers = new Map<string, () => void>();
    const offs: string[] = [];
    const exit = vi.fn();
    const opts = options(table, {
      signals: {
        on: (signal: string, fn: () => void) => handlers.set(signal, fn),
        off: (signal: string) => offs.push(signal),
      },
      exit,
    });
    let finish: () => void = () => undefined;
    const run = withSandbox(opts, (sandbox) => {
      table.push({ pid: 800, start: START, command: `node ${SERVICE_MARKER}` });
      appendLedger(sandbox.paths.ledgerPath, {
        kind: "pid",
        role: "service",
        pid: 800,
        start: START,
        marker: SERVICE_MARKER,
      });
      return new Promise<void>((done) => {
        finish = done;
      });
    });
    await vi.waitFor(() => expect(handlers.has("SIGINT")).toBe(true));
    expect(handlers.has("SIGTERM")).toBe(true);
    handlers.get("SIGINT")?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(130));
    expect(opts.sent).toEqual([800]);
    finish();
    const outcome = await run;
    expect(opts.sent).toEqual([800]);
    expect(outcome.leaks).toEqual([]);
    expect(offs.sort()).toEqual(["SIGINT", "SIGTERM"]);
  });
});

describe("early ledgering of the service pid (MEDIUM-2b)", () => {
  it("the fixture ledgers the pid when the process spawns, before the socket is ready", async () => {
    const events: string[] = [];
    const sandbox = {
      paths: createRunRoot({ base }),
      account: "ccc-uat-0123abcd",
      registerService: vi.fn(() => Promise.resolve()),
      recordSpawn: vi.fn((pid: number) => {
        events.push(`ledger:${pid}`);
        return Promise.resolve();
      }),
      unregister: vi.fn(),
    };
    const fixture = createServiceFixture(sandbox as never, {
      startService: async (args) => {
        const spawnHook = (args as { onSpawn?: (pid: number) => Promise<void> | void }).onSpawn;
        await spawnHook?.(4242);
        events.push("socket-wait");
        return { pid: 4242, stop: immediate, kill: immediate } as Stoppable;
      },
      home: join(base, "home"),
    });
    await fixture.start();
    expect(events).toEqual(["ledger:4242", "socket-wait"]);
  });
});

describe("executeSweep re-verifies identity before TERM (LOW-1)", () => {
  const plan: SweepPlan = {
    busy: null,
    runs: [
      {
        runRoot: "/tmp/ccc-uat.abc123",
        actions: [
          { type: "terminate", pid: 4242, role: "service", start: START, marker: SERVICE_MARKER },
        ],
        manual: [],
      },
    ],
  };
  function deps(table: ProcessEntry[]) {
    return {
      sendTerm: vi.fn(() => Promise.resolve()),
      deleteAccount: vi.fn(() => Promise.resolve("deleted")),
      removeDir: vi.fn(),
      removeRunRoot: vi.fn(),
      readTable: () => Promise.resolve(table),
      wait: immediate,
    };
  }

  it("does not signal a pid that now belongs to another process", async () => {
    const d = deps([{ pid: 4242, start: OTHER_START, command: "/usr/bin/vim" }]);
    await executeSweep(plan, d);
    expect(d.sendTerm).not.toHaveBeenCalled();
  });

  it("does not signal when the marker no longer matches", async () => {
    const d = deps([{ pid: 4242, start: START, command: "/usr/bin/vim" }]);
    await executeSweep(plan, d);
    expect(d.sendTerm).not.toHaveBeenCalled();
  });

  it("signals when pid, start and marker all still match", async () => {
    const d = deps([{ pid: 4242, start: START, command: `node ${SERVICE_MARKER}` }]);
    await executeSweep(plan, d);
    expect(d.sendTerm).toHaveBeenCalledWith(4242);
  });
});

describe("stopWithDeadline (LOW-2)", () => {
  it("treats a rejected stop as not exited and calls kill", async () => {
    const handle = {
      pid: 1,
      stop: vi.fn(() => Promise.reject(new Error("boom"))),
      kill: vi.fn(() => Promise.resolve()),
    };
    await stopWithDeadline(handle, () => new Promise<void>(() => undefined), 5000);
    expect(handle.kill).toHaveBeenCalledTimes(1);
  });

  it("gives kill its own deadline and then reports instead of hanging", async () => {
    const handle = {
      pid: 1,
      stop: () => new Promise<void>(() => undefined),
      kill: () => new Promise<void>(() => undefined),
    };
    await expect(stopWithDeadline(handle, immediate, 5000)).rejects.toThrow(/did not exit/i);
  });

  it("does not call kill when stop completes", async () => {
    const handle = {
      pid: 1,
      stop: vi.fn(() => Promise.resolve()),
      kill: vi.fn(() => Promise.resolve()),
    };
    await stopWithDeadline(handle, () => new Promise<void>(() => undefined), 5000);
    expect(handle.kill).not.toHaveBeenCalled();
  });
});
