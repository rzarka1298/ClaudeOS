import { execFile as execFileDouble } from "node:child_process";
import {
  HEALTH_STALE_AFTER_MS,
  type HealthTrigger,
  type ResearchStatusResponse,
  RUN_ERROR_CODES,
  SCHEDULER_PART_IDS,
  SCHEDULER_PASSIVE_PART_IDS,
} from "@ccc/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidRow, partsOf } from "../test-support/diagnostics-probe-fixtures.js";
import {
  installFetchDouble,
  NETWORK_DOUBLE_MODULES,
  networkCalls,
} from "../test-support/no-network.js";
import {
  createKeyPresenceCheck,
  type KeyPresence,
  probeScheduler,
  type SchedulerProbePorts,
} from "./scheduler-probe.js";

vi.mock("node:http", async () =>
  (await import("../test-support/no-network.js")).networkDouble("node:http"),
);
vi.mock("node:https", async () =>
  (await import("../test-support/no-network.js")).networkDouble("node:https"),
);
vi.mock("node:http2", async () =>
  (await import("../test-support/no-network.js")).networkDouble("node:http2"),
);
vi.mock("node:net", async () =>
  (await import("../test-support/no-network.js")).networkDouble("node:net"),
);
vi.mock("node:tls", async () =>
  (await import("../test-support/no-network.js")).networkDouble("node:tls"),
);
vi.mock("node:dgram", async () =>
  (await import("../test-support/no-network.js")).networkDouble("node:dgram"),
);
vi.mock("node:dns", async () =>
  (await import("../test-support/no-network.js")).networkDouble("node:dns"),
);
vi.mock("node:dns/promises", async () =>
  (await import("../test-support/no-network.js")).networkDouble("node:dns/promises"),
);
vi.mock("node:child_process", async () =>
  (await import("../test-support/no-network.js")).networkDouble("node:child_process"),
);

/**
 * Plan 08-08 Task 2 (D-04, D-05, ADR-0013; T-08-19, T-08-20, T-08-22b; Amendment A1): the
 * scheduler row projects the research status the services already hold. The last run is derived in
 * the order in-flight, interrupted, newer failure, success, never; the research key is a presence
 * check that runs only on an owner gesture; a configured source list that cannot be used is
 * degraded. The row never reports a next run.
 */

const SIGNAL = new AbortController().signal;
const RUN_ID = "0mfk1a2b3c4d5e6f7a8b9c001";
const T_OLD = "2026-10-20T09:00:00.000Z";
const T_NEW = "2026-10-21T09:00:00.000Z";
const SOURCES = [{ label: "Example one", host: "one.example.invalid" }];

function status(overrides: Partial<ResearchStatusResponse> = {}): ResearchStatusResponse {
  return {
    lastSuccess: null,
    lastFailure: null,
    inFlight: null,
    latestUnknown: null,
    configuredSources: SOURCES,
    topicLabel: null,
    ...overrides,
  };
}

const success = (endedAt: string): NonNullable<ResearchStatusResponse["lastSuccess"]> => ({
  runId: RUN_ID as never,
  endedAt,
  outcome: "success",
  sourceCount: 1,
  sourceTotal: 1,
  reportNoteId: "0mfk1a2b3c4d5e6f7a8b9c002" as never,
});

const failure = (
  endedAt: string,
  errorCode: (typeof RUN_ERROR_CODES)[number],
): NonNullable<ResearchStatusResponse["lastFailure"]> => ({
  runId: RUN_ID as never,
  endedAt,
  errorCode,
});

function ports(
  current: ResearchStatusResponse | null,
  presence: KeyPresence = "absent",
  extra: Partial<SchedulerProbePorts> = {},
): SchedulerProbePorts & { keyCalls: HealthTrigger[] } {
  const keyCalls: HealthTrigger[] = [];
  return {
    keyCalls,
    status: () => current,
    keyPresence: (trigger) => {
      keyCalls.push(trigger);
      return Promise.resolve(presence);
    },
    overrideTransportActive: false,
    ...extra,
  };
}

