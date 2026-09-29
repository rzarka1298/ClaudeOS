import type { LaunchErrorKind, LaunchResult, ProjectGitState, TerminalLauncher } from "@ccc/domain";
import type { GitRunner } from "../projects/git-runner.js";
import type { Spawner, SpawnOutcome } from "../projects/spawner.js";

// RED-phase stub (plan 04-09 Task 1): the real harness lands in GREEN.

export const SPIKE_RESULT_FILE = "p4-spike-result.json";
export const SPIKE_LABEL = "com.claude-command-center.p4-spike";

export type ProbeOutcome = "ok" | "eperm" | "eacces" | "enoent" | "other";
export type HandoffOutcome = "ok" | LaunchErrorKind | "threw";
export type GitStateOutcome = ProjectGitState["kind"] | "threw";

export interface SpikeReport {
  readonly spike: "p4-launch";
  readonly version: 1;
  readonly underLaunchd: boolean;
  readonly handoffs: {
    readonly valid: { readonly result: HandoffOutcome; readonly scriptRemoved: boolean };
    readonly missingCwd: { readonly result: HandoffOutcome; readonly scriptRemoved: boolean };
  };
  readonly probes: {
    readonly lstat: ProbeOutcome;
    readonly readdir: ProbeOutcome;
    readonly realpath: ProbeOutcome;
    readonly gitStatus: ProbeOutcome;
    readonly finderReveal: ProbeOutcome;
  };
  readonly gitState: GitStateOutcome;
}

export type Attempt<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

export interface SpikeObservations {
  readonly underLaunchd: boolean;
  readonly handoffValid: Attempt<LaunchResult>;
  readonly handoffMissingCwd: Attempt<LaunchResult>;
  readonly scriptRemovedValid: boolean;
  readonly scriptRemovedMissingCwd: boolean;
  readonly lstat: Attempt<unknown>;
  readonly readdir: Attempt<unknown>;
  readonly realpath: Attempt<unknown>;
  readonly git: Attempt<ProjectGitState>;
  readonly reveal: Attempt<SpawnOutcome>;
}

export interface SpikeFs {
  lstat(path: string): unknown;
  readdir(path: string): unknown;
  realpath(path: string): unknown;
}

export interface LaunchSpikeDeps {
  readonly spawner?: Spawner;
  readonly createTerminalLauncher?: (deps: {
    spawner: Spawner;
    scriptDir: string;
  }) => TerminalLauncher;
  readonly gitRunner?: GitRunner;
  readonly fs?: SpikeFs;
  readonly pollTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly underLaunchd?: boolean;
}

export interface LaunchSpikeOptions {
  readonly resultDir: string;
  readonly spikeProjectPath: string;
  readonly runtimeDir: string;
  readonly homeDir: string;
  readonly deps?: LaunchSpikeDeps;
}

export function buildSpikeReport(_observations: SpikeObservations): SpikeReport {
  return {
    spike: "p4-launch",
    version: 1,
    underLaunchd: false,
    handoffs: {
      valid: { result: "threw", scriptRemoved: false },
      missingCwd: { result: "threw", scriptRemoved: false },
    },
    probes: {
      lstat: "other",
      readdir: "other",
      realpath: "other",
      gitStatus: "other",
      finderReveal: "other",
    },
    gitState: "threw",
  };
}

export async function runLaunchSpike(_options: LaunchSpikeOptions): Promise<SpikeReport> {
  return buildSpikeReport({} as SpikeObservations);
}
