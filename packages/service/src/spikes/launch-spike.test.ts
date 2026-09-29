import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaunchResult, ProjectGitState, TerminalLauncher } from "@ccc/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitRunner } from "../projects/git-runner.js";
import type { Spawner, SpawnOutcome } from "../projects/spawner.js";
import { createTerminalAppLauncher } from "../projects/terminal-launchers.js";
import { createFakeSpawner } from "../test-support/fake-spawner.js";
import {
  buildSpikeReport,
  runLaunchSpike,
  SPIKE_RESULT_FILE,
  type SpikeFs,
  type SpikeObservations,
} from "./launch-spike.js";

let root: string;
let resultDir: string;
let runtimeDir: string;
let homeDir: string;
let spikeProject: string;
let events: string[];

function fsError(code: string): Error {
  return Object.assign(new Error(`${code}: operation on /Users/USERNAME/Documents/x`), { code });
}

const OK_OUTCOME: SpawnOutcome = { exitCode: 0, errno: null, stderrClass: "none", timedOut: false };

function recordingFs(fail: Partial<Record<keyof SpikeFs, string>> = {}): SpikeFs {
  const step = (name: keyof SpikeFs) => (path: string) => {
    events.push(`${name}:${path === spikeProject ? "project" : "other"}`);
    const code = fail[name];
    if (code !== undefined) throw fsError(code);
    return undefined;
  };
  return { lstat: step("lstat"), readdir: step("readdir"), realpath: step("realpath") };
}

function recordingGit(state: ProjectGitState | Error = { kind: "not-a-repo" }): GitRunner {
  return {
    readProject(path) {
      events.push(`git:${path === spikeProject ? "project" : "other"}`);
      return state instanceof Error ? Promise.reject(state) : Promise.resolve(state);
    },
  };
}