function part(outcome: Awaited<ReturnType<typeof probeScheduler>>, partId: string) {
  const found = partsOf(outcome).find((candidate) => candidate.partId === partId);
  if (found === undefined) throw new Error(`no part ${partId}`);
  return found;
}

/** Literal-specifier loaders for the doubles (T-06-15 bans computed `import()`), checked against the double list. */
const LOAD_DOUBLE: Readonly<Record<string, () => Promise<unknown>>> = {
  "node:http": () => import("node:http"),
  "node:https": () => import("node:https"),
  "node:http2": () => import("node:http2"),
  "node:net": () => import("node:net"),
  "node:tls": () => import("node:tls"),
  "node:dgram": () => import("node:dgram"),
  "node:dns": () => import("node:dns"),
  "node:dns/promises": () => import("node:dns/promises"),
  // D-18: child_process is imported statically by name; the mocked binding is the double.
  "node:child_process": async () => ({ execFile: execFileDouble }),
};

describe("Test 1: the last-run order", () => {
  it("in flight reads run-in-flight (ok), ahead of everything else", async () => {
    const outcome = await probeScheduler(
      ports(
        status({
          inFlight: { runId: RUN_ID as never, startedAt: T_NEW, stage: null },
          latestUnknown: { runId: RUN_ID as never, startedAt: T_OLD },
          lastFailure: failure(T_NEW, "summariser-failed"),
        }),
      ),
      SIGNAL,
    );
    expect(part(outcome, "last-run")).toEqual({
      partId: "last-run",
      status: "ok",
      reasonCode: "run-in-flight",
    });
  });

  it("an interrupted run (latestUnknown) reads run-interrupted (unknown) ahead of a failure and a success", async () => {
    const outcome = await probeScheduler(
      ports(
        status({
          latestUnknown: { runId: RUN_ID as never, startedAt: T_NEW },
          lastFailure: failure(T_NEW, "summariser-failed"),
          lastSuccess: success(T_OLD),
        }),
      ),
      SIGNAL,
    );
    expect(part(outcome, "last-run")).toMatchObject({
      status: "unknown",
      reasonCode: "run-interrupted",
      setupAction: { kind: "go-to-section", section: "research" },
    });
  });

  it("a failure newer than the newest success reads run-<errorCode>, for every RUN_ERROR_CODES member", async () => {
    for (const code of RUN_ERROR_CODES) {
      const outcome = await probeScheduler(
        ports(status({ lastFailure: failure(T_NEW, code), lastSuccess: success(T_OLD) })),
        SIGNAL,
      );
      expect(part(outcome, "last-run"), code).toMatchObject({ reasonCode: `run-${code}` });
      expect(isValidRow(outcome), code).toBe(true);
    }
  });

  it("a failure alone, with no success, still reads run-<errorCode>", async () => {
    const outcome = await probeScheduler(
      ports(status({ lastFailure: failure(T_OLD, "all-sources-failed") })),
      SIGNAL,
    );
    expect(part(outcome, "last-run")).toEqual({
      partId: "last-run",
      status: "degraded",
      reasonCode: "run-all-sources-failed",
      setupAction: { kind: "go-to-section", section: "research" },
      facts: { lastFailureAt: T_OLD },
    });
  });

  it("an unconfigured summariser points at the key setup command", async () => {
    const outcome = await probeScheduler(
      ports(status({ lastFailure: failure(T_NEW, "summariser-unconfigured") })),
      SIGNAL,
    );
    expect(part(outcome, "last-run")).toMatchObject({
      status: "setup-needed",
      reasonCode: "run-summariser-unconfigured",
      setupAction: { kind: "copy-command", command: "research-key-setup" },
    });
  });

  it("a success newer than the failure, or a success alone, reads last-run-succeeded with lastSuccessAt", async () => {
    const newer = await probeScheduler(
      ports(
        status({ lastFailure: failure(T_OLD, "summariser-failed"), lastSuccess: success(T_NEW) }),
      ),
      SIGNAL,
    );
    expect(part(newer, "last-run")).toEqual({
      partId: "last-run",
      status: "ok",
      reasonCode: "last-run-succeeded",
      facts: { lastSuccessAt: T_NEW },
    });
    const alone = await probeScheduler(ports(status({ lastSuccess: success(T_OLD) })), SIGNAL);
    expect(part(alone, "last-run")).toMatchObject({ reasonCode: "last-run-succeeded" });
  });

  it("nothing at all reads never-run (setup-needed) with the research section action", async () => {
    const outcome = await probeScheduler(ports(status()), SIGNAL);
    expect(part(outcome, "last-run")).toEqual({
      partId: "last-run",
      status: "setup-needed",
      reasonCode: "never-run",
      setupAction: { kind: "go-to-section", section: "research" },
    });
  });

  it("never reports a next run or a schedule: no member of the outcome names one", async () => {
    const outcome = await probeScheduler(ports(status({ lastSuccess: success(T_OLD) })), SIGNAL);
    expect(JSON.stringify(outcome)).not.toMatch(/next|cron|interval|schedule(?!r)/i);
  });
});

