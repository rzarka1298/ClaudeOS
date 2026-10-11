import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type LaunchGuard,
  type LaunchResult,
  newRunId,
  type ProjectId,
  type ProjectLookup,
  type RunId,
  type TerminalLauncher,
  type TerminalLaunchInput,
} from "@ccc/domain";
import {
  applyMigrations,
  insertProject,
  type OperationalStore,
  openStore,
  saveLauncherConfig,
} from "@ccc/operational-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeSpawner } from "../test-support/fake-spawner.js";
import { createLaunchService } from "./launch-service.js";
import { createStoreProjectLookup } from "./project-lookup.js";

/**
 * The pair has ONE cap for the whole action (plan 05.1-20, D-10, CODEX-02): per-half results are
 * kept in slots, so when the cap fires first the halves that finished keep their real result and
 * only the unfinished halves read `timeout`. The cap is shortened through `capMs`.
 */

const CAP_MS = 60;

let base: string;
let store: OperationalStore;
let projectDir: string;
let projectId: ProjectId;
let claudePath: string;
let codexPath: string;

function makeExecutable(path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(path, 0o755);
}

interface Launches {
  readonly terminal: TerminalLauncher;
  readonly inputs: Record<"claude" | "codex", TerminalLaunchInput | undefined>;
}

/** Per-agent behaviour: `hang` never resolves, even when the signal aborts. */
function terminalWith(behaviour: Record<"claude" | "codex", "ok" | "hang">): Launches {
  const inputs: Launches["inputs"] = { claude: undefined, codex: undefined };
  return {
    inputs,
    terminal: {
      launch(input): Promise<LaunchResult> {
        const agent = input.argv[0] === claudePath ? "claude" : "codex";
        inputs[agent] = input;
        return behaviour[agent] === "hang"
          ? new Promise<never>(() => {})
          : Promise.resolve({ ok: true });
      },
    },
  };
}

function guardRecording(): {
  guard: LaunchGuard;
  settled: Array<{ runId: RunId; outcome: string }>;
} {
  const settled: Array<{ runId: RunId; outcome: string }> = [];
  return {
    settled,
    guard: {
      check: () => Promise.resolve({ ok: true, runId: newRunId() }),
      settle(runId, outcome) {
        settled.push({ runId, outcome });
        return Promise.resolve();
      },
    },
  };
}

function service(terminal: TerminalLauncher, guard?: LaunchGuard, lookup?: ProjectLookup) {
  return createLaunchService({
    store,
    spawner: createFakeSpawner(),
    lookup: lookup ?? createStoreProjectLookup(store),
    collector: { refresh() {}, onRegistryChanged() {}, gitState: () => null },
    logger: { info() {}, warn() {} },
    terminalLauncher: terminal,
    capMs: CAP_MS,
    ...(guard === undefined ? {} : { guard }),
  });
}

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "ccc-pair-timing-")));
  store = openStore(join(base, "operational.db"));
  applyMigrations(store.db);
  projectDir = join(base, "example-project");
  mkdirSync(projectDir);
  projectId = insertProject(store.db, { path: projectDir, displayName: "Example" }).record
    .projectId;
  claudePath = join(base, "bin", "claude");
  codexPath = join(base, "bin", "codex");
  makeExecutable(claudePath);
  makeExecutable(codexPath);
  saveLauncherConfig(store.db, "claude-code", {
    executablePath: claudePath,
    args: [],
    terminal: { kind: "terminal-app" },
  });
  saveLauncherConfig(store.db, "codex", { executablePath: codexPath, args: [] });
});

afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

describe("the cap returns partial results", () => {
  it("Codex hangs: { claude: opened, codex: timeout } and the abort reached the Codex launch", async () => {
    const t = terminalWith({ claude: "ok", codex: "hang" });
    const started = performance.now();
    const result = await service(t.terminal).launchPair({ projectId });
    expect(result).toEqual({
      claude: { status: "opened" },
      codex: { status: "error", error: "timeout" },
    });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(t.inputs.codex?.signal.aborted).toBe(true);
  });

  it("Claude hangs: { claude: timeout, codex: opened } and the Run settles timeout (stale), never failed", async () => {
    const t = terminalWith({ claude: "hang", codex: "ok" });
    const g = guardRecording();
    const result = await service(t.terminal, g.guard).launchPair({ projectId });
    expect(result).toEqual({
      claude: { status: "error", error: "timeout" },
      codex: { status: "opened" },
    });
    expect(t.inputs.claude?.signal.aborted).toBe(true);
    expect(g.settled.map((s) => s.outcome)).toEqual(["timeout"]);
  });

  it("both hang: both timeout, both launches were aborted, and the Claude Run settles timeout", async () => {
    const t = terminalWith({ claude: "hang", codex: "hang" });
    const g = guardRecording();
    const result = await service(t.terminal, g.guard).launchPair({ projectId });
    expect(result).toEqual({
      claude: { status: "error", error: "timeout" },
      codex: { status: "error", error: "timeout" },
    });
    expect(t.inputs.claude?.signal.aborted).toBe(true);
    expect(t.inputs.codex?.signal.aborted).toBe(true);
    expect(g.settled.map((s) => s.outcome)).toEqual(["timeout"]);
  });

  it("settles the Run once even when a hung hand-off finishes after the cap", async () => {
    let finishClaude: (result: LaunchResult) => void = () => {};
    const terminal: TerminalLauncher = {
      launch(input) {
        if (input.argv[0] === claudePath) {
          return new Promise<LaunchResult>((resolve) => {
            finishClaude = resolve;
          });
        }
        return Promise.resolve({ ok: true });
      },
    };
    const g = guardRecording();
    await service(terminal, g.guard).launchPair({ projectId });
    finishClaude({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(g.settled.map((s) => s.outcome)).toEqual(["timeout"]);
  });

  it("a lookup that never answers is cut off by the cap: both halves timeout, nothing launched", async () => {
    const t = terminalWith({ claude: "ok", codex: "ok" });
    const lookup: ProjectLookup = { resolve: () => new Promise<never>(() => {}) };
    const result = await service(t.terminal, undefined, lookup).launchPair({ projectId });
    expect(result).toEqual({
      claude: { status: "error", error: "timeout" },
      codex: { status: "error", error: "timeout" },
    });
    expect(t.inputs).toEqual({ claude: undefined, codex: undefined });
  });

  it("a guard that answers after the cap launches nothing and the Run it registered is settled failed", async () => {
    const t = terminalWith({ claude: "ok", codex: "ok" });
    const settled: string[] = [];
    const guard: LaunchGuard = {
      check: () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ ok: true, runId: newRunId() }), CAP_MS * 2);
        }),
      settle(_runId, outcome) {
        settled.push(outcome);
        return Promise.resolve();
      },
    };
    const result = await service(t.terminal, guard).launchPair({ projectId });
    expect(result).toEqual({
      claude: { status: "error", error: "timeout" },
      codex: { status: "error", error: "timeout" },
    });
    await new Promise((resolve) => setTimeout(resolve, CAP_MS * 3));
    expect(settled).toEqual(["failed"]);
    expect(t.inputs).toEqual({ claude: undefined, codex: undefined });
  });
});
