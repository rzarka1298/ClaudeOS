import {
  DiagnosticsHealthResponseSchema,
  type ResearchStatusResponse,
  SUBSYSTEM_IDS,
} from "@ccc/domain";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { claudeStatus, codexStatus, partsOf } from "../test-support/diagnostics-probe-fixtures.js";
import type { CollectorsProbePorts } from "./collectors-probe.js";
import type { HooksProbePorts } from "./hooks-probe.js";
import type { LaunchersProbePorts } from "./launchers-probe.js";
import { createKeyPresenceCheck, type SchedulerProbePorts } from "./scheduler-probe.js";
import {
  createDiagnosticsServices,
  type DiagnosticsPorts,
  type DiagnosticsServices,
} from "./services.js";

/**
 * Plan 08-12 Task 1 (D-04, D-10, D-38, Amendment A1; T-08-30, T-08-31): the services take the four
 * read-only probe port sets and build the probes themselves, add the Keychain presence values and
 * the counts, and share ONE research-key presence read between the scheduler row and
 * `keychain.researchKey`. Fake ports, fake timers: nothing here spawns, reads a file or touches
 * the Keychain.
 */

const HOME = "/Users/USERNAME";
const NOW = new Date("2026-10-22T09:00:00.000Z");

const EMPTY_STATUS: ResearchStatusResponse = {
  lastSuccess: null,
  lastFailure: null,
  inFlight: null,
  latestUnknown: null,
  configuredSources: [{ label: "Example source", host: "example.test" }],
  topicLabel: "Example topic",
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

interface Fakes {
  hasResearchKey: ReturnType<typeof vi.fn>;
  portCalls: string[];
}

function build(
  options: {
    key?: "present" | "absent" | "error";
    override?: boolean;
    counts?: DiagnosticsPorts["counts"];
    extra?: Partial<DiagnosticsPorts>;
  } = {},
): { services: DiagnosticsServices; fakes: Fakes } {
  const portCalls: string[] = [];
  const hasResearchKey = vi.fn(() => Promise.resolve(options.key ?? "absent"));
  const now = (): Date => new Date(Date.now());
  const services = createDiagnosticsServices({
    vault: { readRoot: () => null },
    hooksPorts: {
      refreshSettingsFacts: () => {
        portCalls.push("hooks");
        return Promise.resolve(claudeStatus());
      },
      now,
    },
    collectorsPorts: {
      integration: () => Promise.resolve(claudeStatus()),
      spoolFacts: () => Promise.resolve({ count: 0, lastDropAt: null }),
      codexStatus: { status: () => codexStatus() },
      minimumClaudeVersion: "2.0.0",
      now,
    },
    schedulerPorts: {
      status: () => EMPTY_STATUS,
      keyPresence: createKeyPresenceCheck({ hasResearchKey }),
      overrideTransportActive: options.override ?? false,
    },
    launchersPorts: {
      listConfigs: () => [],
      probeBundle: () => Promise.resolve("found"),
      isExecutableFile: () => Promise.resolve(true),
    },
    keychain: { installSecret: "present" },
    counts: options.counts ?? (() => ({ projects: 0, scanFolders: 0, openTasks: 0, reports: 0 })),
    serviceFacts: {
      version: "0.1.0",
      startedAt: "2026-10-22T08:00:00.000Z",
      storeSchemaVersion: () => 12,
      homeDir: HOME,
      runtimeDir: `${HOME}/.example-runtime`,
      socketPath: `${HOME}/.example-runtime/svc.sock`,
    },
    now,
    log: () => undefined,
    ...options.extra,
  });
  return { services, fakes: { hasResearchKey, portCalls } };
}

describe("the port sets become probes (D-04)", () => {
  it("a fresh install on a gesture reads five setup-needed rows, nothing failing or degraded, the research key absent", async () => {
    const { services, fakes } = build({ key: "absent" });
    const response = await services.check("gesture");
    expect(DiagnosticsHealthResponseSchema.safeParse(response).success).toBe(true);
    expect(response.rows.map((row) => row.id)).toEqual(
      SUBSYSTEM_IDS.filter((id) => id !== "service"),
    );
    expect(response.rows.map((row) => row.status)).toEqual([
      "setup-needed",
      "setup-needed",
      "setup-needed",
      "setup-needed",
      "setup-needed",
    ]);
    expect(response.rows.some((row) => row.status === "failing" || row.status === "degraded")).toBe(
      false,
    );
    expect(response.rows.map((row) => row.freshness)).toEqual(Array(5).fill("live"));
    const scheduler = response.rows[3];
    expect(
      scheduler?.reasonCode === "never-run" || scheduler?.reasonCode === "research-key-missing",
    ).toBe(true);
    const keyPart = partsOf(scheduler as never).find((part) => part.partId === "research-key");
    expect(keyPart).toMatchObject({ status: "setup-needed", reasonCode: "research-key-missing" });
    expect(response.keychain).toEqual({ installSecret: "present", researchKey: "absent" });
    expect(response.counts).toEqual({ projects: 0, scanFolders: 0, openTasks: 0, reports: 0 });
    expect(fakes.hasResearchKey).toHaveBeenCalledTimes(1);
  });

  it("a reconnect before any gesture reads the scheduler unknown (research-key-not-checked) and keychain.researchKey unknown, with no key read", async () => {
    const { services, fakes } = build({ key: "absent" });
    const response = await services.check("reconnect");
    const keyPart = partsOf(response.rows[3] as never).find((p) => p.partId === "research-key");
    expect(keyPart).toMatchObject({ status: "unknown", reasonCode: "research-key-not-checked" });
    expect(response.keychain).toEqual({ installSecret: "present", researchKey: "unknown" });
    expect(fakes.hasResearchKey).not.toHaveBeenCalled();
  });

  it("an unwired port set still reads subsystem-not-wired, and an explicit Probe wins over a port set", async () => {
    const { services } = build({
      extra: {
        hooksPorts: undefined,
        collectorsPorts: undefined,
        schedulerPorts: undefined,
        launchersPorts: undefined,
        keychain: undefined,
        counts: undefined,
        hooks: () =>
          Promise.resolve({ id: "hooks", status: "ok", reasonCode: "hooks-receiving" } as never),
      },
    });
    const response = await services.check("reconnect");
    expect(response.rows.map((row) => row.reasonCode)).toEqual([
      "vault-not-set-up",
      "hooks-receiving",
      "subsystem-not-wired",
      "subsystem-not-wired",
      "subsystem-not-wired",
    ]);
    expect(response.keychain).toEqual({ installSecret: "unknown", researchKey: "unknown" });
    expect(response.counts).toEqual({
      projects: null,
      scanFolders: null,
      openTasks: null,
      reports: null,
    });
  });
});

describe("the research key presence (Amendment A1, D-38)", () => {
  it("one gesture check reads the key ONCE for both the scheduler part and keychain.researchKey", async () => {
    const { services, fakes } = build({ key: "present" });
    const response = await services.check("gesture");
    expect(fakes.hasResearchKey).toHaveBeenCalledTimes(1);
    expect(response.keychain.researchKey).toBe("present");
    const keyPart = partsOf(response.rows[3] as never).find((p) => p.partId === "research-key");
    expect(keyPart).toMatchObject({ status: "ok", reasonCode: "research-key-present" });
  });

  it("N reconnect checks make zero key reads, and a gesture result is reused by later reconnects", async () => {
    const { services, fakes } = build({ key: "present" });
    for (let i = 0; i < 6; i += 1) {
      await services.check("reconnect");
      await vi.advanceTimersByTimeAsync(2500); // past the 2 s result cache each time
    }
    expect(fakes.hasResearchKey).not.toHaveBeenCalled();

    await services.check("gesture");
    expect(fakes.hasResearchKey).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2500);
    for (let i = 0; i < 4; i += 1) {
      const response = await services.check("reconnect");
      expect(response.keychain.researchKey).toBe("present");
      await vi.advanceTimersByTimeAsync(2500);
    }
    expect(fakes.hasResearchKey).toHaveBeenCalledTimes(1);
  });

  it("a key check that failed reads unknown for keychain.researchKey, never absent", async () => {
    const { services } = build({ key: "error" });
    const response = await services.check("gesture");
    expect(response.keychain.researchKey).toBe("unknown");
    const keyPart = partsOf(response.rows[3] as never).find((p) => p.partId === "research-key");
    expect(keyPart).toMatchObject({ status: "unknown", reasonCode: "research-key-check-failed" });
  });

  it("with the guarded test transport the key is never read, the part is present and keychain.researchKey is unknown (nothing about the Keychain was observed)", async () => {
    const { services, fakes } = build({ override: true, key: "absent" });
    const response = await services.check("gesture");
    expect(fakes.hasResearchKey).not.toHaveBeenCalled();
    const keyPart = partsOf(response.rows[3] as never).find((p) => p.partId === "research-key");
    expect(keyPart).toMatchObject({ status: "ok", reasonCode: "research-key-present" });
    expect(response.keychain.researchKey).toBe("unknown");
  });

  it("FIX6A M1: a reconnect four hours after the gesture reads the key part not-checked and keychain.researchKey unknown, with a new generatedAt", async () => {
    const { services, fakes } = build({ key: "present" });
    const first = await services.check("gesture");
    expect(first.keychain.researchKey).toBe("present");
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
    const again = await services.check("reconnect");
    const keyPart = partsOf(again.rows[3] as never).find((p) => p.partId === "research-key");
    expect(keyPart).toMatchObject({ status: "unknown", reasonCode: "research-key-not-checked" });
    expect(again.keychain.researchKey).toBe("unknown");
    expect(again.generatedAt).not.toBe(first.generatedAt);
    expect(fakes.hasResearchKey).toHaveBeenCalledTimes(1);
  });

  it("a key read cut short by the probe cap reads unknown, not a late answer", async () => {
    const late = vi.fn(() => new Promise<"present">(() => undefined));
    const { services } = build({
      extra: {
        schedulerPorts: {
          status: () => EMPTY_STATUS,
          keyPresence: createKeyPresenceCheck({ hasResearchKey: late }),
          overrideTransportActive: false,
        },
      },
    });
    const pending = services.check("gesture");
    await vi.advanceTimersByTimeAsync(2000);
    const response = await pending;
    expect(response.rows[3]).toMatchObject({ freshness: "unavailable" });
    expect(response.keychain.researchKey).toBe("unknown");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("the counts (D-10)", () => {
  it("passes the counts through, null staying null", async () => {
    const { services } = build({
      counts: () => ({ projects: 3, scanFolders: null, openTasks: 12, reports: 2 }),
    });
    const response = await services.check("reconnect");
    expect(response.counts).toEqual({ projects: 3, scanFolders: null, openTasks: 12, reports: 2 });
  });

  it("a counts port that throws reads four nulls and never fails the response", async () => {
    const { services } = build({
      counts: () => {
        throw new Error(`${HOME}/private/operational.db is locked`);
      },
    });
    const response = await services.check("reconnect");
    expect(response.counts).toEqual({
      projects: null,
      scanFolders: null,
      openTasks: null,
      reports: null,
    });
    expect(JSON.stringify(response)).not.toContain("private");
  });
});

describe("Test 4 (type level): the ports the probes receive can only read", () => {
  it("lists exactly the allowed member names for each port set", () => {
    expectTypeOf<keyof HooksProbePorts>().toEqualTypeOf<"refreshSettingsFacts" | "now">();
    expectTypeOf<keyof CollectorsProbePorts>().toEqualTypeOf<
      "integration" | "spoolFacts" | "codexStatus" | "minimumClaudeVersion" | "now"
    >();
    expectTypeOf<keyof CollectorsProbePorts["codexStatus"]>().toEqualTypeOf<"status">();
    expectTypeOf<keyof SchedulerProbePorts>().toEqualTypeOf<
      "status" | "keyPresence" | "overrideTransportActive"
    >();
    expectTypeOf<keyof LaunchersProbePorts>().toEqualTypeOf<
      "listConfigs" | "probeBundle" | "isExecutableFile"
    >();
  });

  it("the services' own port record names no member that launches, spawns, writes, fetches or installs", () => {
    type Members = keyof DiagnosticsPorts;
    expectTypeOf<Members>().toEqualTypeOf<
      | "vault"
      | "hooks"
      | "collectors"
      | "scheduler"
      | "launchers"
      | "hooksPorts"
      | "collectorsPorts"
      | "schedulerPorts"
      | "launchersPorts"
      | "keychain"
      | "approvalPresence"
      | "counts"
      | "serviceFacts"
      | "now"
      | "log"
      | "monotonicNowMs"
    >();
    const forbidden =
      /spawn|launch(?!ers(Ports)?$)|write|fetch|install(?!Secret)|exec|runner|client/i;
    const names: string[] = [
      "vault",
      "hooks",
      "collectors",
      "scheduler",
      "launchers",
      "hooksPorts",
      "collectorsPorts",
      "schedulerPorts",
      "launchersPorts",
      "keychain",
      "approvalPresence",
      "counts",
      "serviceFacts",
      "now",
      "log",
      "monotonicNowMs",
    ];
    for (const name of names) expect(forbidden.test(name), name).toBe(false);
  });
});
