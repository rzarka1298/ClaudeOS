import { describe, expect, it, vi } from "vitest";
import type { LedgerEntry, ProcessEntry } from "./ledger.js";
import { executeSweep, planSweep, type SweepRunInput } from "./sweep.js";

const BASE = "/tmp";
const ROOT = "/tmp/ccc-uat.abc123";
const START = "Sun Oct 11 10:00:01 2026";
const OTHER_START = "Mon Oct 12 11:11:11 2026";
const SERVICE_MARKER = "/repo/packages/service/dist/main.js";
const OLD = 10 * 60 * 1000;

const runEntry: LedgerEntry = {
  kind: "run",
  runId: "0123abcd",
  runRoot: ROOT,
  startedAt: "2026-10-11T10:00:00.000Z",
  ownerPid: 100,
  ownerStart: "Sun Oct 11 09:59:59 2026",
};

function staleRun(extra: LedgerEntry[], overrides: Partial<SweepRunInput> = {}): SweepRunInput {
  return {
    runRoot: ROOT,
    ageMs: OLD,
    entries: [
      runEntry,
      { kind: "account", account: "ccc-uat-0123abcd" },
      { kind: "dir", path: `${ROOT}/vaults` },
      ...extra,
    ],
    ...overrides,
  };
}

const servicePid: LedgerEntry = {
  kind: "pid",
  role: "service",
  pid: 555,
  start: START,
  marker: SERVICE_MARKER,
};

const serviceRow: ProcessEntry = {
  pid: 555,
  start: START,
  command: `node ${SERVICE_MARKER}`,
};

const options = { base: BASE, selfPid: 1 };

describe("planSweep (Test 3)", () => {
  it("terminates a matched pid, then deletes the account, then removes dirs and the root", () => {
    const plan = planSweep([staleRun([servicePid])], [serviceRow], options);
    expect(plan.busy).toBeNull();
    expect(plan.runs).toHaveLength(1);
    expect(plan.runs[0]?.actions).toEqual([
      { type: "terminate", pid: 555, role: "service", start: START, marker: SERVICE_MARKER },
      { type: "delete-account", account: "ccc-uat-0123abcd" },
      { type: "remove-dir", path: `${ROOT}/vaults` },
      { type: "remove-root", path: ROOT },
    ]);
  });

  it("never terminates a recycled pid (different start time) or a marker mismatch", () => {
    const recycled = planSweep(
      [staleRun([servicePid])],
      [{ ...serviceRow, start: OTHER_START }],
      options,
    );
    expect(recycled.runs[0]?.actions.some((a) => a.type === "terminate")).toBe(false);
    const wrongCommand = planSweep(
      [staleRun([servicePid])],
      [{ ...serviceRow, command: "/usr/bin/some-other-program" }],
      options,
    );
    expect(wrongCommand.runs[0]?.actions.some((a) => a.type === "terminate")).toBe(false);
  });

  it("does not terminate when the ledgered start time or marker is empty", () => {
    const noStart: LedgerEntry = {
      kind: "pid",
      role: "service",
      pid: 555,
      start: "",
      marker: SERVICE_MARKER,
    };
    const noMarker: LedgerEntry = { kind: "pid", role: "service", pid: 555, start: START };
    for (const entry of [noStart, noMarker]) {
      const plan = planSweep([staleRun([entry])], [serviceRow], options);
      expect(plan.runs[0]?.actions.some((a) => a.type === "terminate")).toBe(false);
    }
  });

  it("reports busy and nothing else when the owner process is alive with the same start time", () => {
    const owner: ProcessEntry = {
      pid: 100,
      start: runEntry.kind === "run" ? runEntry.ownerStart : "",
      command: "node cli.js",
    };
    const plan = planSweep([staleRun([servicePid])], [owner, serviceRow], options);
    expect(plan.busy).toBe(ROOT);
    expect(plan.runs).toEqual([]);
  });

  it("treats a dead owner, or a recycled owner pid, as stale", () => {
    const recycledOwner: ProcessEntry = { pid: 100, start: OTHER_START, command: "something else" };
    expect(planSweep([staleRun([])], [recycledOwner], options).busy).toBeNull();
    expect(planSweep([staleRun([])], [], options).busy).toBeNull();
  });

  it("a closed run with nothing alive yields only removal", () => {
    const closed = staleRun([{ kind: "closed", at: "2026-10-11T10:06:00.000Z" }]);
    const plan = planSweep([closed], [], options);
    expect(plan.runs[0]?.actions).toEqual([
      { type: "remove-dir", path: `${ROOT}/vaults` },
      { type: "remove-root", path: ROOT },
    ]);
  });

  it("never plans a directory outside the run root or a root outside /tmp/ccc-uat.*", () => {
    const sneaky = staleRun([
      { kind: "dir", path: "/Users/USERNAME/important" },
      { kind: "dir", path: `${ROOT}/../elsewhere` },
      { kind: "dir", path: ROOT },
    ]);
    const plan = planSweep([sneaky], [], options);
    const paths = plan.runs[0]?.actions.flatMap((a) => ("path" in a ? [a.path] : [])) ?? [];
    expect(paths.sort()).toEqual([`${ROOT}/vaults`, ROOT].sort());
    const notARoot = planSweep([{ runRoot: "/tmp/other", ageMs: OLD, entries: [] }], [], options);
    expect(notARoot.runs[0]?.actions ?? []).toEqual([]);
  });

  it("treats a young run root with no run entry as busy (it may be starting right now)", () => {
    const young: SweepRunInput = { runRoot: ROOT, ageMs: 1000, entries: [] };
    expect(planSweep([young], [], options).busy).toBe(ROOT);
    const old: SweepRunInput = { runRoot: ROOT, ageMs: OLD, entries: null };
    expect(planSweep([old], [], options).runs[0]?.actions).toEqual([
      { type: "remove-root", path: ROOT },
    ]);
  });

  it("lists unledgered processes naming the run root for manual cleanup, never signalling them", () => {
    const stray: ProcessEntry = {
      pid: 900,
      start: START,
      command: `Obsidian --user-data-dir=${ROOT}/wdio`,
    };
    const plan = planSweep([staleRun([])], [stray], options);
    expect(plan.runs[0]?.manual).toEqual([stray]);
    expect(plan.runs[0]?.actions.some((a) => a.type === "terminate")).toBe(false);
  });
});

