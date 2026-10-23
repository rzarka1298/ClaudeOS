import { readFileSync } from "node:fs";
import { MIN_SUPPORTED_CLAUDE_VERSION } from "@ccc/collectors";
import type { ResearchStatusResponse } from "@ccc/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CountDb } from "./diagnostics/counts.js";
import type { LauncherRow } from "./diagnostics/launchers-probe.js";
import { createDiagnosticsServices } from "./diagnostics/services.js";
import { createDiagnosticsPortSets, type DiagnosticsWiringDeps } from "./diagnostics-wiring.js";
import { createDetector } from "./projects/detection.js";
import { claudeStatus, codexStatus, partsOf } from "./test-support/diagnostics-probe-fixtures.js";
import { createFakeCommandRunner } from "./test-support/fake-command-runner.js";
import { installFetchDouble, networkCalls } from "./test-support/no-network.js";

vi.mock("node:http", async () =>
  (await import("./test-support/no-network.js")).networkDouble("node:http"),
);
vi.mock("node:https", async () =>
  (await import("./test-support/no-network.js")).networkDouble("node:https"),
);
vi.mock("node:http2", async () =>
  (await import("./test-support/no-network.js")).networkDouble("node:http2"),
);
vi.mock("node:net", async () =>
  (await import("./test-support/no-network.js")).networkDouble("node:net"),
);
vi.mock("node:tls", async () =>
  (await import("./test-support/no-network.js")).networkDouble("node:tls"),
);
vi.mock("node:dgram", async () =>
  (await import("./test-support/no-network.js")).networkDouble("node:dgram"),
);
vi.mock("node:dns", async () =>
  (await import("./test-support/no-network.js")).networkDouble("node:dns"),
);
vi.mock("node:dns/promises", async () =>
  (await import("./test-support/no-network.js")).networkDouble("node:dns/promises"),
);
vi.mock("node:child_process", async () =>
  (await import("./test-support/no-network.js")).networkDouble("node:child_process"),
);

/**
 * Plan 08-12 Task 1 (D-04, D-38, D-49; T-08-30, T-08-30b, T-08-31; research A 1.5): the composition
 * of the real service objects into the narrow, read-only probe ports. The Keychain presence
 * closure uses the SAME resolved account the research pipeline reads; the guarded test transport
 * skips the check; the bundle lookup runs through the fixed-argv command runner with the probe's own
 * signal; and one health call makes no network call. Fakes only: `/usr/bin/security`, `mdfind` and
 * `plutil` are never run.
 */

const NOW = new Date("2026-10-22T09:00:00.000Z");
const HOME = "/Users/USERNAME";
const ACCOUNT = "ccc-uat-resolved-account";
const BUNDLE = "com.example.antigravity-fixture";
const CLAUDE_BIN = "/opt/example/bin/claude";

