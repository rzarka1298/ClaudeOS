import { execFile as execFileDouble } from "node:child_process";
import { LAUNCHER_PART_IDS } from "@ccc/domain";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { isValidRow, partsOf } from "../test-support/diagnostics-probe-fixtures.js";
import {
  installFetchDouble,
  NETWORK_DOUBLE_MODULES,
  networkCalls,
} from "../test-support/no-network.js";
import {
  type BundleProbeAnswer,
  type LauncherRow,
  type LaunchersProbePorts,
  probeLaunchers,
} from "./launchers-probe.js";

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
 * Plan 08-08 Task 2 (D-04, D-05, D-49; T-08-19, T-08-20, T-08-21, T-08-22b): the launchers row
 * reads the saved launcher rows only. An app is checked with the bounded `probeBundle`, an
 * executable with a regular-file-and-execute check; nothing is launched, spawned here or written,
 * and no path, bundle id or argv is returned.
 */

const SIGNAL = new AbortController().signal;
const BUNDLE_ANTIGRAVITY = "com.example.antigravity-fixture";
const BUNDLE_DESKTOP = "com.example.desktop-fixture";
const CLAUDE_BIN = "/opt/example/bin/claude";
const CODEX_BIN = "/opt/example/bin/codex";
const TERMINAL_BIN = "/opt/example/bin/terminal-fixture";

function row(launcherId: string, config: unknown, tested = false): LauncherRow {
  return { launcherId, config, tested };
}

const antigravity = (tested = false) =>
  row("antigravity", { bundleId: BUNDLE_ANTIGRAVITY }, tested);
const desktop = (tested = false) => row("claude-desktop", { bundleId: BUNDLE_DESKTOP }, tested);
const claude = (tested = false, terminal: unknown = { kind: "terminal-app" }) =>
  row("claude-code", { executablePath: CLAUDE_BIN, args: [], terminal }, tested);
const codex = (tested = false) => row("codex", { executablePath: CODEX_BIN, args: [] }, tested);
const customTerminal = { kind: "custom", preset: "blank", argv: [TERMINAL_BIN, "{script}"] };

interface Recorded {
  bundleCalls: { bundleId: string; signal: AbortSignal | undefined }[];
  fileCalls: string[];
}

function ports(
  rows: readonly LauncherRow[],
  answers: {
    bundle?: (bundleId: string) => BundleProbeAnswer;
    executable?: (path: string) => boolean;
  } = {},
): LaunchersProbePorts & Recorded {
  const recorded: Recorded = { bundleCalls: [], fileCalls: [] };
  return Object.assign(recorded, {
    listConfigs: () => rows,
    probeBundle: (bundleId: string, options: { signal?: AbortSignal }) => {
      recorded.bundleCalls.push({ bundleId, signal: options.signal });
      return Promise.resolve((answers.bundle ?? (() => "found"))(bundleId));
    },
    isExecutableFile: (path: string) => {
      recorded.fileCalls.push(path);
      return Promise.resolve((answers.executable ?? (() => true))(path));
    },
  });
}

function part(outcome: Awaited<ReturnType<typeof probeLaunchers>>, partId: string) {
  const found = partsOf(outcome).find((candidate) => candidate.partId === partId);
  if (found === undefined) throw new Error(`no part ${partId}`);
  return found;
}

const GO_LAUNCHERS = { kind: "go-to-section", section: "launchers" } as const;

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

