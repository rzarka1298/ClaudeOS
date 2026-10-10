import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type LaunchGuard,
  type LaunchGuardDecision,
  type LaunchGuardInput,
  type LaunchResult,
  newRunId,
  type ProjectId,
  type RunId,
  type TerminalLauncher,
  type TerminalLaunchInput,
} from "@ccc/domain";
import {
  applyMigrations,
  getProject,
  insertProject,
  type OperationalStore,
  openStore,
  saveLauncherConfig,
} from "@ccc/operational-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeSpawner } from "../test-support/fake-spawner.js";
import {
  createLaunchService,
  type LaunchLogFields,
  type LaunchServiceDeps,
} from "./launch-service.js";
import { createStoreProjectLookup } from "./project-lookup.js";

/**
 * The pair launch (plan 05.1-20, D-02, D-10, OQ-6, CODEX-01/02/03): one guard decision for the
 * Claude half only, both halves started together through the one terminal port (Claude's call
 * first), one envelope with each agent's own result. Every test injects a recording terminal
 * launcher; no real terminal, Antigravity, `claude` or `codex` is ever started.
 */

let base: string;
let store: OperationalStore;
let projectDir: string;
let projectId: ProjectId;
let claudePath: string;
let codexPath: string;
let logged: LaunchLogFields[];
let refreshCalls: ProjectId[];
let registryChanges: number;

interface TerminalCall {
  readonly agent: "claude" | "codex" | "other";
  readonly input: TerminalLaunchInput;
}

/** A terminal that records every call (in order) and answers per agent. */
function recordingTerminal(
  answer: (call: TerminalCall) => Promise<LaunchResult> | LaunchResult = () => ({ ok: true }),
): { terminal: TerminalLauncher; calls: TerminalCall[] } {
  const calls: TerminalCall[] = [];
  return {
    calls,
    terminal: {
      launch(input) {
        const name = input.argv[0]?.split("/").pop();
        const agent = name === "claude" ? "claude" : name === "codex" ? "codex" : "other";
        const call: TerminalCall = { agent, input };
        calls.push(call);
        return Promise.resolve(answer(call));
      },
    },
  };
}

interface GuardRecorder {
  readonly guard: LaunchGuard;
  readonly inputs: LaunchGuardInput[];
  readonly settled: Array<{ runId: RunId; outcome: string }>;
}

function recordingGuard(decide: () => LaunchGuardDecision = () => ({ ok: true })): GuardRecorder {
  const inputs: LaunchGuardInput[] = [];
  const settled: Array<{ runId: RunId; outcome: string }> = [];
  return {
    inputs,
    settled,
    guard: {
      check(input) {
        inputs.push(input);
        return Promise.resolve(decide());
      },
      settle(runId, outcome) {
        settled.push({ runId, outcome });
        return Promise.resolve();
      },
    },
  };
}

function makeExecutable(path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(path, 0o755);
}

function saveClaude(args: string[] = []): void {
  saveLauncherConfig(store.db, "claude-code", {
    executablePath: claudePath,
    args,
    terminal: { kind: "terminal-app" },
  });
}

function saveCodex(args: string[] = []): void {
  saveLauncherConfig(store.db, "codex", { executablePath: codexPath, args });
}

function service(overrides: Partial<LaunchServiceDeps> = {}) {
  return createLaunchService({
    store,
    spawner: createFakeSpawner(),
    lookup: createStoreProjectLookup(store),
    collector: {
      refresh(id) {
        refreshCalls.push(id);
      },
      onRegistryChanged() {
        registryChanges += 1;
      },
      gitState: () => null,
    },
    logger: {
      info(fields) {
        logged.push(fields);
      },
      warn(fields) {
        logged.push(fields);
      },
    },
    ...overrides,
  });
}

function runCount(): number {
  const row = store.db.prepare("select count(*) as n from runs").get() as { n: number };
  return row.n;
}

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "ccc-pair-launch-")));
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
  logged = [];
  refreshCalls = [];
  registryChanges = 0;
});

afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

