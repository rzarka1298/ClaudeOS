import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type LaunchErrorKind,
  type LaunchGuard,
  type LaunchGuardDecision,
  type LaunchGuardInput,
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

const LAUNCH_OK: LaunchResult = { ok: true };
const opened = { status: "opened" } as const;
const errorOf = (error: LaunchErrorKind) => ({ status: "error", error }) as const;

describe("one agent's failure never hides or changes the other's result (CODEX-02, R-10)", () => {
  it("Claude fails with its own kind while Codex opens", async () => {
    saveClaude();
    saveCodex();
    const { terminal } = recordingTerminal((call) =>
      call.agent === "claude" ? { ok: false, error: "automation-denied" } : LAUNCH_OK,
    );
    const g = recordingGuard(() => ({ ok: true, runId: newRunId() }));
    const result = await service({ guard: g.guard, terminalLauncher: terminal }).launchPair({
      projectId,
    });
    expect(result).toEqual({ claude: errorOf("automation-denied"), codex: opened });
    expect(g.settled.map((s) => s.outcome)).toEqual(["failed"]);
    // Codex opened, so the project counts as opened.
    expect(registryChanges).toBe(1);
  });

  it("Codex fails with its own kind while Claude opens", async () => {
    saveClaude();
    saveCodex();
    const { terminal } = recordingTerminal((call) =>
      call.agent === "codex" ? { ok: false, error: "bridge-outdated" } : LAUNCH_OK,
    );
    const g = recordingGuard(() => ({ ok: true, runId: newRunId() }));
    const result = await service({ guard: g.guard, terminalLauncher: terminal }).launchPair({
      projectId,
    });
    expect(result).toEqual({ claude: opened, codex: errorOf("bridge-outdated") });
    expect(g.settled.map((s) => s.outcome)).toEqual(["started"]);
  });

  it("both failing gives two independent errors and touches nothing", async () => {
    saveClaude();
    saveCodex();
    const { terminal } = recordingTerminal((call) =>
      call.agent === "claude"
        ? { ok: false, error: "window-not-ready" }
        : { ok: false, error: "bridge-not-installed" },
    );
    const result = await service({ terminalLauncher: terminal }).launchPair({ projectId });
    expect(result).toEqual({
      claude: errorOf("window-not-ready"),
      codex: errorOf("bridge-not-installed"),
    });
    expect(getProject(store.db, projectId)?.lastOpenedAt).toBeNull();
    expect(registryChanges).toBe(0);
  });

  it.each([
    ["spawn-failed" as const, "timeout"],
    ["timeout" as const, "timeout"],
    ["window-not-ready" as const, "failed"],
  ])(
    "settles the Claude Run for a hand-off that ended %s as %s (stale, never an invented failure)",
    async (error, outcome) => {
      saveClaude();
      saveCodex();
      const { terminal } = recordingTerminal((call) =>
        call.agent === "claude" ? { ok: false, error } : LAUNCH_OK,
      );
      const g = recordingGuard(() => ({ ok: true, runId: newRunId() }));
      await service({ guard: g.guard, terminalLauncher: terminal }).launchPair({ projectId });
      expect(g.settled.map((s) => s.outcome)).toEqual([outcome]);
    },
  );
});

describe("the Codex setup state never touches the Claude half (R-09)", () => {
  async function pairWithCodexRow(setup: () => void) {
    saveClaude();
    setup();
    const { terminal, calls } = recordingTerminal();
    const g = recordingGuard();
    const result = await service({ guard: g.guard, terminalLauncher: terminal }).launchPair({
      projectId,
    });
    return { result, calls, g };
  }

  const cases: Array<[string, () => void]> = [
    ["no saved codex row", () => {}],
    [
      "a row that no longer parses",
      () => saveLauncherConfig(store.db, "codex", { executablePath: "relative/codex", args: [] }),
    ],
    ["a banned flag", () => saveCodex(["--yolo"])],
    ["a second banned flag", () => saveCodex(["--full-auto"])],
    ["a config override flag", () => saveCodex(["-c", "model=x"])],
    ["a bare operand outside the allowlist", () => saveCodex(["exec"])],
    ["an unknown placeholder", () => saveCodex(["{script}"])],
    [
      "a non-executable path",
      () => {
        writeFileSync(codexPath, "#!/bin/sh\n", { mode: 0o644 });
        chmodSync(codexPath, 0o644);
        saveCodex();
      },
    ],
    [
      "a path whose name is not codex",
      () => {
        const other = join(base, "bin", "other");
        makeExecutable(other);
        saveLauncherConfig(store.db, "codex", { executablePath: other, args: [] });
      },
    ],
    [
      "a directory argument outside the project",
      () => saveCodex(["--add-dir", join(base, "outside")]),
    ],
  ];

  it.each(cases)(
    "%s: Codex is setup, Claude opens normally, one terminal call",
    async (_name, setup) => {
      mkdirSync(join(base, "outside"), { recursive: true });
      const { result, calls, g } = await pairWithCodexRow(setup);
      expect(result).toEqual({ claude: opened, codex: { status: "setup" } });
      expect(calls.map((c) => c.agent)).toEqual(["claude"]);
      expect(g.inputs).toHaveLength(1);
    },
  );
});