describe("Test 4: every launcher state", () => {
  it("no saved row reads launcher-not-set-up for all four, with the launchers section action, and a setup-needed row", async () => {
    const outcome = await probeLaunchers(ports([]), SIGNAL);
    expect(partsOf(outcome).map((p) => p.partId)).toEqual([
      "antigravity",
      "claude-code",
      "claude-desktop",
      "codex",
    ]);
    for (const p of partsOf(outcome)) {
      expect(p).toEqual({
        partId: p.partId,
        status: "setup-needed",
        reasonCode: "launcher-not-set-up",
        setupAction: GO_LAUNCHERS,
      });
    }
    expect(outcome).toMatchObject({
      id: "launchers",
      status: "setup-needed",
      reasonCode: "launcher-not-set-up",
      setupAction: GO_LAUNCHERS,
    });
    expect(isValidRow(outcome)).toBe(true);
  });

  it("a saved, untested app that is found reads launcher-untested", async () => {
    const outcome = await probeLaunchers(ports([antigravity(false)]), SIGNAL);
    expect(part(outcome, "antigravity")).toEqual({
      partId: "antigravity",
      status: "setup-needed",
      reasonCode: "launcher-untested",
      setupAction: GO_LAUNCHERS,
    });
  });

  it("a tested app that is found reads launcher-ready with no action", async () => {
    const outcome = await probeLaunchers(ports([antigravity(true)]), SIGNAL);
    expect(part(outcome, "antigravity")).toEqual({
      partId: "antigravity",
      status: "ok",
      reasonCode: "launcher-ready",
    });
  });

  it("a bundle that is not found reads bundle-not-found (failing), tested or not", async () => {
    for (const tested of [false, true]) {
      const outcome = await probeLaunchers(
        ports([desktop(tested)], { bundle: () => "not-found" }),
        SIGNAL,
      );
      expect(part(outcome, "claude-desktop")).toEqual({
        partId: "claude-desktop",
        status: "failing",
        reasonCode: "bundle-not-found",
        setupAction: GO_LAUNCHERS,
      });
      expect(outcome).toMatchObject({ status: "failing", reasonCode: "bundle-not-found" });
      expect(isValidRow(outcome)).toBe(true);
    }
  });

  it("an indeterminate lookup reads bundle-check-unavailable (unknown) with no action", async () => {
    const outcome = await probeLaunchers(
      ports([antigravity(true)], { bundle: () => "indeterminate" }),
      SIGNAL,
    );
    expect(part(outcome, "antigravity")).toEqual({
      partId: "antigravity",
      status: "unknown",
      reasonCode: "bundle-check-unavailable",
    });
    expect(isValidRow(outcome)).toBe(true);
  });

  it("a saved executable that is there reads untested or ready; one that fails the check reads executable-not-found", async () => {
    const found = await probeLaunchers(ports([claude(true), codex(false)]), SIGNAL);
    expect(part(found, "claude-code")).toMatchObject({
      status: "ok",
      reasonCode: "launcher-ready",
    });
    expect(part(found, "codex")).toMatchObject({
      status: "setup-needed",
      reasonCode: "launcher-untested",
    });

    const missing = await probeLaunchers(
      ports([claude(true), codex(true)], { executable: (path) => path === CLAUDE_BIN }),
      SIGNAL,
    );
    expect(part(missing, "codex")).toEqual({
      partId: "codex",
      status: "failing",
      reasonCode: "executable-not-found",
      setupAction: GO_LAUNCHERS,
    });
    expect(part(missing, "claude-code")).toMatchObject({ reasonCode: "launcher-ready" });
    expect(isValidRow(missing)).toBe(true);
  });

  it("a stored Claude Code executable that is not an absolute path is an unreadable row, so not set up, with no file-system call", async () => {
    const bad = (path: string) =>
      row(
        "claude-code",
        { executablePath: path, args: [], terminal: { kind: "terminal-app" } },
        true,
      );
    for (const path of ["claude", "./claude", "/opt/bad\u0000path", `/opt/${"a".repeat(4100)}`]) {
      const p = ports([bad(path)]);
      const outcome = await probeLaunchers(p, SIGNAL);
      expect(part(outcome, "claude-code"), path.slice(0, 20)).toMatchObject({
        reasonCode: "launcher-not-set-up",
      });
      expect(p.fileCalls, path.slice(0, 20)).toEqual([]);
    }
  });

  it("a custom terminal whose argv[0] is not an absolute path reads terminal-not-found without a file-system call", async () => {
    for (const first of ["terminal-fixture", "./terminal-fixture"]) {
      const p = ports([
        claude(true, { kind: "custom", preset: "blank", argv: [first, "{script}"] }),
      ]);
      const outcome = await probeLaunchers(p, SIGNAL);
      expect(part(outcome, "terminal"), first).toMatchObject({ reasonCode: "terminal-not-found" });
      // Only the Claude Code executable was checked.
      expect(p.fileCalls, first).toEqual([CLAUDE_BIN]);
    }
  });

  it("a custom terminal whose argv[0] fails the check reads terminal-not-found on the terminal part", async () => {
    const outcome = await probeLaunchers(
      ports([claude(true, customTerminal)], { executable: (path) => path !== TERMINAL_BIN }),
      SIGNAL,
    );
    expect(part(outcome, "terminal")).toEqual({
      partId: "terminal",
      status: "failing",
      reasonCode: "terminal-not-found",
      setupAction: GO_LAUNCHERS,
    });
    expect(part(outcome, "claude-code")).toMatchObject({ reasonCode: "launcher-ready" });
    expect(isValidRow(outcome)).toBe(true);
  });

  it("an unparseable stored row reads not set up", async () => {
    const outcome = await probeLaunchers(
      ports([
        row("antigravity", { bundleId: "not a bundle id" }, true),
        row("claude-code", { nonsense: true }, true),
        row("codex", "garbage", true),
        row("claude-desktop", null, true),
      ]),
      SIGNAL,
    );
    for (const id of ["antigravity", "claude-code", "claude-desktop", "codex"]) {
      expect(part(outcome, id)).toMatchObject({ reasonCode: "launcher-not-set-up" });
    }
    expect(isValidRow(outcome)).toBe(true);
  });
});