describe("Test 2: the research key part (Amendment A1)", () => {
  it("present, absent and error map to their reasons, absent with the copy action", async () => {
    const cases: [KeyPresence, string, string][] = [
      ["present", "ok", "research-key-present"],
      ["absent", "setup-needed", "research-key-missing"],
      ["error", "unknown", "research-key-check-failed"],
      ["not-checked", "unknown", "research-key-not-checked"],
    ];
    for (const [presence, expectedStatus, reason] of cases) {
      const outcome = await probeScheduler(ports(status(), presence), SIGNAL, "gesture");
      expect(part(outcome, "research-key"), presence).toMatchObject({
        status: expectedStatus,
        reasonCode: reason,
      });
      expect(isValidRow(outcome), presence).toBe(true);
    }
    const missing = await probeScheduler(ports(status(), "absent"), SIGNAL, "gesture");
    expect(part(missing, "research-key")).toMatchObject({
      setupAction: { kind: "copy-command", command: "research-key-setup" },
    });
  });

  it("passes the trigger to the presence port", async () => {
    const gesture = ports(status());
    await probeScheduler(gesture, SIGNAL, "gesture");
    expect(gesture.keyCalls).toEqual(["gesture"]);
    const reconnect = ports(status());
    await probeScheduler(reconnect, SIGNAL, "reconnect");
    expect(reconnect.keyCalls).toEqual(["reconnect"]);
    // The default trigger is the safe one.
    const defaulted = ports(status());
    await probeScheduler(defaulted, SIGNAL);
    expect(defaulted.keyCalls).toEqual(["reconnect"]);
  });

  it("with the guarded test transport active the port is not called and the part is present", async () => {
    const withOverride = ports(status(), "absent", { overrideTransportActive: true });
    const outcome = await probeScheduler(withOverride, SIGNAL, "gesture");
    expect(withOverride.keyCalls).toEqual([]);
    expect(part(outcome, "research-key")).toMatchObject({
      status: "ok",
      reasonCode: "research-key-present",
    });
  });
});

