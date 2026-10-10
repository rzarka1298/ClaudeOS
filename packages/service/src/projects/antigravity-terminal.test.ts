import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TerminalLaunchInput } from "@ccc/domain";
import { createRunIdMinter, openInApp } from "@ccc/launchers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AgentBridgeRequest,
  withdrawRequest,
  writeBridgeRequest,
} from "../codex/bridge-queue.js";
import { coveringWindows, readBridgeStatus } from "../codex/bridge-state.js";
import {
  type BridgeFixture,
  createBridgeFixture,
  type WindowSimulator,
} from "../test-support/bridge-fixtures.js";
import { createFakeSpawner, type FakeSpawner } from "../test-support/fake-spawner.js";
import {
  ANTIGRAVITY_IDE_BUNDLE_ID,
  type AntigravityTerminalDeps,
  adapterDeadlineMs,
  bridgeRunIdFor,
  createAntigravityTerminalLauncher,
  defaultAgentChecks,
  rememberBridgeRun,
} from "./antigravity-terminal.js";

let fx: BridgeFixture;
let spawner: FakeSpawner;
let clock: { t: number };
let sleepHook: () => void;
let logged: string[];
let sleeps: number[];
let started: number;

beforeEach(() => {
  fx = createBridgeFixture();
  fx.installLauncher();
  fx.installMarker();
  spawner = createFakeSpawner();
  clock = { t: Date.now() };
  started = clock.t;
  sleepHook = () => {};
  logged = [];
  sleeps = [];
});

afterEach(() => {
  fx.cleanup();
});

function deps(overrides: Partial<AntigravityTerminalDeps> = {}): AntigravityTerminalDeps {
  return {
    readStatus: () => readBridgeStatus({ env: {}, home: fx.home, now: clock.t }),
    windowsCovering: (status, root) => coveringWindows(status, root),
    savedBundleId: () => ANTIGRAVITY_IDE_BUNDLE_ID,
    savedExecutables: () => ({ claude: fx.claudePath, codex: fx.codexPath }),
    spawner,
    now: () => clock.t,
    sleep: (ms) => {
      sleeps.push(ms);
      clock.t += ms;
      sleepHook();
      return Promise.resolve();
    },
    mintRunId: createRunIdMinter(() => clock.t),
    ...defaultAgentChecks,
    log: (reason) => logged.push(reason),
    ...overrides,
  };
}

