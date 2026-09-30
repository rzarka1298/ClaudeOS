/**
 * The PR-10 blocking owner spike (plan 04-09 Task 2) — owner-run tooling.
 * The service never imports this module; `scripts/spikes/p4-launch-spike.sh`
 * runs its compiled JS once, as a temporary launchd job.
 *
 * It exercises the product's OWN code — `ensureScriptDir`,
 * `createTerminalAppLauncher`, `createCommandSpawner`, `resolveGit` /
 * `createGitRunner` and `revealInFinder` — to settle the load-bearing launch
 * assumptions on the real Mac before anything builds on them:
 *
 * - A1: a node-written 0700 `.command` handed to Terminal by
 *   `open -b com.apple.Terminal` opens with no Gatekeeper and no Automation
 *   prompt (hand-off 1 prints a fixed line in a new window);
 * - A11: a script whose folder does not exist leaves the fixed cd-failure
 *   message readable in its window (hand-off 2);
 * - A2: both scripts deleted themselves via `$0` (polled for up to 20 s);
 * - A3, A6: what a launchd-run node gets from `lstat`, `readdir`,
 *   `realpath`, a git status read and a Finder reveal on a synthetic folder
 *   in `~/Documents` — `ok` or `eperm`, and whether macOS prompts at all.
 *
 * Why launchd: macOS TCC attributes a protected-folder access to the
 * "responsible process". Run from a Terminal window, node inherits
 * Terminal's grants and the probe would measure Terminal; run as a
 * LaunchAgent job — exactly how the installed service runs — node is its
 * own responsible process, so the outcome is the service's (RESEARCH E-1).
 *
 * The runtime directory ALWAYS comes from the `runtimeDir` argument (the
 * shell script's spike-only directory), never from the environment, so the
 * spike cannot write into the owner's installed service directory. The
 * result file holds enums and booleans only — no path, no error text (D-46).
 */
import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { LaunchErrorKind, LaunchResult, ProjectGitState, TerminalLauncher } from "@ccc/domain";
import { revealInFinder, TERMINAL_BUNDLE_ID } from "@ccc/launchers";
import { createExecFileCommandRunner } from "../projects/command-runner.js";
import { createGitRunner, type GitRunner, resolveGit } from "../projects/git-runner.js";
import { ensureScriptDir, sweepStaleScripts } from "../projects/script-dir.js";
import { createCommandSpawner, type Spawner, type SpawnOutcome } from "../projects/spawner.js";
import { createTerminalAppLauncher } from "../projects/terminal-launchers.js";

export const SPIKE_RESULT_FILE = "p4-spike-result.json";
/** The temporary launchd job's label; the harness reports whether it runs under it. */
export const SPIKE_LABEL = "com.claude-command-center.p4-spike";
/** What hand-off 1's window prints (A1). */
export const SPIKE_MESSAGE =
  "Claude command center spike: the Terminal hand-off works. You can close this window.";

const HANDOFF_CAP_MS = 4000;
const REVEAL_CAP_MS = 4000;
const DEFAULT_POLL_TIMEOUT_MS = 20_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

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

/** A probe's raw result: its value, or whatever it threw. */
export type Attempt<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

/** Everything the harness observed, before it is reduced to enums. */
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

/** The three filesystem probes; tests replace them. */
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
  /** Where `p4-spike-result.json` is written. */
  readonly resultDir: string;
  /** The synthetic `~/Documents/ccc-spike-project` repository. */
  readonly spikeProjectPath: string;
  /** The spike-only runtime directory; the script directory is created inside it. */
  readonly runtimeDir: string;
  /** Hand-off 1's working directory. */
  readonly homeDir: string;
  readonly deps?: LaunchSpikeDeps;
}

const REAL_FS: SpikeFs = {
  lstat: (path) => lstatSync(path),
  readdir: (path) => readdirSync(path),
  realpath: (path) => realpathSync.native(path),
};

function errorCode(err: unknown): ProbeOutcome {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "EPERM") return "eperm";
  if (code === "EACCES") return "eacces";
  if (code === "ENOENT") return "enoent";
  return "other";
}

function fsOutcome(attempt: Attempt<unknown>): ProbeOutcome {
  return attempt.ok ? "ok" : errorCode(attempt.error);
}

function handoffOutcome(attempt: Attempt<LaunchResult>): HandoffOutcome {
  if (!attempt.ok) return "threw";
  return attempt.value.ok ? "ok" : attempt.value.error;
}

function gitOutcome(attempt: Attempt<ProjectGitState>): ProbeOutcome {
  if (!attempt.ok) return "other";
  switch (attempt.value.kind) {
    case "repo":
      return "ok";
    case "folder-access-denied":
      return "eperm";
    case "folder-missing":
      return "enoent";
    default:
      return "other";
  }
}

function revealOutcome(attempt: Attempt<SpawnOutcome>): ProbeOutcome {
  if (!attempt.ok) return "other";
  const outcome = attempt.value;
  if (outcome.exitCode === 0) return "ok";
  if (outcome.stderrClass === "permission-denied") return "eperm";
  if (outcome.stderrClass === "path-missing") return "enoent";
  return "other";
}