describe("Test 2b: the presence check keeps its gesture result in memory (Amendment A1)", () => {
  it("a reconnect call never invokes hasResearchKey", async () => {
    const hasResearchKey = vi.fn(() => Promise.resolve("present" as const));
    const check = createKeyPresenceCheck({ hasResearchKey });
    for (let i = 0; i < 5; i += 1) await check("reconnect", SIGNAL);
    expect(hasResearchKey).not.toHaveBeenCalled();
  });

  it("the first reconnect before any gesture reads not-checked, and through the probe research-key-not-checked", async () => {
    const check = createKeyPresenceCheck({ hasResearchKey: () => Promise.resolve("present") });
    expect(await check("reconnect", SIGNAL)).toBe("not-checked");
    const outcome = await probeScheduler(
      { status: () => status(), keyPresence: check, overrideTransportActive: false },
      SIGNAL,
      "reconnect",
    );
    expect(part(outcome, "research-key")).toMatchObject({
      status: "unknown",
      reasonCode: "research-key-not-checked",
    });
  });

  it("FIX2A m3: a fresh install on a reconnect, before any gesture, reads the row unknown (not setup-needed), with the key part research-key-not-checked and the key store never touched", async () => {
    const hasResearchKey = vi.fn(() => Promise.resolve("present" as const));
    const check = createKeyPresenceCheck({ hasResearchKey });
    const outcome = await probeScheduler(
      { status: () => status(), keyPresence: check, overrideTransportActive: false },
      SIGNAL,
      "reconnect",
    );
    expect(outcome).toMatchObject({
      id: "scheduler",
      status: "unknown",
      reasonCode: "research-key-not-checked",
    });
    expect(part(outcome, "last-run")).toMatchObject({
      status: "setup-needed",
      reasonCode: "never-run",
    });
    expect(part(outcome, "research-key")).toMatchObject({
      status: "unknown",
      reasonCode: "research-key-not-checked",
    });
    expect(hasResearchKey).not.toHaveBeenCalled();
    expect(isValidRow(outcome)).toBe(true);

    // The owner's gesture is what finds out; the row then reads the truth, and a later reconnect keeps it.
    const gesture = await probeScheduler(
      { status: () => status(), keyPresence: check, overrideTransportActive: false },
      SIGNAL,
      "gesture",
    );
    expect(part(gesture, "research-key")).toMatchObject({ reasonCode: "research-key-present" });
    expect(hasResearchKey).toHaveBeenCalledTimes(1);
  });

  it("a gesture calls it once and stores the result, later reconnects reuse it without a call", async () => {
    const hasResearchKey = vi.fn(() => Promise.resolve("absent" as const));
    const check = createKeyPresenceCheck({ hasResearchKey });
    expect(await check("gesture", SIGNAL)).toBe("absent");
    expect(hasResearchKey).toHaveBeenCalledTimes(1);
    expect(await check("reconnect", SIGNAL)).toBe("absent");
    expect(await check("reconnect", SIGNAL)).toBe("absent");
    expect(hasResearchKey).toHaveBeenCalledTimes(1);
    // The next gesture checks again and replaces the stored result.
    hasResearchKey.mockResolvedValueOnce("present" as never);
    expect(await check("gesture", SIGNAL)).toBe("present");
    expect(await check("reconnect", SIGNAL)).toBe("present");
  });

  it("a failing check is an error result (and is remembered), never a throw", async () => {
    const check = createKeyPresenceCheck({
      hasResearchKey: () => Promise.reject(new Error("security: /Users/USERNAME")),
    });
    expect(await check("gesture", SIGNAL)).toBe("error");
    expect(await check("reconnect", SIGNAL)).toBe("error");
  });

  it("a check that the signal cut short is not remembered", async () => {
    const controller = new AbortController();
    const check = createKeyPresenceCheck({
      hasResearchKey: () => {
        controller.abort();
        return Promise.resolve("present");
      },
    });
    await check("gesture", controller.signal);
    expect(await check("reconnect", SIGNAL)).toBe("not-checked");
  });

  it("FIX6A M1: a remembered answer older than the staleness window reads not-checked, never a fresh-looking one", async () => {
    let clock = 1_000;
    const hasResearchKey = vi.fn(() => Promise.resolve("present" as const));
    const check = createKeyPresenceCheck({ hasResearchKey, clock: () => clock });
    expect(await check("gesture", SIGNAL)).toBe("present");
    clock += 4 * 60 * 60 * 1000;
    expect(await check("reconnect", SIGNAL)).toBe("not-checked");
    const outcome = await probeScheduler(
      { status: () => status(), keyPresence: check, overrideTransportActive: false },
      SIGNAL,
      "reconnect",
    );
    expect(part(outcome, "research-key")).toMatchObject({
      status: "unknown",
      reasonCode: "research-key-not-checked",
    });
    expect(hasResearchKey).toHaveBeenCalledTimes(1);
  });

  it("FIX6A M1: a reconnect inside the window reuses the answer and still never spawns; the window is the shared constant", async () => {
    let clock = 5_000;
    const hasResearchKey = vi.fn(() => Promise.resolve("absent" as const));
    const check = createKeyPresenceCheck({ hasResearchKey, clock: () => clock });
    await check("gesture", SIGNAL);
    clock += HEALTH_STALE_AFTER_MS - 1;
    expect(await check("reconnect", SIGNAL)).toBe("absent");
    clock += 1;
    expect(await check("reconnect", SIGNAL)).toBe("absent");
    clock += 1;
    expect(await check("reconnect", SIGNAL)).toBe("not-checked");
    expect(hasResearchKey).toHaveBeenCalledTimes(1);
  });

  it("FIX6A M1: a new gesture renews the remembered answer's age", async () => {
    let clock = 0;
    const check = createKeyPresenceCheck({
      hasResearchKey: () => Promise.resolve("present"),
      clock: () => clock,
    });
    await check("gesture", SIGNAL);
    clock += HEALTH_STALE_AFTER_MS - 10;
    await check("gesture", SIGNAL);
    clock += HEALTH_STALE_AFTER_MS - 10;
    expect(await check("reconnect", SIGNAL)).toBe("present");
  });

  it("hands the probe's own signal to the process-backed check", async () => {
    const seen: AbortSignal[] = [];
    const check = createKeyPresenceCheck({
      hasResearchKey: (signal) => {
        seen.push(signal);
        return Promise.resolve("present");
      },
    });
    const controller = new AbortController();
    await check("gesture", controller.signal);
    expect(seen).toEqual([controller.signal]);
  });
});