function recordingTerminal(result: LaunchResult | Error = { ok: true }): TerminalLauncher {
  return {
    launch(input) {
      events.push(
        `handoff:${input.cwd === homeDir ? "home" : "elsewhere"}:${existsSync(input.cwd)}`,
      );
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
  };
}

function recordingSpawner(outcome: SpawnOutcome = OK_OUTCOME): Spawner {
  return {
    run(argv) {
      events.push(`spawn:${argv.slice(0, 2).join(" ")}`);
      return Promise.resolve(outcome);
    },
  };
}

beforeEach(() => {
  events = [];
  root = mkdtempSync(join(tmpdir(), "ccc-launch-spike-"));
  resultDir = join(root, "result");
  runtimeDir = join(root, "spike-runtime");
  homeDir = join(root, "home");
  spikeProject = join(homeDir, "Documents", "ccc-spike-project");
  mkdirSync(resultDir);
  mkdirSync(spikeProject, { recursive: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function observations(overrides: Partial<SpikeObservations> = {}): SpikeObservations {
  return {
    underLaunchd: true,
    handoffValid: { ok: true, value: { ok: true } },
    handoffMissingCwd: { ok: true, value: { ok: true } },
    scriptRemovedValid: true,
    scriptRemovedMissingCwd: true,
    lstat: { ok: true, value: undefined },
    readdir: { ok: true, value: ["a"] },
    realpath: { ok: true, value: "/Users/USERNAME/Documents/ccc-spike-project" },
    git: { ok: true, value: { kind: "not-a-repo" } },
    reveal: { ok: true, value: OK_OUTCOME },
    ...overrides,
  };
}

describe("buildSpikeReport (D-46: enums and booleans only)", () => {
  it("classifies every probe outcome and hand-off result", () => {
    const report = buildSpikeReport(
      observations({
        handoffMissingCwd: { ok: true, value: { ok: false, error: "app-not-found" } },
        scriptRemovedMissingCwd: false,
        lstat: { ok: false, error: fsError("EPERM") },
        readdir: { ok: false, error: fsError("EACCES") },
        realpath: { ok: false, error: fsError("ENOENT") },
        git: { ok: true, value: { kind: "folder-access-denied" } },
        reveal: {
          ok: true,
          value: { ...OK_OUTCOME, exitCode: 1, stderrClass: "permission-denied" },
        },
      }),
    );
    expect(report).toEqual({
      spike: "p4-launch",
      version: 1,
      underLaunchd: true,
      handoffs: {
        valid: { result: "ok", scriptRemoved: true },
        missingCwd: { result: "app-not-found", scriptRemoved: false },
      },
      probes: {
        lstat: "eperm",
        readdir: "eacces",
        realpath: "enoent",
        gitStatus: "eperm",
        finderReveal: "eperm",
      },
      gitState: "folder-access-denied",
    });
  });

  it("an ok read is ok, a repo is ok, and anything unrecognised is other", () => {
    const report = buildSpikeReport(
      observations({
        handoffValid: { ok: false, error: new Error("boom /Users/USERNAME") },
        lstat: { ok: false, error: new Error("no code") },
        git: { ok: false, error: new Error("git read failed at /Users/USERNAME") },
        reveal: { ok: true, value: { ...OK_OUTCOME, exitCode: 1, stderrClass: "path-missing" } },
      }),
    );
    expect(report.handoffs.valid.result).toBe("threw");
    expect(report.probes.lstat).toBe("other");
    expect(report.probes.readdir).toBe("ok");
    expect(report.probes.realpath).toBe("ok");
    expect(report.probes.gitStatus).toBe("other");
    expect(report.gitState).toBe("threw");
    expect(report.probes.finderReveal).toBe("enoent");
    const repo = buildSpikeReport(
      observations({
        git: {
          ok: true,
          value: { kind: "repo", branch: "main", dirty: false, commits: [], remote: null },
        } as unknown as SpikeObservations["git"],
      }),
    );
    expect(repo.probes.gitStatus).toBe("ok");
    expect(repo.gitState).toBe("repo");
  });

  it("the serialised report contains no '/' character, whatever the inputs held", () => {
    const report = buildSpikeReport(
      observations({
        handoffValid: { ok: false, error: new Error("/Users/USERNAME/secret") },
        lstat: { ok: false, error: fsError("EPERM") },
        git: { ok: false, error: new Error("/Users/USERNAME/Documents") },
      }),
    );
    expect(JSON.stringify(report)).not.toContain("/");
  });
});

describe("runLaunchSpike (PR-10 owner spike harness)", () => {
  it("runs two hand-offs then the TCC probes in a fixed order and writes the result file", async () => {
    const report = await runLaunchSpike({
      resultDir,
      spikeProjectPath: spikeProject,
      runtimeDir,
      homeDir,
      deps: {
        spawner: recordingSpawner(),
        createTerminalLauncher: () => recordingTerminal(),
        gitRunner: recordingGit(),
        fs: recordingFs(),
        pollTimeoutMs: 50,
        pollIntervalMs: 10,
        underLaunchd: false,
      },
    });
    expect(events).toEqual([
      "handoff:home:true",
      "handoff:elsewhere:false",
      "lstat:project",
      "readdir:project",
      "realpath:project",
      "git:project",
      "spawn:/usr/bin/open -R",
    ]);
    const written = readFileSync(join(resultDir, SPIKE_RESULT_FILE), "utf8");
    expect(JSON.parse(written)).toEqual(report);
    expect(written).not.toContain("/");
    expect(report.handoffs.valid.result).toBe("ok");
    expect(report.probes).toEqual({
      lstat: "ok",
      readdir: "ok",
      realpath: "ok",
      gitStatus: "other",
      finderReveal: "ok",
    });
    expect(report.gitState).toBe("not-a-repo");
  });

  it("never throws: every probe failure is a recorded outcome", async () => {
    const report = await runLaunchSpike({
      resultDir,
      spikeProjectPath: spikeProject,
      runtimeDir,
      homeDir,
      deps: {
        spawner: {
          run: () => Promise.reject(new Error("spawn exploded at /Users/USERNAME")),
        },
        createTerminalLauncher: () => recordingTerminal(new Error("terminal exploded")),
        gitRunner: recordingGit(new Error("git exploded")),
        fs: recordingFs({ lstat: "EPERM", readdir: "EPERM", realpath: "EPERM" }),
        pollTimeoutMs: 20,
        pollIntervalMs: 5,
        underLaunchd: false,
      },
    });
    expect(report.handoffs).toEqual({
      valid: { result: "threw", scriptRemoved: false },
      missingCwd: { result: "threw", scriptRemoved: false },
    });
    expect(report.probes).toEqual({
      lstat: "eperm",
      readdir: "eperm",
      realpath: "eperm",
      gitStatus: "other",
      finderReveal: "other",
    });
    expect(existsSync(join(resultDir, SPIKE_RESULT_FILE))).toBe(true);
  });

  it("records that both real scripts removed themselves when the hand-off runs them", async () => {
    // Stands in for Terminal: executes the script `open` was handed.
    const executing: Spawner = {
      run(argv) {
        if (argv[1] === "-b") {
          try {
            execFileSync(argv[3] ?? "", [], {
              cwd: root,
              env: { PATH: "/usr/bin:/bin", SHELL: "/usr/bin/true" },
              stdio: "ignore",
            });
          } catch {
            // The missing-cwd script exits 1 after printing its message.
          }
        }
        return Promise.resolve(OK_OUTCOME);
      },
    };
    const report = await runLaunchSpike({
      resultDir,
      spikeProjectPath: spikeProject,
      runtimeDir,
      homeDir,
      deps: {
        spawner: executing,
        gitRunner: recordingGit(),
        fs: recordingFs(),
        pollTimeoutMs: 2000,
        pollIntervalMs: 10,
        underLaunchd: false,
      },
    });
    expect(report.handoffs).toEqual({
      valid: { result: "ok", scriptRemoved: true },
      missingCwd: { result: "ok", scriptRemoved: true },
    });
  });

  it("writes every script under the runtimeDir argument even when CCC_RUNTIME_DIR points elsewhere", async () => {
    const other = mkdtempSync(join(tmpdir(), "ccc-launch-spike-other-"));
    try {
      vi.stubEnv("CCC_RUNTIME_DIR", other);
      const spawner = createFakeSpawner();
      const report = await runLaunchSpike({
        resultDir,
        spikeProjectPath: spikeProject,
        runtimeDir,
        homeDir,
        deps: {
          spawner,
          createTerminalLauncher: (deps) => createTerminalAppLauncher(deps),
          gitRunner: recordingGit(),
          fs: recordingFs(),
          pollTimeoutMs: 20,
          pollIntervalMs: 5,
          underLaunchd: false,
        },
      });
      const scripts = spawner.calls
        .filter((call) => call.argv[1] === "-b")
        .map((call) => call.argv[3] ?? "");
      expect(scripts).toHaveLength(2);
      for (const script of scripts) {
        expect(script.startsWith(`${join(runtimeDir, "launch")}/`)).toBe(true);
      }
      // The fake never ran them, so they are still there and reported as not removed.
      expect(report.handoffs.valid.scriptRemoved).toBe(false);
      expect(readdirSync(other)).toEqual([]);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