function input(overrides: Partial<TerminalLaunchInput> = {}): TerminalLaunchInput {
  return {
    cwd: fx.projectDir,
    argv: [fx.claudePath, "--permission-mode", "plan"],
    env: { CCC_RUN_ID: "run-product-1", CCC_LAUNCH_SOURCE: "dashboard" },
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** A current-mode window on the project that claims on every sleep (the extension's poll). */
function warmWindow(folders: string[] = [fx.projectDir]): WindowSimulator {
  const sim = fx.simulator("current", { folders, now: () => clock.t, containDelayMs: 0 });
  sim.heartbeat();
  return sim;
}

function claimedRequest(runId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(fx.claimedDir, `${runId}.json`), "utf8"));
}

function expectNoRequests(): void {
  expect(fx.requestFiles()).toEqual([]);
  expect(fx.claimedFiles()).toEqual([]);
}

function expectNothingWritten(): void {
  expect(fx.requestFiles()).toEqual([]);
  expect(fx.claimedFiles()).toEqual([]);
  expect(existsSync(join(fx.stateDir, "agent-pins.json"))).toBe(false);
}

describe("the Antigravity terminal adapter (tracer)", () => {
  it("hands a Claude launch to a warm window: one validated request, the window claims it, no process is spawned", async () => {
    const sim = warmWindow();
    sleepHook = () => void sim.tick();
    const launcher = createAntigravityTerminalLauncher(deps());
    await expect(launcher.launch(input())).resolves.toEqual({ ok: true });

    expect(fx.requestFiles()).toEqual([]);
    const claimed = fx.claimedFiles();
    expect(claimed).toHaveLength(1);
    const runId = (claimed[0] as string).replace(/\.json$/, "");
    expect(claimedRequest(runId)).toMatchObject({
      runId,
      kind: "agent",
      mode: "agent",
      agent: "claude",
      projectRoot: fx.projectDir,
      cwd: fx.projectDir,
      argv: [fx.claudePath, "--permission-mode", "plan"],
      env: { CCC_RUN_ID: "run-product-1", CCC_LAUNCH_SOURCE: "dashboard" },
      sessionId: null,
      liveLog: null,
      pid: null,
      protocol: 2,
    });
    expect(spawner.calls).toHaveLength(0);
    // The helper's pin file names the saved executable for each agent.
    expect(JSON.parse(readFileSync(join(fx.stateDir, "agent-pins.json"), "utf8"))).toEqual({
      schemaVersion: 1,
      claude: fx.claudePath,
      codex: fx.codexPath,
    });
    expect(bridgeRunIdFor("run-product-1")).toBe(runId);
  });

  it("the same launch with a codex executable writes agent codex", async () => {
    const sim = warmWindow();
    sleepHook = () => void sim.tick();
    const result = await createAntigravityTerminalLauncher(deps()).launch(
      input({ argv: [fx.codexPath], env: { CCC_RUN_ID: "run-product-2" } }),
    );
    expect(result).toEqual({ ok: true });
    const runId = (fx.claimedFiles()[0] as string).replace(/\.json$/, "");
    expect(claimedRequest(runId)).toMatchObject({ agent: "codex", argv: [fx.codexPath] });
  });
});

describe("what is refused before anything is written", () => {
  it.each([
    ["an executable that is not claude or codex", { argv: ["/bin/sh", "-c", "true"] }],
    ["a relative executable", { argv: ["claude"] }],
    ["the permission bypass flag", { argv: ["CLAUDE", "--dangerously-skip-permissions"] }],
    ["an unknown flag", { argv: ["CLAUDE", "--exec=rm"] }],
    [
      "the version flag, which the agent flag allowlist does not carry",
      { argv: ["CLAUDE", "--version"] },
    ],
    ["a shell metacharacter in an argument", { argv: ["CLAUDE", "--model", "a\nb"] }],
    ["a non-CCC environment key", { env: { PATH: "/tmp" } }],
    ["a working directory that is not a directory", { cwd: "/Users/USERNAME/missing" }],
    ["an executable that does not exist", { argv: ["/Users/USERNAME/bin/claude"] }],
    ["an --add-dir outside the project", { argv: ["CLAUDE", "--add-dir", "/"] }],
  ])("%s is spawn-failed and writes nothing", async (_name, overrides) => {
    warmWindow();
    const patched = {
      ...overrides,
      ...("argv" in overrides
        ? { argv: overrides.argv.map((part) => (part === "CLAUDE" ? fx.claudePath : part)) }
        : {}),
    };
    const result = await createAntigravityTerminalLauncher(deps()).launch(
      input(patched as Partial<TerminalLaunchInput>),
    );
    expect(result).toEqual({ ok: false, error: "spawn-failed" });
    expectNothingWritten();
    expect(spawner.calls).toHaveLength(0);
    // Log lines carry reason codes only, never a path or an argument.
    for (const line of logged) {
      expect(line).not.toContain("/");
      expect(line).not.toContain("USERNAME");
    }
  });

  it("an executable that is not the saved launcher row's path is refused (the pin)", async () => {
    warmWindow();
    const other = join(fx.base, "bin", "other", "claude");
    mkdirSync(join(fx.base, "bin", "other"), { recursive: true });
    writeFileSync(other, "#!/bin/sh\n");
    chmodSync(other, 0o755);
    const result = await createAntigravityTerminalLauncher(deps()).launch(input({ argv: [other] }));
    expect(result).toEqual({ ok: false, error: "spawn-failed" });
    expectNothingWritten();
  });

  it("an agent with no saved launcher row is launcher-not-configured", async () => {
    warmWindow();
    const result = await createAntigravityTerminalLauncher(
      deps({ savedExecutables: () => ({ claude: fx.claudePath }) }),
    ).launch(input({ argv: [fx.codexPath] }));
    expect(result).toEqual({ ok: false, error: "launcher-not-configured" });
    expectNothingWritten();
  });
});

describe("typed errors for a missing or outdated bridge", () => {
  it("no launcher file is bridge-not-installed", async () => {
    fx.cleanup();
    fx = createBridgeFixture();
    fx.installMarker();
    const result = await createAntigravityTerminalLauncher(deps()).launch(input());
    expect(result).toEqual({ ok: false, error: "bridge-not-installed" });
    expectNothingWritten();
    expect(spawner.calls).toHaveLength(0);
  });

  it("a covering window of the installed 0.1.0 extension (no protocol field) is bridge-outdated, and nothing is written", async () => {
    const old = fx.simulator("outdated", { now: () => clock.t });
    old.heartbeat();
    sleepHook = () => void old.tick();
    const result = await createAntigravityTerminalLauncher(deps()).launch(input());
    expect(result).toEqual({ ok: false, error: "bridge-outdated" });
    expectNothingWritten();
    expect(spawner.calls).toHaveLength(0);
    // Had the request been written, the old extension would have deleted it unclaimed.
    expect(sleeps).toEqual([]);
  });

  it("an outdated window next to a capable one on the same project is still bridge-outdated", async () => {
    fx.simulator("current", { now: () => clock.t, key: "a-new" }).heartbeat();
    fx.simulator("outdated", { now: () => clock.t, key: "b-old" }).heartbeat();
    const result = await createAntigravityTerminalLauncher(deps()).launch(input());
    expect(result).toEqual({ ok: false, error: "bridge-outdated" });
    expectNothingWritten();
  });

  it("a marker without the agent capability is bridge-outdated, with no window and the app not opened", async () => {
    fx.installMarker({ protocol: 1, capabilities: ["follow", "tui"] });
    const result = await createAntigravityTerminalLauncher(deps()).launch(input());
    expect(result).toEqual({ ok: false, error: "bridge-outdated" });
    expectNothingWritten();
    expect(spawner.calls).toHaveLength(0);
  });

  it("a launcher with neither a marker nor a window is bridge-outdated", async () => {
    fx.cleanup();
    fx = createBridgeFixture();
    fx.installLauncher();
    const result = await createAntigravityTerminalLauncher(deps()).launch(input());
    expect(result).toEqual({ ok: false, error: "bridge-outdated" });
    expectNothingWritten();
    expect(spawner.calls).toHaveLength(0);
  });
});

describe("cold start", () => {
  it("opens the saved IDE bundle on the project once, then waits for the claim and succeeds when the window comes up", async () => {
    let sim: WindowSimulator | null = null;
    sleepHook = () => {
      sim ??= fx.simulator("current", { now: () => clock.t, containDelayMs: 0 });
      sim.tick();
    };
    const result = await createAntigravityTerminalLauncher(deps()).launch(input());
    expect(result).toEqual({ ok: true });
    expect(spawner.calls).toHaveLength(1);
    expect(spawner.calls[0]?.argv).toEqual(openInApp(ANTIGRAVITY_IDE_BUNDLE_ID, fx.projectDir));
    expect(fx.claimedFiles()).toHaveLength(1);
    expect(fx.requestFiles()).toEqual([]);
  });

  it("with Antigravity not running, answers window-not-ready at the adapter deadline, the request withdrawn and the app not asked again", async () => {
    const result = await createAntigravityTerminalLauncher(deps()).launch(input());
    expect(result).toEqual({ ok: false, error: "window-not-ready" });
    expect(clock.t - started).toBe(3500);
    expect(spawner.calls).toHaveLength(1);
    expect(fx.requestFiles()).toEqual([]);
    expect(fx.claimedFiles()).toEqual([]);
    // A window that comes up late finds nothing to claim: no stray tab can open.
    const late = fx.simulator("current", { now: () => clock.t, containDelayMs: 0 });
    expect(late.tick()).toEqual([]);
  });

  it("two launches for the same directory started together open the app once and both wait on the same window", async () => {
    spawner.mode = { kind: "succeed", delayMs: 10 };
    let sim: WindowSimulator | null = null;
    sleepHook = () => {
      sim ??= fx.simulator("current", { now: () => clock.t, containDelayMs: 0 });
      sim.tick();
    };
    const launcher = createAntigravityTerminalLauncher(deps());
    const [claude, codex] = await Promise.all([
      launcher.launch(input()),
      launcher.launch(input({ argv: [fx.codexPath], env: { CCC_RUN_ID: "run-product-9" } })),
    ]);
    expect(claude).toEqual({ ok: true });
    expect(codex).toEqual({ ok: true });
    expect(spawner.calls).toHaveLength(1);
    expect(fx.claimedFiles()).toHaveLength(2);
  });

  it("launches for different directories each open their own window", async () => {
    const second = join(fx.base, "second-project");
    mkdirSync(second);
    spawner.mode = { kind: "succeed", delayMs: 10 };
    const sims: WindowSimulator[] = [];
    sleepHook = () => {
      if (sims.length === 0) {
        sims.push(fx.simulator("current", { now: () => clock.t, key: "w1", containDelayMs: 0 }));
        sims.push(
          fx.simulator("current", {
            now: () => clock.t,
            key: "w2",
            folders: [second],
            containDelayMs: 0,
          }),
        );
      }
      for (const sim of sims) sim.tick();
    };
    const launcher = createAntigravityTerminalLauncher(deps());
    const results = await Promise.all([
      launcher.launch(input()),
      launcher.launch(input({ cwd: second, env: { CCC_RUN_ID: "run-product-8" } })),
    ]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(spawner.calls.map((call) => call.argv[3]).sort()).toEqual(
      [fx.projectDir, second].sort(),
    );
  });

  it("a saved bundle that is not the IDE app, or none, is launcher-not-configured and writes nothing", async () => {
    for (const saved of ["com.google.antigravity", null]) {
      const result = await createAntigravityTerminalLauncher(
        deps({ savedBundleId: () => saved }),
      ).launch(input());
      expect(result).toEqual({ ok: false, error: "launcher-not-configured" });
      expectNothingWritten();
      expect(spawner.calls).toHaveLength(0);
    }
  });

  it("with a window already covering the project the saved bundle is not consulted", async () => {
    const sim = warmWindow();
    sleepHook = () => void sim.tick();
    let consulted = 0;
    const result = await createAntigravityTerminalLauncher(
      deps({
        savedBundleId: () => {
          consulted += 1;
          return null;
        },
      }),
    ).launch(input());
    expect(result).toEqual({ ok: true });
    expect(consulted).toBe(0);
  });

  it("a bundle the system cannot find is app-not-found, and any other open failure is spawn-failed; neither leaves a request", async () => {
    spawner.mode = { kind: "fail", outcome: { exitCode: 1, stderrClass: "bundle-not-found" } };
    await expect(createAntigravityTerminalLauncher(deps()).launch(input())).resolves.toEqual({
      ok: false,
      error: "app-not-found",
    });
    expectNoRequests();
    spawner.mode = { kind: "fail", outcome: { exitCode: 1, stderrClass: "other" } };
    await expect(createAntigravityTerminalLauncher(deps()).launch(input())).resolves.toEqual({
      ok: false,
      error: "spawn-failed",
    });
    expectNoRequests();
    spawner.mode = { kind: "fail", outcome: { exitCode: null, errno: "ENOENT" } };
    await expect(createAntigravityTerminalLauncher(deps()).launch(input())).resolves.toEqual({
      ok: false,
      error: "spawn-failed",
    });
    expectNoRequests();
  });
});

describe("the withdraw race (D-09, T-05.1-14)", () => {
  it("a claim that lands between the final poll and the withdraw is a successful hand-off, and the claimed file stays", async () => {
    const sim = warmWindow();
    const launcher = createAntigravityTerminalLauncher(
      deps({
        withdraw: (dir, runId) => {
          sim.tick();
          return withdrawRequest(dir, runId);
        },
      }),
    );
    await expect(launcher.launch(input())).resolves.toEqual({ ok: true });
    expect(fx.claimedFiles()).toHaveLength(1);
    expect(fx.requestFiles()).toEqual([]);
  });

  it("the opposite ordering is window-not-ready and leaves neither a request nor a claimed file", async () => {
    const sim = warmWindow();
    const launcher = createAntigravityTerminalLauncher(
      deps({
        withdraw: (dir, runId) => {
          const outcome = withdrawRequest(dir, runId);
          expect(sim.tick()).toEqual([]);
          return outcome;
        },
      }),
    );
    await expect(launcher.launch(input())).resolves.toEqual({
      ok: false,
      error: "window-not-ready",
    });
    expect(fx.requestFiles()).toEqual([]);
    expect(fx.claimedFiles()).toEqual([]);
  });
});

describe("the deadline and the abort signal (D-09)", () => {
  it("the adapter deadline is the smaller of 3500 ms and the cap minus 500 ms, so it is below the cap by construction", () => {
    expect(adapterDeadlineMs(4000)).toBe(3500);
    expect(adapterDeadlineMs(10_000)).toBe(3500);
    expect(adapterDeadlineMs(3000)).toBe(2500);
    expect(adapterDeadlineMs(1000)).toBe(500);
    expect(adapterDeadlineMs(300)).toBe(0);
    for (const cap of [400, 1000, 4000, 9000]) expect(adapterDeadlineMs(cap)).toBeLessThan(cap);
  });

  it("a window-not-ready answer arrives on the injected clock at the deadline derived from the cap", async () => {
    warmWindow();
    const result = await createAntigravityTerminalLauncher(deps({ capMs: 2000 })).launch(input());
    expect(result).toEqual({ ok: false, error: "window-not-ready" });
    expect(clock.t - started).toBe(1500);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(100);
  });

  it("an already-aborted signal is a timeout and nothing is written or opened", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await createAntigravityTerminalLauncher(deps()).launch(
      input({ signal: controller.signal }),
    );
    expect(result).toEqual({ ok: false, error: "timeout" });
    expectNothingWritten();
    expect(spawner.calls).toHaveLength(0);
  });

  it("a signal that fires during the wait withdraws the request and is a timeout", async () => {
    warmWindow();
    const controller = new AbortController();
    sleepHook = () => controller.abort();
    const result = await createAntigravityTerminalLauncher(deps()).launch(
      input({ signal: controller.signal }),
    );
    expect(result).toEqual({ ok: false, error: "timeout" });
    expect(fx.requestFiles()).toEqual([]);
    expect(fx.claimedFiles()).toEqual([]);
  });
});

describe("run ids", () => {
  it("a Claude launch then a Codex launch from one minter in the same millisecond get distinct, increasing ids", async () => {
    const sim = warmWindow();
    sleepHook = () => void sim.tick();
    const frozen = createRunIdMinter(() => 1_800_000_000_000);
    const launcher = createAntigravityTerminalLauncher(deps({ mintRunId: frozen }));
    await expect(launcher.launch(input())).resolves.toEqual({ ok: true });
    await expect(
      launcher.launch(input({ argv: [fx.codexPath], env: { CCC_RUN_ID: "run-product-3" } })),
    ).resolves.toEqual({ ok: true });
    const ids = fx.claimedFiles();
    expect(ids).toHaveLength(2);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(2);
  });

  it("a collision with an existing request retries with the next id; an id that always collides is spawn-failed", async () => {
    const sim = warmWindow();
    sleepHook = () => void sim.tick();
    const taken = "20261010T120000000Z";
    const request: AgentBridgeRequest = {
      runId: taken,
      kind: "agent",
      mode: "agent",
      agent: "claude",
      projectRoot: fx.projectDir,
      cwd: fx.projectDir,
      argv: [fx.claudePath],
      env: {},
      sessionId: null,
      liveLog: null,
      pid: null,
      createdAt: new Date(clock.t).toISOString(),
      protocol: 2,
    };
    expect(writeBridgeRequest(fx.stateDir, request)).not.toBeNull();
    const ids = [taken, "20261010T120000001Z"];
    await expect(
      createAntigravityTerminalLauncher(deps({ mintRunId: () => ids.shift() ?? taken })).launch(
        input(),
      ),
    ).resolves.toEqual({ ok: true });
    // The pre-created request is claimed by the same window; the retried one is claimed too.
    expect(fx.claimedFiles()).toEqual(["20261010T120000000Z.json", "20261010T120000001Z.json"]);

    const stuck = await createAntigravityTerminalLauncher(deps({ mintRunId: () => taken })).launch(
      input(),
    );
    expect(stuck).toEqual({ ok: false, error: "spawn-failed" });
  });

  it("the product-to-bridge run id map holds at most 64 entries and evicts the oldest", () => {
    for (let i = 0; i < 70; i += 1) rememberBridgeRun(`run-map-${i}`, `bridge-${i}`);
    expect(bridgeRunIdFor("run-map-0")).toBeNull();
    expect(bridgeRunIdFor("run-map-5")).toBeNull();
    expect(bridgeRunIdFor("run-map-6")).toBe("bridge-6");
    expect(bridgeRunIdFor("run-map-69")).toBe("bridge-69");
    expect(bridgeRunIdFor("never-seen")).toBeNull();
  });
});

describe("source hygiene (boundary rules 8 and 9)", () => {
  it("the adapter starts no shell and signals no process", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "antigravity-terminal.ts"), "utf8");
    // Spelled in pieces so this file does not itself trip the backstop rules it checks.
    const forbidden = [
      ["child", "_process"],
      ["exec", "Sync"],
      ["exec", "("],
      ["shell", ": true"],
      [".kil", "l("],
    ].map((parts) => parts.join(""));
    for (const token of forbidden) expect(source.includes(token)).toBe(false);
  });
});