describe("Test 3: the sources part", () => {
  it("an unusable source list is degraded", async () => {
    const outcome = await probeScheduler(ports(status({ configuredSources: null })), SIGNAL);
    expect(part(outcome, "sources")).toEqual({
      partId: "sources",
      status: "degraded",
      reasonCode: "sources-config-unusable",
    });
    expect(outcome).toMatchObject({ status: "degraded", reasonCode: "sources-config-unusable" });
    expect(isValidRow(outcome)).toBe(true);
  });

  it("a configured list carries only the count", async () => {
    const outcome = await probeScheduler(
      ports(
        status({ configuredSources: [...SOURCES, { label: "Two", host: "two.example.invalid" }] }),
      ),
      SIGNAL,
    );
    expect(part(outcome, "sources")).toEqual({
      partId: "sources",
      status: "ok",
      reasonCode: "sources-configured",
      facts: { sourceCount: 2 },
    });
    expect(JSON.stringify(outcome)).not.toContain("example.invalid");
  });
});

describe("the row", () => {
  it("a fresh install reads setup-needed with the three parts in order, the sources part passive", async () => {
    const outcome = await probeScheduler(ports(status(), "absent"), SIGNAL, "gesture");
    // The key route (10-03): the subscription route's `claude-cli` part arrives with the probe in 10-09.
    expect(partsOf(outcome).map((p) => p.partId)).toEqual(
      SCHEDULER_PART_IDS.filter((id) => id !== "claude-cli"),
    );
    expect(outcome).toMatchObject({
      id: "scheduler",
      status: "setup-needed",
      reasonCode: "never-run",
      setupAction: { kind: "go-to-section", section: "research" },
    });
    expect(SCHEDULER_PASSIVE_PART_IDS).toEqual(["sources"]);
    expect(isValidRow(outcome)).toBe(true);
  });

  it("a healthy scheduler reads ok", async () => {
    const outcome = await probeScheduler(
      ports(status({ lastSuccess: success(T_NEW) }), "present"),
      SIGNAL,
      "gesture",
    );
    expect(outcome).toMatchObject({ status: "ok" });
    expect(isValidRow(outcome)).toBe(true);
  });

  it("a status that is not available yet reads subsystem-not-wired on the parts it feeds, and the key part still answers", async () => {
    const outcome = await probeScheduler(ports(null, "present"), SIGNAL, "gesture");
    expect(part(outcome, "last-run")).toMatchObject({ reasonCode: "subsystem-not-wired" });
    expect(part(outcome, "sources")).toMatchObject({ reasonCode: "subsystem-not-wired" });
    expect(part(outcome, "research-key")).toMatchObject({ reasonCode: "research-key-present" });
    expect(isValidRow(outcome)).toBe(true);
  });

  it("a status read that throws reads probe-error on those parts, with no message", async () => {
    const outcome = await probeScheduler(
      ports(null, "present", {
        status: () => {
          throw new Error("EACCES: /Users/USERNAME/.ccc/operational.db");
        },
      }),
      SIGNAL,
      "gesture",
    );
    expect(part(outcome, "last-run")).toMatchObject({ reasonCode: "probe-error" });
    expect(JSON.stringify(outcome)).not.toContain("USERNAME");
    expect(isValidRow(outcome)).toBe(true);
  });
});