describe("the pair launch tracer (guard once, Claude first, both opened)", () => {
  it("asks the guard exactly once for claude-code, starts Claude then Codex, and answers both opened", async () => {
    saveClaude();
    saveCodex();
    const { terminal, calls } = recordingTerminal();
    const g = recordingGuard();
    const result = await service({ guard: g.guard, terminalLauncher: terminal }).launchPair({
      projectId,
    });
    expect(result).toEqual({ claude: { status: "opened" }, codex: { status: "opened" } });
    expect(g.inputs).toEqual([{ projectId, action: "claude-code" }]);
    expect(calls.map((c) => c.agent)).toEqual(["claude", "codex"]);
  });

  it("starts both halves before either is awaited", async () => {
    saveClaude();
    saveCodex();
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const terminal: TerminalLauncher = {
      async launch(input) {
        order.push(`start:${input.argv[0]?.split("/").pop()}`);
        await gate;
        order.push(`end:${input.argv[0]?.split("/").pop()}`);
        return { ok: true };
      },
    };
    const pending = service({ terminalLauncher: terminal }).launchPair({ projectId });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(order).toEqual(["start:claude", "start:codex"]);
    release();
    await expect(pending).resolves.toEqual({
      claude: { status: "opened" },
      codex: { status: "opened" },
    });
  });
});

describe("what each half is handed", () => {
  it("gives Claude the stored template plus the guard's extra arguments, working directory and environment", async () => {
    saveClaude(["--model", "sonnet"]);
    saveCodex();
    const runId = newRunId();
    const { terminal, calls } = recordingTerminal();
    const g = recordingGuard(() => ({
      ok: true,
      cwd: join(projectDir, "worktree"),
      extraArgv: ["--permission-mode", "plan"],
      env: { CCC_RUN_ID: runId, CCC_LAUNCH_SOURCE: "dashboard" },
      runId,
    }));
    await service({ guard: g.guard, terminalLauncher: terminal }).launchPair({ projectId });
    const claude = calls.find((c) => c.agent === "claude");
    expect(claude?.input.cwd).toBe(join(projectDir, "worktree"));
    expect(claude?.input.argv).toEqual([
      claudePath,
      "--model",
      "sonnet",
      "--permission-mode",
      "plan",
    ]);
    expect(claude?.input.env).toEqual({ CCC_RUN_ID: runId, CCC_LAUNCH_SOURCE: "dashboard" });
  });

  it("gives Codex [saved executable, ...saved args] with the project path rendered, the project root and no environment", async () => {
    saveClaude();
    saveCodex(["-C", "{projectPath}"]);
    const runId = newRunId();
    const { terminal, calls } = recordingTerminal();
    const g = recordingGuard(() => ({
      ok: true,
      cwd: join(projectDir, "worktree"),
      env: { CCC_RUN_ID: runId },
      runId,
    }));
    await service({ guard: g.guard, terminalLauncher: terminal }).launchPair({ projectId });
    const codex = calls.find((c) => c.agent === "codex");
    expect(codex?.input.argv).toEqual([codexPath, "-C", projectDir]);
    expect(codex?.input.cwd).toBe(projectDir);
    expect(codex?.input.env).toBeUndefined();
    expect(codex?.input.signal).toBeInstanceOf(AbortSignal);
  });

  it("passes the request's choice to the guard", async () => {
    saveClaude();
    saveCodex();
    const { terminal } = recordingTerminal();
    const g = recordingGuard();
    await service({ guard: g.guard, terminalLauncher: terminal }).launchPair({
      projectId,
      choice: { kind: "plan" },
    });
    expect(g.inputs).toEqual([{ projectId, action: "claude-code", choice: { kind: "plan" } }]);
  });
});

describe("the Claude half's pre-registered Run, and Codex outside the Run model (D-15)", () => {
  it("settles the Run as started exactly once after the Claude hand-off, and Codex creates no Run or row", async () => {
    saveClaude();
    saveCodex();
    const runId = newRunId();
    const { terminal } = recordingTerminal();
    const g = recordingGuard(() => ({ ok: true, runId }));
    await service({ guard: g.guard, terminalLauncher: terminal }).launchPair({ projectId });
    expect(g.settled).toEqual([{ runId, outcome: "started" }]);
    expect(runCount()).toBe(0);
  });
});

describe("after a successful pair launch", () => {
  it("touches last_opened_at once and tells the collector once", async () => {
    saveClaude();
    saveCodex();
    const { terminal } = recordingTerminal();
    await service({ terminalLauncher: terminal }).launchPair({ projectId });
    expect(getProject(store.db, projectId)?.lastOpenedAt).not.toBeNull();
    expect(registryChanges).toBe(1);
    expect(refreshCalls).toEqual([projectId]);
  });
});