const STATUS: ResearchStatusResponse = {
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
  networkCalls.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

const antigravity = (tested = false): LauncherRow => ({
  launcherId: "antigravity",
  config: { bundleId: BUNDLE },
  tested,
});
const claude = (tested = false): LauncherRow => ({
  launcherId: "claude-code",
  config: { executablePath: CLAUDE_BIN, args: [], terminal: { kind: "terminal-app" } },
  tested,
});

interface Spies {
  hasSecret: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
  spool: ReturnType<typeof vi.fn>;
  bundleSignals: (AbortSignal | undefined)[];
}

function deps(over: Partial<DiagnosticsWiringDeps> = {}): {
  deps: DiagnosticsWiringDeps;
  spies: Spies;
} {
  const hasSecret = vi.fn((_account: string, _options: { signal: AbortSignal }) =>
    Promise.resolve("absent" as const),
  );
  const refresh = vi.fn((_signal?: AbortSignal) => Promise.resolve(claudeStatus()));
  const spool = vi.fn(() => Promise.resolve({ count: 0, lastDropAt: null }));
  const bundleSignals: (AbortSignal | undefined)[] = [];
  const built: DiagnosticsWiringDeps = {
    usage: { refreshSettingsFacts: refresh, spoolFacts: spool },
    codexIntegration: { status: () => codexStatus() },
    research: { status: () => ({ ok: true, value: STATUS }) },
    researchKeyAccount: ACCOUNT,
    hasSecret,
    overrideTransportActive: false,
    listLauncherConfigs: () => [],
    probeBundle: (_id, options) => {
      bundleSignals.push(options?.signal);
      return Promise.resolve("found");
    },
    isExecutableFile: () => Promise.resolve(true),
    installSecretPresent: true,
    db: { prepare: () => ({ get: () => ({ n: 5 }) }) } satisfies CountDb,
    now: () => new Date(Date.now()),
    ...over,
  };
  return { deps: built, spies: { hasSecret, refresh, spool, bundleSignals } };
}

function services(wiring: DiagnosticsWiringDeps) {
  return createDiagnosticsServices({
    vault: { readRoot: () => null },
    ...createDiagnosticsPortSets(wiring),
    serviceFacts: {
      version: "0.1.0",
      startedAt: "2026-10-22T08:00:00.000Z",
      storeSchemaVersion: () => 12,
      homeDir: HOME,
      runtimeDir: `${HOME}/.example-runtime`,
      socketPath: `${HOME}/.example-runtime/svc.sock`,
    },
    now: wiring.now,
    log: () => undefined,
  });
}

describe("Test 2: the research key closure uses the resolved account (D-38, T-08-31)", () => {
  it("with the guarded test transport active the key port is never called and the key part is present", async () => {
    const { deps: wiring, spies } = deps({ overrideTransportActive: true });
    const response = await services(wiring).check("gesture");
    expect(spies.hasSecret).not.toHaveBeenCalled();
    const key = partsOf(response.rows[3] as never).find((part) => part.partId === "research-key");
    expect(key).toMatchObject({ status: "ok", reasonCode: "research-key-present" });
  });

  it("with the flag off, a gesture hands hasSecret exactly the resolved account and the probe's live signal", async () => {
    const { deps: wiring, spies } = deps();
    await services(wiring).check("gesture");
    expect(spies.hasSecret).toHaveBeenCalledTimes(1);
    const [account, options] = spies.hasSecret.mock.calls[0] as [string, { signal: AbortSignal }];
    expect(account).toBe(ACCOUNT);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("a reconnect never calls hasSecret", async () => {
    const { deps: wiring, spies } = deps();
    const live = services(wiring);
    for (let i = 0; i < 5; i += 1) {
      await live.check("reconnect");
      await vi.advanceTimersByTimeAsync(2500);
    }
    expect(spies.hasSecret).not.toHaveBeenCalled();
  });

  it("FIX3A MAJOR-1: main.ts resolves 'runtime inside the vault' asynchronously (at start and on vault setup) and the research status read takes the cached answer", () => {
    const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
    expect(main).toContain("createRuntimeVaultGuard({");
    expect(main).toMatch(/realpath: \(path\) => realpath\(path\)/); // fs/promises, not realpathSync
    expect(main).not.toMatch(/realpathSync/);
    expect(main).toMatch(/void runtimeVaultGuard\.refresh\(\);\n\s*const runInspector/);
    expect(main).toMatch(/onVaultSetup: \(\) => \{\n\s*void runtimeVaultGuard\.refresh\(\);/);
    expect(main).toContain("isRuntimeInsideVault: (root) => runtimeVaultGuard.insideVault(root)");
  });

  it("main.ts resolves the account once and hands that same variable to the pipeline's key reader and to the diagnostics wiring (no literal)", () => {
    const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
    expect(main).toMatch(
      /const researchKeyAccount = researchOverrides\.keyAccount \?\? RESEARCH_API_KEY_ACCOUNT;/,
    );
    expect(main).toContain("readApiKey: () => secretStore.get(researchKeyAccount)");
    expect(main).toMatch(/createDiagnosticsPortSets\(\{[\s\S]*?\bresearchKeyAccount,[\s\S]*?\}\)/);
    // The constant appears only in its import and the one resolution line.
    expect(main.match(/RESEARCH_API_KEY_ACCOUNT/g)).toHaveLength(2);
    // Declared before the diagnostics services are built from it.
    expect(main.indexOf("const researchKeyAccount")).toBeLessThan(
      main.indexOf("createDiagnosticsServices({"),
    );
    // hasSecret is handed in, never called with an account literal.
    expect(main).not.toMatch(/hasSecret\(\s*["'`]/);
  });
});

describe("the ports are narrow and read-only (T-08-30)", () => {
  it("builds exactly the allowed members per port set", () => {
    const { deps: wiring } = deps();
    const sets = createDiagnosticsPortSets(wiring);
    expect(Object.keys(sets).sort()).toEqual(
      [
        "collectorsPorts",
        "counts",
        "hooksPorts",
        "keychain",
        "launchersPorts",
        "schedulerPorts",
      ].sort(),
    );
    expect(Object.keys(sets.hooksPorts ?? {}).sort()).toEqual(["now", "refreshSettingsFacts"]);
    expect(Object.keys(sets.collectorsPorts ?? {}).sort()).toEqual(
      ["codexStatus", "integration", "minimumClaudeVersion", "now", "spoolFacts"].sort(),
    );
    expect(Object.keys(sets.collectorsPorts?.codexStatus ?? {})).toEqual(["status"]);
    expect(Object.keys(sets.schedulerPorts ?? {}).sort()).toEqual(
      ["keyPresence", "overrideTransportActive", "status"].sort(),
    );
    expect(Object.keys(sets.launchersPorts ?? {}).sort()).toEqual(
      ["isExecutableFile", "listConfigs", "probeBundle"].sort(),
    );
    expect(sets.collectorsPorts?.minimumClaudeVersion).toBe(MIN_SUPPORTED_CLAUDE_VERSION);
  });

  it("without the Codex integration service the collectors port set is left unwired", async () => {
    const { deps: wiring } = deps({ codexIntegration: undefined });
    expect(createDiagnosticsPortSets(wiring).collectorsPorts).toBeUndefined();
    const response = await services(wiring).check("reconnect");
    expect(response.rows[2]).toMatchObject({
      id: "collectors",
      status: "unknown",
      reasonCode: "subsystem-not-wired",
    });
  });

  it("the research status that is not bound yet reads subsystem-not-wired parts, and a bound one is projected", async () => {
    const unbound = deps({
      research: { status: () => ({ ok: false, code: "service-disconnected" }) },
    });
    const row = (await services(unbound.deps).check("reconnect")).rows[3];
    const lastRun = partsOf(row as never).find((part) => part.partId === "last-run");
    expect(lastRun).toMatchObject({ status: "unknown", reasonCode: "subsystem-not-wired" });

    const bound = deps();
    const projected = (await services(bound.deps).check("reconnect")).rows[3];
    const never = partsOf(projected as never).find((part) => part.partId === "last-run");
    expect(never).toMatchObject({ reasonCode: "never-run" });
  });

  it("the hooks and collectors ports re-read the settings facts with the probe's signal, and the spool facts come from the usage services", async () => {
    const { deps: wiring, spies } = deps();
    await services(wiring).check("reconnect");
    expect(spies.refresh).toHaveBeenCalledTimes(2);
    for (const call of spies.refresh.mock.calls) {
      expect(call[0]).toBeInstanceOf(AbortSignal);
    }
    expect(spies.spool).toHaveBeenCalledTimes(1);
  });

  it("the install secret is reported present from the startup read, unknown if the flag says otherwise, with no Keychain call", async () => {
    const present = deps();
    expect((await services(present.deps).check("gesture")).keychain.installSecret).toBe("present");
    const not = deps({ installSecretPresent: false });
    expect((await services(not.deps).check("gesture")).keychain.installSecret).toBe("unknown");
    // Only the research key was ever asked about (twice over two services: once each).
    expect(present.spies.hasSecret.mock.calls.map((call) => call[0])).toEqual([ACCOUNT]);
  });

  it("the counts come from the store reader", async () => {
    const { deps: wiring } = deps();
    const response = await services(wiring).check("reconnect");
    expect(response.counts).toEqual({ projects: 5, scanFolders: 5, openTasks: 5, reports: 5 });
  });
});

describe("Test 5 (W2): process-backed ports are fixed-argv, bounded, signalled and offline", () => {
  function scriptedRunner() {
    return createFakeCommandRunner({
      script: [
        {
          match: (file) => file === "/usr/bin/mdfind",
          outcome: {
            stdout: "/Applications/Example.app\n/System/Applications/Utilities/Terminal.app\n",
          },
        },
        { match: (file) => file === "/usr/bin/plutil", outcome: { stdout: BUNDLE } },
      ],
    });
  }

  it("every command is an absolute binary with an argv array, no shell, a timeout of 1,500 ms or less and the probe's own signal, and the health call makes no network call", async () => {
    const restore = installFetchDouble();
    try {
      const runner = scriptedRunner();
      const detector = createDetector({ runner, homeDir: HOME, env: {} });
      const seen: (AbortSignal | undefined)[] = [];
      const { deps: wiring } = deps({
        listLauncherConfigs: () => [antigravity(false), claude(false)],
        probeBundle: (id, options) => {
          seen.push(options?.signal);
          return detector.probeBundle(id, options);
        },
      });
      const response = await services(wiring).check("gesture");

      const launchers = partsOf(response.rows[4] as never);
      expect(launchers.find((p) => p.partId === "antigravity")).toMatchObject({
        reasonCode: "launcher-untested",
      });
      expect(launchers.find((p) => p.partId === "claude-code")).toMatchObject({
        reasonCode: "launcher-untested",
      });

      expect(runner.calls.length).toBeGreaterThanOrEqual(2);
      expect(seen).toHaveLength(1);
      const probeSignal = seen[0];
      expect(probeSignal).toBeInstanceOf(AbortSignal);
      for (const call of runner.calls) {
        expect(call.file.startsWith("/usr/bin/")).toBe(true);
        expect(Array.isArray(call.args)).toBe(true);
        for (const arg of call.args) expect(typeof arg).toBe("string");
        expect((call.options as { shell?: unknown }).shell).not.toBe(true);
        expect(call.options.timeoutMs).toBeLessThanOrEqual(1500);
        expect(call.options.signal).toBe(probeSignal);
      }
      expect(networkCalls).toEqual([]);
    } finally {
      restore();
    }
  });

  it("aborting the probe's signal (the 2 s cap) settles the health call with probe-timeout rows and kills the commands", async () => {
    const aborted: AbortSignal[] = [];
    const hanging = {
      run: (_file: string, _args: readonly string[], options: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          if (options.signal !== undefined) {
            aborted.push(options.signal);
            options.signal.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          }
        }),
    };
    const detector = createDetector({
      runner: hanging as never,
      homeDir: HOME,
      env: {},
    });
    const keySignals: AbortSignal[] = [];
    const { deps: wiring } = deps({
      listLauncherConfigs: () => [antigravity(true)],
      probeBundle: (id, options) => detector.probeBundle(id, options),
      hasSecret: (_account, options) =>
        new Promise<"error">((resolve) => {
          keySignals.push(options.signal);
          options.signal.addEventListener("abort", () => resolve("error"), { once: true });
        }),
    });
    const pending = services(wiring).check("gesture");
    await vi.advanceTimersByTimeAsync(2000);
    const response = await pending;
    expect(response.rows[4]).toMatchObject({
      reasonCode: "probe-timeout",
      freshness: "unavailable",
    });
    expect(response.rows[3]).toMatchObject({
      reasonCode: "probe-timeout",
      freshness: "unavailable",
    });
    expect(aborted.length).toBeGreaterThan(0);
    for (const signal of [...aborted, ...keySignals]) expect(signal.aborted).toBe(true);
    expect(response.keychain.researchKey).toBe("unknown");
    expect(vi.getTimerCount()).toBe(0);
  });
});