describe("Test 7 (W2): bounded and offline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("hands the probe's own signal to the key port and, when it never settles, returns once the signal aborts with probe-timeout, never ok", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 2000);
    let received: AbortSignal | undefined;
    const done = probeScheduler(
      {
        status: () => status(),
        keyPresence: (_trigger, signal) => {
          received = signal;
          return new Promise(() => undefined);
        },
        overrideTransportActive: false,
      },
      controller.signal,
      "gesture",
    );
    await vi.advanceTimersByTimeAsync(2000);
    const outcome = await done;
    expect(received).toBe(controller.signal);
    expect(part(outcome, "research-key")).toMatchObject({
      status: "unknown",
      reasonCode: "probe-timeout",
    });
    expect(outcome).toMatchObject({ status: "unknown", reasonCode: "probe-timeout" });
    expect(isValidRow(outcome)).toBe(true);
  });

  it("an already-aborted signal returns at once, reads probe-timeout and calls neither port", async () => {
    const controller = new AbortController();
    controller.abort();
    const call = vi.fn(() => Promise.resolve("present" as const));
    const read = vi.fn(() => status());
    const outcome = await probeScheduler(
      { status: read, keyPresence: call, overrideTransportActive: false },
      controller.signal,
      "gesture",
    );
    expect(outcome).toEqual({ id: "scheduler", status: "unknown", reasonCode: "probe-timeout" });
    expect(call).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  describe("makes no network or process call while it runs (module doubles that throw, FIX2A F7)", () => {
    let undoFetch: () => void = () => undefined;
    beforeEach(() => {
      networkCalls.length = 0;
      undoFetch = installFetchDouble();
    });
    afterEach(() => {
      undoFetch();
      networkCalls.length = 0;
    });

    it("the doubles are live: a call into any of them, or fetch, throws and is recorded", async () => {
      expect(Object.keys(LOAD_DOUBLE).sort()).toEqual([...NETWORK_DOUBLE_MODULES].sort());
      for (const name of NETWORK_DOUBLE_MODULES) {
        const load = LOAD_DOUBLE[name];
        if (load === undefined) throw new Error(`no loader for ${name}`);
        const module = (await load()) as Record<string, unknown>;
        const member = Object.entries(module).find(
          ([key, value]) => key !== "default" && typeof value === "function",
        );
        const call = member?.[1] as (() => void) | undefined;
        expect(call, name).toBeDefined();
        expect(() => call?.(), name).toThrow();
      }
      expect(() => fetch("https://example.invalid/")).toThrow();
      expect(networkCalls.length).toBe(NETWORK_DOUBLE_MODULES.length + 1);
      networkCalls.length = 0;
    });

    it("runs to its answer without touching any of them", async () => {
      await probeScheduler(
        ports(status({ lastSuccess: success(T_OLD) }), "present"),
        SIGNAL,
        "gesture",
      );
      expect(networkCalls).toEqual([]);
    });
  });
});