/** Reduces the observations to enums and booleans: nothing a probe returned or threw survives as text. */
export function buildSpikeReport(observations: SpikeObservations): SpikeReport {
  return {
    spike: "p4-launch",
    version: 1,
    underLaunchd: observations.underLaunchd,
    handoffs: {
      valid: {
        result: handoffOutcome(observations.handoffValid),
        scriptRemoved: observations.scriptRemovedValid,
      },
      missingCwd: {
        result: handoffOutcome(observations.handoffMissingCwd),
        scriptRemoved: observations.scriptRemovedMissingCwd,
      },
    },
    probes: {
      lstat: fsOutcome(observations.lstat),
      readdir: fsOutcome(observations.readdir),
      realpath: fsOutcome(observations.realpath),
      gitStatus: gitOutcome(observations.git),
      finderReveal: revealOutcome(observations.reveal),
    },
    gitState: observations.git.ok ? observations.git.value.kind : "threw",
  };
}

async function attempt<T>(run: () => T | Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error: unknown) {
    return { ok: false, error };
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Wraps the spawner the Terminal adapter uses, recording the script path of
 * every `open -b com.apple.Terminal <script>` hand-off, so the harness can
 * watch those exact files disappear (A2).
 */
function recordHandoffs(inner: Spawner, scripts: string[]): Spawner {
  return {
    run(argv, opts) {
      if (argv[1] === "-b" && argv[2] === TERMINAL_BUNDLE_ID && argv[3] !== undefined) {
        scripts.push(argv[3]);
      }
      return inner.run(argv, opts);
    },
    detach(argv, opts) {
      return inner.detach(argv, opts);
    },
  };
}

/**
 * Runs the spike and writes `p4-spike-result.json` into `resultDir`. Never
 * throws: every failure is a recorded outcome.
 */
export async function runLaunchSpike(options: LaunchSpikeOptions): Promise<SpikeReport> {
  const deps = options.deps ?? {};
  const fs = deps.fs ?? REAL_FS;
  const pollTimeoutMs = deps.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const underLaunchd = deps.underLaunchd ?? process.env.XPC_SERVICE_NAME === SPIKE_LABEL;

  const runner = createExecFileCommandRunner();
  const spawner = deps.spawner ?? createCommandSpawner(runner);
  const scripts: string[] = [];
  const handoffSpawner = recordHandoffs(spawner, scripts);
  const makeTerminal = deps.createTerminalLauncher ?? createTerminalAppLauncher;

  // Hand-offs 1 and 2 (A1, A11), through the real script directory.
  const terminal = await attempt(() => {
    const scriptDir = ensureScriptDir(options.runtimeDir);
    sweepStaleScripts(scriptDir, { all: true });
    return makeTerminal({ spawner: handoffSpawner, scriptDir });
  });
  const handoff = (cwd: string, argv: readonly string[]): Promise<Attempt<LaunchResult>> =>
    terminal.ok
      ? attempt(() =>
          terminal.value.launch({ cwd, argv, signal: AbortSignal.timeout(HANDOFF_CAP_MS) }),
        )
      : Promise.resolve({ ok: false, error: terminal.error });

  const handoffValid = await handoff(options.homeDir, ["/bin/echo", SPIKE_MESSAGE]);
  const scriptValid = scripts[0];
  const missingCwd = join(options.runtimeDir, `missing-${randomBytes(8).toString("hex")}`);
  const handoffMissingCwd = await handoff(missingCwd, ["/bin/echo", SPIKE_MESSAGE]);
  const scriptMissingCwd = scripts[1];

  // A2: wait for both scripts to delete themselves.
  const removed = (script: string | undefined): boolean =>
    script !== undefined && !existsSync(script);
  const deadline = Date.now() + pollTimeoutMs;
  while (
    !(removed(scriptValid) && removed(scriptMissingCwd)) &&
    Date.now() < deadline &&
    scriptValid !== undefined
  ) {
    await sleep(pollIntervalMs);
  }

  // A3, A6: the TCC probes, in a fixed order.
  const project = options.spikeProjectPath;
  const lstat = await attempt(() => fs.lstat(project));
  const readdir = await attempt(() => fs.readdir(project));
  const realpath = await attempt(() => fs.realpath(project));
  const git = await attempt(async () => {
    const gitRunner =
      deps.gitRunner ??
      createGitRunner({ runner, git: await resolveGit(runner), homeDir: options.homeDir });
    return gitRunner.readProject(project);
  });
  const reveal = await attempt(() =>
    spawner.run(revealInFinder(project), { timeoutMs: REVEAL_CAP_MS }),
  );

  const report = buildSpikeReport({
    underLaunchd,
    handoffValid,
    handoffMissingCwd,
    scriptRemovedValid: removed(scriptValid),
    scriptRemovedMissingCwd: removed(scriptMissingCwd),
    lstat,
    readdir,
    realpath,
    git,
    reveal,
  });
  await attempt(() => {
    const target = join(options.resultDir, SPIKE_RESULT_FILE);
    const temporary = `${target}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, target);
  });
  return report;
}

/** `node launch-spike.js <result dir> <spike project path> <spike runtime dir>`. */
function isMainModule(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync.native(invoked)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const [resultDir, spikeProjectPath, runtimeDir] = process.argv.slice(2);
  if (
    resultDir === undefined ||
    spikeProjectPath === undefined ||
    runtimeDir === undefined ||
    ![resultDir, spikeProjectPath, runtimeDir].every((arg) => isAbsolute(arg))
  ) {
    process.stderr.write(
      "usage: launch-spike.js <result dir> <spike project path> <spike runtime dir> (absolute paths)\n",
    );
    process.exit(2);
  }
  void runLaunchSpike({ resultDir, spikeProjectPath, runtimeDir, homeDir: homedir() }).then(
    () => process.exit(0),
    () => process.exit(1),
  );
}
