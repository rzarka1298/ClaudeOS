import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessEntry } from "./ledger.js";
import { realWait, stopWithDeadline, withSandbox } from "./sandbox.js";
import { executeSweep, type SweepPlan } from "./sweep.js";

/** Codex findings 1 (cleanup timers) and 5 (a failed Keychain cleanup keeps its ledger). */

let base: string;
beforeEach(() => {
  base = mkdtempSync("/tmp/ccc-e2e-cl.");
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("cleanup timers (Codex 1)", () => {
  it("an awaited cleanup wait keeps the process alive (the timer is referenced)", async () => {
    const spy = vi.spyOn(globalThis, "setTimeout");
    const controller = new AbortController();
    const waiting = realWait(60_000, controller.signal);
    const timer = spy.mock.results[0]?.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(true);
    controller.abort();
    await waiting;
  });

  it("an aborted wait leaves no timer behind", async () => {
    const count = () => process.getActiveResourcesInfo().filter((n) => n === "Timeout").length;
    const before = count();
    const controller = new AbortController();
    const waiting = realWait(60_000, controller.signal);
    expect(count()).toBe(before + 1);
    controller.abort();
    await waiting;
    expect(count()).toBe(before);
  });

  it("stopWithDeadline cancels its deadline timer when the process exits in time", async () => {
    const count = () => process.getActiveResourcesInfo().filter((n) => n === "Timeout").length;
    const before = count();
    await stopWithDeadline(
      { pid: 1, stop: () => Promise.resolve(), kill: () => Promise.resolve() },
      realWait,
      60_000,
    );
    expect(count()).toBe(before);
  });
});

describe("a failed Keychain cleanup keeps the ledger (Codex 5)", () => {
  it("withSandbox keeps the run root and its ledger when the account deletion fails", async () => {
    const table: ProcessEntry[] = [];
    const outcome = await withSandbox(
      {
        base,
        home: join(base, "home"),
        env: {},
        platform: "darwin",
        ownerPid: 99990,
        readTable: () => Promise.resolve([...table]),
        deleteAccount: () => Promise.reject(new Error("keychain locked")),
        wait: () => Promise.resolve(),
        sweep: () => Promise.resolve({ status: "none" as const }),
        signals: { on: () => undefined, off: () => undefined },
      },
      () => Promise.resolve(),
    );
    expect(outcome.cleanupErrors).toHaveLength(1);
    expect(outcome.runRootRemoved).toBe(false);
    expect(existsSync(join(outcome.runRoot, "ledger.jsonl"))).toBe(true);
  });

  it("the stale sweep keeps the run root when an account deletion fails", async () => {
    const plan: SweepPlan = {
      busy: null,
      runs: [
        {
          runRoot: "/tmp/ccc-uat.abc123",
          actions: [
            { type: "delete-account", account: "ccc-uat-0123abcd" },
            { type: "remove-dir", path: "/tmp/ccc-uat.abc123/vaults" },
            { type: "remove-root", path: "/tmp/ccc-uat.abc123" },
          ],
          manual: [],
        },
      ],
    };
    const deps = {
      sendTerm: vi.fn(),
      deleteAccount: vi.fn(() => Promise.reject(new Error("keychain locked"))),
      removeDir: vi.fn(),
      removeRunRoot: vi.fn(),
      readTable: () => Promise.resolve([]),
      wait: () => Promise.resolve(),
    };
    const outcome = await executeSweep(plan, deps);
    expect(deps.removeRunRoot).not.toHaveBeenCalled();
    expect(deps.removeDir).not.toHaveBeenCalled();
    expect(outcome.status === "swept" && outcome.errors.length).toBe(1);
  });
});
