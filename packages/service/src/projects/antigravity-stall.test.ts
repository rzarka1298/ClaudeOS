import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LaunchResult, TerminalLaunchInput } from "@ccc/domain";
import { createRunIdMinter } from "@ccc/launchers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BridgeStateFs,
  coveringWindows,
  nodeBridgeStateFs,
  readBridgeStatus,
} from "../codex/bridge-state.js";
import { type BridgeFixture, createBridgeFixture } from "../test-support/bridge-fixtures.js";
import { createFakeSpawner } from "../test-support/fake-spawner.js";
import {
  ANTIGRAVITY_IDE_BUNDLE_ID,
  type AntigravityTerminalDeps,
  createAntigravityTerminalLauncher,
  defaultAgentChecks,
} from "./antigravity-terminal.js";

/**
 * A stalled mounted volume or a macOS permission prompt makes a filesystem call that never
 * settles. Every call on the Antigravity launch path is asynchronous, so the event loop stays free
 * and the adapter's own deadline (ADR-0024: failure within the cap) still fires with a typed error
 * and nothing written. These tests use real timers and a short injected cap.
 */

const CAP_MS = 600; // adapter deadline 100 ms
const NEVER = new Promise<never>(() => {});

let fx: BridgeFixture;

beforeEach(() => {
  fx = createBridgeFixture();
  fx.installLauncher();
  fx.installMarker();
});

afterEach(() => {
  fx.cleanup();
});

function deps(overrides: Partial<AntigravityTerminalDeps> = {}): AntigravityTerminalDeps {
  return {
    readStatus: () => readBridgeStatus({ env: {}, home: fx.home }),
    windowsCovering: (status, root) => coveringWindows(status, root),
    savedBundleId: () => ANTIGRAVITY_IDE_BUNDLE_ID,
    savedExecutables: () => ({ claude: fx.claudePath, codex: fx.codexPath }),
    spawner: createFakeSpawner(),
    mintRunId: createRunIdMinter(Date.now),
    ...defaultAgentChecks,
    capMs: CAP_MS,
    pollMs: 10,
    ...overrides,
  };
}

function input(): TerminalLaunchInput {
  return {
    cwd: fx.projectDir,
    argv: [fx.claudePath, "--permission-mode", "plan"],
    env: { CCC_RUN_ID: "run-product-1" },
    signal: new AbortController().signal,
  };
}

/** Runs a launch and proves the event loop kept turning while it was stalled. */
async function launchStalled(
  overrides: Partial<AntigravityTerminalDeps>,
): Promise<{ result: LaunchResult; ms: number; loopTicks: number }> {
  let loopTicks = 0;
  const probe = setInterval(() => {
    loopTicks += 1;
    setImmediate(() => {
      loopTicks += 1;
    });
  }, 5);
  const started = Date.now();
  try {
    const result = await createAntigravityTerminalLauncher(deps(overrides)).launch(input());
    return { result, ms: Date.now() - started, loopTicks };
  } finally {
    clearInterval(probe);
  }
}

function expectNothingWritten(): void {
  expect(existsSync(join(fx.stateDir, "agent-pins.json"))).toBe(false);
  expect(fx.requestFiles()).toEqual([]);
  expect(fx.claimedFiles()).toEqual([]);
}

function expectTimedOutPromptly(outcome: { result: LaunchResult; ms: number; loopTicks: number }) {
  expect(outcome.result).toEqual({ ok: false, error: "timeout" });
  expect(outcome.ms).toBeLessThan(CAP_MS);
  expect(outcome.loopTicks).toBeGreaterThan(3);
}

describe("a stalled filesystem never blocks the launch past its deadline", () => {
  it("a stalled executable check ends in a typed timeout and writes nothing", async () => {
    expectTimedOutPromptly(await launchStalled({ isExecutable: () => NEVER }));
    expectNothingWritten();
  });

  it("a stalled project realpath ends in a typed timeout and writes nothing", async () => {
    expectTimedOutPromptly(await launchStalled({ realDir: () => NEVER }));
    expectNothingWritten();
  });

  for (const op of ["readdir", "readFile", "stat", "realpath"] as const) {
    it(`a stalled bridge ${op} ends in a typed timeout and writes nothing`, async () => {
      fx.simulator("current", { folders: [fx.projectDir] }).heartbeat();
      const stalled: BridgeStateFs = { ...nodeBridgeStateFs, [op]: () => NEVER };
      expectTimedOutPromptly(
        await launchStalled({
          readStatus: () => readBridgeStatus({ env: {}, home: fx.home, fs: stalled }),
        }),
      );
      expectNothingWritten();
    });
  }

  it("a stalled window coverage check ends in a typed timeout and writes nothing", async () => {
    fx.simulator("current", { folders: [fx.projectDir] }).heartbeat();
    const stalled: BridgeStateFs = { ...nodeBridgeStateFs, realpath: () => NEVER };
    expectTimedOutPromptly(
      await launchStalled({
        windowsCovering: (status, root) => coveringWindows(status, root, stalled),
      }),
    );
    expectNothingWritten();
  });

  it("a withdraw that stalls after the deadline still answers window-not-ready within the cap", async () => {
    fx.simulator("current", { folders: [fx.projectDir] }).heartbeat(); // never claims
    const outcome = await launchStalled({ withdraw: () => NEVER });
    expect(outcome.result).toEqual({ ok: false, error: "window-not-ready" });
    expect(outcome.ms).toBeLessThan(CAP_MS);
    expect(outcome.loopTicks).toBeGreaterThan(3);
  });

  it("a request written late by a stalled prepare is taken back", async () => {
    fx.simulator("current", { folders: [fx.projectDir] }).heartbeat();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const outcome = await launchStalled({
      readStatus: async () => {
        await gate;
        return readBridgeStatus({ env: {}, home: fx.home });
      },
    });
    expectTimedOutPromptly(outcome);
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expectNothingWritten();
  });
});

describe("the Antigravity launch path imports no synchronous filesystem function", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const files = [
    join(here, "antigravity-terminal.ts"),
    join(here, "../codex/bridge-state.ts"),
    join(here, "../codex/bridge-queue.ts"),
    join(here, "../codex/follow-log.ts"),
  ];
  const forbidden =
    /\b(readFileSync|statSync|lstatSync|realpathSync|readdirSync|existsSync|accessSync|linkSync|renameSync|writeFileSync|mkdirSync|unlinkSync|openSync|copyFileSync|rmSync|appendFileSync)\b/;

  for (const file of files) {
    it(`${file.split("/").slice(-2).join("/")} uses fs/promises only`, () => {
      const code = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
        .join("\n");
      expect(code).not.toMatch(forbidden);
      expect(code).not.toMatch(/from "node:fs"/);
    });
  }

  it("the scanned files exist", () => {
    for (const file of files) expect(readdirSync(dirname(file))).toContain(file.split("/").pop());
  });
});
