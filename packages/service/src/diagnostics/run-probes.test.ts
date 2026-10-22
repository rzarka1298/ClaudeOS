import type { ProbeOutcome } from "@ccc/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshInstallResponse } from "../test-support/diagnostics-fixtures.js";
import {
  asCachedResponse,
  createHealthCache,
  HEALTH_CACHE_TTL_MS,
  type NamedProbe,
  OVERALL_CAP_MS,
  PER_PROBE_CAP_MS,
  type ProbeLogEntry,
  runProbes,
  type SubsystemRowId,
} from "./run-probes.js";

/**
 * Plan 08-07 Task 2 (D-05, T-08-16, T-08-17): capped probes that never report a timeout or a
 * throw as working, with fake timers and no real waiting.
 */

const HOOKS_OK: ProbeOutcome = { id: "hooks", status: "ok", reasonCode: "hooks-receiving" };
const NEVER = (): Promise<ProbeOutcome> => new Promise(() => undefined);
const IDS: readonly SubsystemRowId[] = ["vault", "hooks", "collectors", "scheduler", "launchers"];
const SECRET = "/Users/USERNAME/private/notes.md";

let log: ProbeLogEntry[];
const now = (): Date => new Date(Date.now());

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-22T09:00:00.000Z"));
  log = [];
});
afterEach(() => {
  vi.useRealTimers();
});

const options = (extra: Partial<Parameters<typeof runProbes>[2]> = {}) => ({
  now,
  log: (entry: ProbeLogEntry) => log.push(entry),
  ...extra,
});