describe("Test 6: the terminal part and the roll-up", () => {
  it("the terminal part appears only for a custom terminal choice, and last", async () => {
    const plain = await probeLaunchers(ports([claude(true)]), SIGNAL);
    expect(partsOf(plain).map((p) => p.partId)).toEqual([
      "antigravity",
      "claude-code",
      "claude-desktop",
      "codex",
    ]);
    const antigravityTerminal = await probeLaunchers(
      ports([claude(true, { kind: "antigravity-terminal" })]),
      SIGNAL,
    );
    expect(partsOf(antigravityTerminal).map((p) => p.partId)).toEqual([
      "antigravity",
      "claude-code",
      "claude-desktop",
      "codex",
    ]);
    const custom = await probeLaunchers(ports([claude(true, customTerminal)]), SIGNAL);
    expect(partsOf(custom).map((p) => p.partId)).toEqual([...LAUNCHER_PART_IDS]);
    expect(part(custom, "terminal")).toMatchObject({ status: "ok", reasonCode: "launcher-ready" });
    const untested = await probeLaunchers(ports([claude(false, customTerminal)]), SIGNAL);
    expect(part(untested, "terminal")).toMatchObject({ reasonCode: "launcher-untested" });
    expect(isValidRow(custom)).toBe(true);
  });

  it("one ready launcher keeps the row ok while the others are not set up", async () => {
    const outcome = await probeLaunchers(ports([antigravity(true)]), SIGNAL);
    expect(outcome).toMatchObject({ id: "launchers", status: "ok", reasonCode: "launcher-ready" });
    expect(isValidRow(outcome)).toBe(true);
  });

  it("one failing launcher makes the row failing with that launcher's reason", async () => {
    const outcome = await probeLaunchers(
      ports([antigravity(true), desktop(true)], {
        bundle: (id) => (id === BUNDLE_DESKTOP ? "not-found" : "found"),
      }),
      SIGNAL,
    );
    expect(outcome).toMatchObject({ status: "failing", reasonCode: "bundle-not-found" });
  });
});