describe("a missing Claude Code row (no terminal can be chosen)", () => {
  it("fails Claude with launcher-not-configured without asking the guard; Codex errors the same way when its row exists", async () => {
    saveCodex();
    const { terminal, calls } = recordingTerminal();
    const g = recordingGuard();
    const result = await service({ guard: g.guard, terminalLauncher: terminal }).launchPair({
      projectId,
    });
    expect(result).toEqual({
      claude: errorOf("launcher-not-configured"),
      codex: errorOf("launcher-not-configured"),
    });
    expect(g.inputs).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("is setup for Codex when its row is absent too", async () => {
    const { terminal, calls } = recordingTerminal();
    const g = recordingGuard();
    const result = await service({ guard: g.guard, terminalLauncher: terminal }).launchPair({
      projectId,
    });
    expect(result).toEqual({
      claude: errorOf("launcher-not-configured"),
      codex: { status: "setup" },
    });
    expect(g.inputs).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("a stored Claude template that no longer validates fails only Claude; the guard is not asked and Codex opens", async () => {
    saveLauncherConfig(store.db, "claude-code", {
      executablePath: claudePath,
      args: ["--dangerously-skip-permissions"],
      terminal: { kind: "terminal-app" },
    });
    saveCodex();
    const { terminal, calls } = recordingTerminal();
    const g = recordingGuard();
    const result = await service({ guard: g.guard, terminalLauncher: terminal }).launchPair({
      projectId,
    });
    expect(result).toEqual({ claude: errorOf("launcher-not-configured"), codex: opened });
    expect(g.inputs).toEqual([]);
    expect(calls.map((c) => c.agent)).toEqual(["codex"]);
  });
});

describe("the guard speaks for Claude only (OQ-6)", () => {
  it("a conflict is the answer, and nothing is launched, not even Codex", async () => {
    saveClaude();
    saveCodex();
    const conflict = { projectName: "Example", conflicts: [] };
    const { terminal, calls } = recordingTerminal();
    const g = recordingGuard(() => ({ ok: false, conflict }));
    const result = await service({ guard: g.guard, terminalLauncher: terminal }).launchPair({
      projectId,
    });
    expect(result).toEqual({ ok: false, conflict });
    expect(calls).toEqual([]);
    expect(g.inputs).toHaveLength(1);
    expect(logged).toEqual([{ projectId, action: "claude-codex-pair", kind: "conflict" }]);
  });

  it("a guard error kind fails only the Claude half; Codex still launches and the guard is never asked about Codex", async () => {
    saveClaude();
    saveCodex();
    const { terminal, calls } = recordingTerminal();
    const g = recordingGuard(() => ({ ok: false, error: "spawn-failed" }));
    const result = await service({ guard: g.guard, terminalLauncher: terminal }).launchPair({
      projectId,
    });
    expect(result).toEqual({ claude: errorOf("spawn-failed"), codex: opened });
    expect(calls.map((c) => c.agent)).toEqual(["codex"]);
    expect(g.inputs.map((i) => i.action)).toEqual(["claude-code"]);
  });
});

describe("two simultaneous pair requests (dedupe)", () => {
  it("share one execution: one guard call and one launch per agent", async () => {
    saveClaude();
    saveCodex();
    const { terminal, calls } = recordingTerminal();
    const g = recordingGuard();
    const launcher = service({ guard: g.guard, terminalLauncher: terminal });
    const first = launcher.launchPair({ projectId });
    const second = launcher.launchPair({ projectId });
    expect(second).toBe(first);
    await first;
    expect(g.inputs).toHaveLength(1);
    expect(calls.map((c) => c.agent)).toEqual(["claude", "codex"]);
  });

  it("a different choice is a different launch", async () => {
    saveClaude();
    saveCodex();
    const { terminal, calls } = recordingTerminal();
    const g = recordingGuard();
    const launcher = service({ guard: g.guard, terminalLauncher: terminal });
    const first = launcher.launchPair({ projectId });
    const second = launcher.launchPair({ projectId, choice: { kind: "plan" } });
    expect(second).not.toBe(first);
    await Promise.all([first, second]);
    expect(g.inputs).toHaveLength(2);
    expect(calls).toHaveLength(4);
  });

  it("never joins a single Claude Code launch of the same project", async () => {
    saveClaude();
    saveCodex();
    const { terminal } = recordingTerminal();
    const launcher = service({ terminalLauncher: terminal });
    const single = launcher.launch({ projectId, action: "claude-code" });
    const pair = launcher.launchPair({ projectId });
    expect(pair).not.toBe(single);
    await expect(pair).resolves.toEqual({ claude: opened, codex: opened });
    await expect(single).resolves.toEqual({ ok: true });
  });
});

describe("a project that cannot be resolved", () => {
  it("answers both halves with that kind: no guard call, no launch", async () => {
    saveClaude();
    saveCodex();
    const { terminal, calls } = recordingTerminal();
    const g = recordingGuard();
    const lookup: ProjectLookup = { resolve: () => Promise.resolve({ error: "project-moved" }) };
    const result = await service({ guard: g.guard, terminalLauncher: terminal, lookup }).launchPair(
      {
        projectId,
      },
    );
    expect(result).toEqual({ claude: errorOf("project-moved"), codex: errorOf("project-moved") });
    expect(g.inputs).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("a throw inside one half, and what is logged", () => {
  it("a terminal that throws for Codex is spawn-failed for Codex only, and never rejects the pair", async () => {
    saveClaude();
    saveCodex();
    const terminal: TerminalLauncher = {
      launch(input) {
        if (input.argv[0] === codexPath) return Promise.reject(new Error(`boom at ${projectDir}`));
        return Promise.resolve(LAUNCH_OK);
      },
    };
    const result = await service({ terminalLauncher: terminal }).launchPair({ projectId });
    expect(result).toEqual({ claude: opened, codex: errorOf("spawn-failed") });
  });

  it("a terminal that throws for Claude is spawn-failed for Claude only and the Run is settled failed", async () => {
    saveClaude();
    saveCodex();
    const terminal: TerminalLauncher = {
      launch(input) {
        if (input.argv[0] === claudePath) throw new Error(`boom at ${projectDir}`);
        return Promise.resolve(LAUNCH_OK);
      },
    };
    const g = recordingGuard(() => ({ ok: true, runId: newRunId() }));
    const result = await service({ guard: g.guard, terminalLauncher: terminal }).launchPair({
      projectId,
    });
    expect(result).toEqual({ claude: errorOf("spawn-failed"), codex: opened });
    expect(g.settled.map((s) => s.outcome)).toEqual(["failed"]);
  });

  it("log lines carry the action, a kind and the project id only: no path, argv or environment value", async () => {
    saveClaude(["--model", "sonnet"]);
    saveCodex(["-C", "{projectPath}"]);
    const { terminal } = recordingTerminal((call) =>
      call.agent === "codex" ? { ok: false, error: "bridge-outdated" } : LAUNCH_OK,
    );
    const g = recordingGuard(() => ({
      ok: true,
      env: { CCC_RUN_ID: "run-secret-value" },
      runId: newRunId(),
    }));
    await service({ guard: g.guard, terminalLauncher: terminal }).launchPair({ projectId });
    expect(logged).toEqual([
      { projectId, action: "claude-code", kind: "ok" },
      { projectId, action: "codex", kind: "bridge-outdated" },
    ]);
    for (const line of logged)
      expect(Object.keys(line).sort()).toEqual(["action", "kind", "projectId"]);
    const text = JSON.stringify(logged);
    expect(text).not.toContain(base);
    expect(text).not.toContain("sonnet");
    expect(text).not.toContain("run-secret-value");
  });

  it("logs a setup Codex half as info with kind setup", async () => {
    saveClaude();
    const { terminal } = recordingTerminal();
    await service({ terminalLauncher: terminal }).launchPair({ projectId });
    expect(logged).toEqual([
      { projectId, action: "claude-code", kind: "ok" },
      { projectId, action: "codex", kind: "setup" },
    ]);
  });
});