describe("executeSweep (Test 4)", () => {
  function deps(table: () => ProcessEntry[]) {
    return {
      sendTerm: vi.fn().mockResolvedValue(undefined),
      deleteAccount: vi.fn().mockResolvedValue("deleted"),
      removeDir: vi.fn(),
      removeRunRoot: vi.fn(),
      readTable: () => Promise.resolve(table()),
      wait: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("runs each action once with the injected collaborators and reports the summary", async () => {
    let alive = [serviceRow];
    const d = deps(() => alive);
    d.sendTerm.mockImplementation(() => {
      alive = [];
      return Promise.resolve();
    });
    const plan = planSweep([staleRun([servicePid])], alive, options);
    const outcome = await executeSweep(plan, d);
    expect(d.sendTerm).toHaveBeenCalledTimes(1);
    expect(d.sendTerm).toHaveBeenCalledWith(555);
    expect(d.deleteAccount).toHaveBeenCalledWith("ccc-uat-0123abcd");
    expect(d.removeDir).toHaveBeenCalledWith(`${ROOT}/vaults`);
    expect(d.removeRunRoot).toHaveBeenCalledWith(ROOT);
    expect(outcome).toEqual({
      status: "swept",
      terminated: [555],
      accountsDeleted: ["ccc-uat-0123abcd"],
      removed: [`${ROOT}/vaults`, ROOT],
      stillAlive: [],
      errors: [],
    });
  });

  it("never signals a recycled pid", async () => {
    const d = deps(() => [{ ...serviceRow, start: OTHER_START }]);
    const plan = planSweep(
      [staleRun([servicePid])],
      [{ ...serviceRow, start: OTHER_START }],
      options,
    );
    await executeSweep(plan, d);
    expect(d.sendTerm).not.toHaveBeenCalled();
  });

  it("reports a survivor for the owner, sends no second signal and keeps the run root", async () => {
    const d = deps(() => [serviceRow]);
    const plan = planSweep([staleRun([servicePid])], [serviceRow], options);
    const outcome = await executeSweep(plan, d);
    expect(d.sendTerm).toHaveBeenCalledTimes(1);
    expect(d.removeRunRoot).not.toHaveBeenCalled();
    expect(outcome.status).toBe("swept");
    if (outcome.status === "swept") {
      expect(outcome.stillAlive).toEqual(["pid 555: still alive: stop manually"]);
      expect(outcome.accountsDeleted).toEqual(["ccc-uat-0123abcd"]);
    }
  });

  it("returns busy without calling anything", async () => {
    const d = deps(() => []);
    const outcome = await executeSweep({ busy: ROOT, runs: [] }, d);
    expect(outcome).toEqual({ status: "busy", runRoot: ROOT });
    expect(d.deleteAccount).not.toHaveBeenCalled();
  });

  it("returns none when there is nothing to do", async () => {
    const outcome = await executeSweep(
      { busy: null, runs: [] },
      deps(() => []),
    );
    expect(outcome).toEqual({ status: "none" });
  });

  it("records an account deletion failure and keeps the run root for the retry", async () => {
    const d = deps(() => []);
    d.deleteAccount.mockRejectedValue(new Error("keychain locked"));
    const plan = planSweep([staleRun([])], [], options);
    const outcome = await executeSweep(plan, d);
    expect(d.removeRunRoot).not.toHaveBeenCalled();
    expect(outcome.status === "swept" && outcome.errors.length).toBe(1);
  });
});