describe("Test 1: a probe that never resolves is cut at its own cap", () => {
  it("reads unknown/probe-timeout with freshness unavailable after 2 s, while a fast probe keeps its real result", async () => {
    const probes: NamedProbe[] = [
      { id: "hooks", run: () => Promise.resolve(HOOKS_OK) },
      { id: "launchers", run: NEVER },
    ];
    const done = runProbes(probes, "reconnect", options());
    await vi.advanceTimersByTimeAsync(PER_PROBE_CAP_MS);
    const [hooks, launchers] = await done;
    expect(hooks).toMatchObject({
      id: "hooks",
      status: "ok",
      reasonCode: "hooks-receiving",
      freshness: "live",
    });
    expect(launchers).toMatchObject({
      id: "launchers",
      status: "unknown",
      reasonCode: "probe-timeout",
      freshness: "unavailable",
    });
    expect(log).toEqual([{ subsystem: "launchers", code: "probe-timeout" }]);
  });

  it("does not cut a probe early: at 1999 ms it is still running", async () => {
    let settled = false;
    const done = runProbes([{ id: "launchers", run: NEVER }], "reconnect", options()).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(PER_PROBE_CAP_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(settled).toBe(true);
  });

  it("keeps the documented caps", () => {
    expect(PER_PROBE_CAP_MS).toBe(2000);
    expect(OVERALL_CAP_MS).toBe(5000);
    expect(HEALTH_CACHE_TTL_MS).toBe(2000);
  });
});

describe("Test 2: the overall cap", () => {
  it("cuts five slow probes at 5 s even when their own caps are longer, and resolves within a tick", async () => {
    const probes = IDS.map((id): NamedProbe => ({ id, run: NEVER }));
    let settled = false;
    const done = runProbes(probes, "reconnect", options({ perProbeMs: 60_000 })).then((rows) => {
      settled = true;
      return rows;
    });
    await vi.advanceTimersByTimeAsync(OVERALL_CAP_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const rows = await done;
    expect(settled).toBe(true);
    expect(rows.map((row) => row.id)).toEqual([...IDS]);
    for (const row of rows) {
      expect(row).toMatchObject({
        status: "unknown",
        reasonCode: "probe-timeout",
        freshness: "unavailable",
      });
    }
  });
});

describe("Test 3: a probe that throws", () => {
  it("reads unknown/probe-error and logs the error class name only", async () => {
    const throwing: NamedProbe = {
      id: "hooks",
      run: () => Promise.reject(new TypeError(`ENOENT: open '${SECRET}'`)),
    };
    const syncThrowing: NamedProbe = {
      id: "scheduler",
      run: () => {
        throw new RangeError(SECRET);
      },
    };
    const rows = await runProbes([throwing, syncThrowing], "gesture", options());
    for (const row of rows) {
      expect(row).toMatchObject({
        status: "unknown",
        reasonCode: "probe-error",
        freshness: "unavailable",
      });
    }
    // The order follows when each probe settled, not the order they were listed in.
    expect(log).toHaveLength(2);
    expect(log).toEqual(
      expect.arrayContaining([
        { subsystem: "hooks", code: "probe-error", errorName: "TypeError" },
        { subsystem: "scheduler", code: "probe-error", errorName: "RangeError" },
      ]),
    );
    expect(JSON.stringify([rows, log])).not.toContain(SECRET);
  });

  it("reads probe-error for an outcome the strict row schema refuses: an extra key, a wrong id, a status that disagrees", async () => {
    const bad: NamedProbe[] = [
      {
        id: "hooks",
        run: () => Promise.resolve({ ...HOOKS_OK, path: SECRET } as unknown as ProbeOutcome),
      },
      {
        id: "vault",
        run: () => Promise.resolve(HOOKS_OK),
      },
      {
        id: "launchers",
        run: () =>
          Promise.resolve({
            id: "launchers",
            status: "ok",
            reasonCode: "bundle-not-found",
          } as unknown as ProbeOutcome),
      },
    ];
    const rows = await runProbes(bad, "reconnect", options());
    for (const row of rows) {
      expect(row).toMatchObject({
        status: "unknown",
        reasonCode: "probe-error",
        freshness: "unavailable",
      });
    }
    expect(log.map((entry) => entry.errorName)).toEqual([
      "ProbeOutcomeInvalid",
      "ProbeOutcomeInvalid",
      "ProbeOutcomeInvalid",
    ]);
    expect(JSON.stringify([rows, log])).not.toContain(SECRET);
  });

  it("marks a probe's own did-not-finish answer as unavailable, not live", async () => {
    const own: NamedProbe = {
      id: "hooks",
      run: () => Promise.resolve({ id: "hooks", status: "unknown", reasonCode: "probe-timeout" }),
    };
    const [row] = await runProbes([own], "reconnect", options());
    expect(row).toMatchObject({ reasonCode: "probe-timeout", freshness: "unavailable" });
  });
});

describe("Test 4: the signal each probe receives", () => {
  it("aborts at the probe's own cap and not before", async () => {
    let signal: AbortSignal | undefined;
    const done = runProbes(
      [
        {
          id: "launchers",
          run: (given) => {
            signal = given;
            return NEVER();
          },
        },
      ],
      "reconnect",
      options(),
    );
    await vi.advanceTimersByTimeAsync(PER_PROBE_CAP_MS - 1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    await done;
  });

  it("aborts at the overall cap when the probe's own cap is longer, and tells a fake child to stop", async () => {
    const killed: string[] = [];
    const done = runProbes(
      [
        {
          id: "scheduler",
          run: (signal) => {
            signal.addEventListener("abort", () => killed.push("SIGKILL"), { once: true });
            return NEVER();
          },
        },
      ],
      "reconnect",
      options({ perProbeMs: 60_000 }),
    );
    await vi.advanceTimersByTimeAsync(OVERALL_CAP_MS);
    await done;
    expect(killed).toEqual(["SIGKILL"]);
  });

  it("passes the trigger to every probe", async () => {
    const seen: string[] = [];
    await runProbes(
      IDS.map(
        (id): NamedProbe => ({
          id,
          run: (_signal, trigger) => {
            seen.push(trigger);
            return Promise.resolve({
              id,
              status: "unknown",
              reasonCode: "subsystem-not-wired",
            } as ProbeOutcome);
          },
        }),
      ),
      "gesture",
      options(),
    );
    expect(seen).toEqual(["gesture", "gesture", "gesture", "gesture", "gesture"]);
  });
});

describe("Test 5: no timer is left pending", () => {
  it("leaves zero timers after a fast run, a timed-out run and a throwing run", async () => {
    await runProbes(
      [{ id: "hooks", run: () => Promise.resolve(HOOKS_OK) }],
      "reconnect",
      options(),
    );
    expect(vi.getTimerCount()).toBe(0);

    const cut = runProbes([{ id: "launchers", run: NEVER }], "reconnect", options());
    await vi.advanceTimersByTimeAsync(PER_PROBE_CAP_MS);
    await cut;
    expect(vi.getTimerCount()).toBe(0);

    await runProbes(
      [{ id: "hooks", run: () => Promise.reject(new Error("x")) }],
      "reconnect",
      options(),
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Test 7: a late result is discarded", () => {
  it("never replaces the timeout row when the probe answers after its cap", async () => {
    const late: NamedProbe = {
      id: "hooks",
      run: () =>
        new Promise<ProbeOutcome>((resolve) => {
          setTimeout(() => resolve(HOOKS_OK), PER_PROBE_CAP_MS + 1000);
        }),
    };
    const done = runProbes([late], "reconnect", options());
    await vi.advanceTimersByTimeAsync(PER_PROBE_CAP_MS);
    const [row] = await done;
    expect(row).toMatchObject({ status: "unknown", reasonCode: "probe-timeout" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(row).toMatchObject({ status: "unknown", reasonCode: "probe-timeout" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("treats an answer that arrives with the cap already fired as late, whatever it says", async () => {
    // The probe ignores the signal and resolves in the same instant the cap fires.
    const racing: NamedProbe = {
      id: "hooks",
      run: (signal) =>
        new Promise<ProbeOutcome>((resolve) => {
          signal.addEventListener("abort", () => resolve(HOOKS_OK), { once: true });
        }),
    };
    const done = runProbes([racing], "reconnect", options());
    await vi.advanceTimersByTimeAsync(PER_PROBE_CAP_MS);
    const [row] = await done;
    expect(row).toMatchObject({
      status: "unknown",
      reasonCode: "probe-timeout",
      freshness: "unavailable",
    });
  });
});

describe("the health cache (single-flight and a 2 s TTL)", () => {
  const nowMs = (): number => Date.now();

  it("runs once for concurrent callers of the same trigger and reads a young result as cached", async () => {
    const cache = createHealthCache({ nowMs });
    let runs = 0;
    const compute = (): Promise<ReturnType<typeof freshInstallResponse>> => {
      runs += 1;
      return Promise.resolve(freshInstallResponse());
    };
    const [a, b] = await Promise.all([
      cache.get("gesture", compute),
      cache.get("gesture", compute),
    ]);
    expect(runs).toBe(1);
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(false);
    expect(b.response).toBe(a.response);

    vi.advanceTimersByTime(HEALTH_CACHE_TTL_MS - 1);
    const c = await cache.get("gesture", compute);
    expect(runs).toBe(1);
    expect(c.cached).toBe(true);
    expect(c.response).toBe(a.response);

    vi.advanceTimersByTime(1);
    const d = await cache.get("gesture", compute);
    expect(runs).toBe(2);
    expect(d.cached).toBe(false);
  });

  it("keys on the trigger: a reconnect never joins, reads or upgrades a gesture", async () => {
    const cache = createHealthCache({ nowMs });
    const seen: string[] = [];
    const compute = (trigger: string) => () => {
      seen.push(trigger);
      return Promise.resolve(freshInstallResponse());
    };
    await Promise.all([
      cache.get("gesture", compute("gesture")),
      cache.get("reconnect", compute("reconnect")),
    ]);
    expect(seen.sort()).toEqual(["gesture", "reconnect"]);
    // Each has its own young result now.
    expect((await cache.get("reconnect", compute("again"))).cached).toBe(true);
    expect((await cache.get("gesture", compute("again"))).cached).toBe(true);
    expect(seen).not.toContain("again");
  });

  it("does not cache a failed run, and every joiner sees the failure", async () => {
    const cache = createHealthCache({ nowMs });
    let rejectRun: (error: Error) => void = () => undefined;
    const failing = (): Promise<ReturnType<typeof freshInstallResponse>> =>
      new Promise((_resolve, reject) => {
        rejectRun = reject;
      });
    const first = cache.get("reconnect", failing);
    const second = cache.get("reconnect", failing);
    rejectRun(new Error("boom"));
    await expect(first).rejects.toThrow("boom");
    await expect(second).rejects.toThrow("boom");
    const next = await cache.get("reconnect", () => Promise.resolve(freshInstallResponse()));
    expect(next.cached).toBe(false);
  });

  it("serves a cached response with live rows read as cached and unavailable rows left alone", () => {
    const base = freshInstallResponse();
    const rows = base.rows.map((row, index) =>
      index === 1 ? { ...row, freshness: "unavailable" as const } : row,
    ) as typeof base.rows;
    const served = asCachedResponse({ ...base, rows });
    expect(served.rows.map((row) => row.freshness)).toEqual([
      "cached",
      "unavailable",
      "cached",
      "cached",
      "cached",
    ]);
    expect(served.rows.map((row) => row.checkedAt)).toEqual(base.rows.map((row) => row.checkedAt));
    expect(served.generatedAt).toBe(base.generatedAt);
  });
});