describe("Test 5: safety", () => {
  it("hands probeBundle the probe's own signal, once per saved app, and checks only the saved ids", async () => {
    const controller = new AbortController();
    const p = ports([antigravity(true), desktop(true), claude(true), codex(true)]);
    await probeLaunchers(p, controller.signal);
    expect(p.bundleCalls.map((call) => call.bundleId).sort()).toEqual(
      [BUNDLE_ANTIGRAVITY, BUNDLE_DESKTOP].sort(),
    );
    for (const call of p.bundleCalls) expect(call.signal).toBe(controller.signal);
    expect(p.fileCalls.sort()).toEqual([CLAUDE_BIN, CODEX_BIN].sort());
  });

  it("the ports type has exactly three members and no launch, spawn or write member", () => {
    expectTypeOf<keyof LaunchersProbePorts>().toEqualTypeOf<
      "listConfigs" | "probeBundle" | "isExecutableFile"
    >();
    const invalid: LaunchersProbePorts = {
      listConfigs: () => [],
      probeBundle: () => Promise.resolve("found"),
      isExecutableFile: () => Promise.resolve(true),
      // @ts-expect-error a launch member does not exist on the ports
      launch: () => Promise.resolve(),
    };
    expect(Object.keys(invalid)).toContain("listConfigs");
  });

  it("returns no path, bundle id, argv or executable string in any field", async () => {
    const outcome = await probeLaunchers(
      ports([antigravity(true), desktop(true), claude(true, customTerminal), codex(true)], {
        bundle: (id) => (id === BUNDLE_DESKTOP ? "not-found" : "found"),
        executable: (path) => path !== CODEX_BIN,
      }),
      SIGNAL,
    );
    const text = JSON.stringify(outcome);
    for (const forbidden of [
      BUNDLE_ANTIGRAVITY,
      BUNDLE_DESKTOP,
      "/opt/",
      "example",
      "{script}",
      "terminal-fixture",
    ]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
    expect(isValidRow(outcome)).toBe(true);
  });

  it("reads probe-error, with no message, when the saved-row read throws", async () => {
    const outcome = await probeLaunchers(
      {
        ...ports([]),
        listConfigs: () => {
          throw new Error("SQLITE_CORRUPT: /Users/USERNAME/operational.db");
        },
      },
      SIGNAL,
    );
    expect(outcome).toEqual({ id: "launchers", status: "unknown", reasonCode: "probe-error" });
  });

  it("a port that throws marks only that launcher probe-error", async () => {
    const outcome = await probeLaunchers(
      {
        ...ports([antigravity(true), claude(true)]),
        probeBundle: () => Promise.reject(new Error("mdfind: /Users/USERNAME")),
      },
      SIGNAL,
    );
    expect(part(outcome, "antigravity")).toEqual({
      partId: "antigravity",
      status: "unknown",
      reasonCode: "probe-error",
    });
    expect(part(outcome, "claude-code")).toMatchObject({ reasonCode: "launcher-ready" });
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

  it("with a probeBundle that never settles the probe returns once the signal aborts and the part reads unknown (probe-timeout), never ok", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 2000);
    const done = probeLaunchers(
      {
        ...ports([antigravity(true), claude(true)]),
        probeBundle: () => new Promise(() => undefined),
      },
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(2000);
    const outcome = await done;
    expect(part(outcome, "antigravity")).toEqual({
      partId: "antigravity",
      status: "unknown",
      reasonCode: "probe-timeout",
    });
    expect(part(outcome, "claude-code")).toMatchObject({ reasonCode: "launcher-ready" });
    expect(outcome).toMatchObject({ status: "unknown", reasonCode: "probe-timeout" });
    expect(isValidRow(outcome)).toBe(true);
  });

  it("an already-aborted signal returns probe-timeout at once and calls no port", async () => {
    const controller = new AbortController();
    controller.abort();
    const p = ports([antigravity(true), claude(true)]);
    const list = vi.fn(p.listConfigs);
    const outcome = await probeLaunchers({ ...p, listConfigs: list }, controller.signal);
    expect(outcome).toEqual({ id: "launchers", status: "unknown", reasonCode: "probe-timeout" });
    expect(list).not.toHaveBeenCalled();
    expect(p.bundleCalls).toEqual([]);
    expect(p.fileCalls).toEqual([]);
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
      await probeLaunchers(
        ports([antigravity(true), claude(true, customTerminal), codex(true)]),
        SIGNAL,
      );
      expect(networkCalls).toEqual([]);
    });
  });
});
