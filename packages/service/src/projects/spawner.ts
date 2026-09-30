import { homedir } from "node:os";
import { classifyStderr, type StderrClass } from "@ccc/launchers";
import {
  type CommandRunner,
  createDetachedStarter,
  type DetachedStarter,
  type DetachedStartOutcome,
} from "./command-runner.js";

/**
 * The launch process port (D-18, D-46, Shared Pattern 3): every application
 * launch the service performs — `/usr/bin/open` with a bundle ID, a folder
 * or a rebuilt https URL — goes through a `Spawner`, so tests inject
 * `test-support/fake-spawner.ts` and nothing ever opens on the owner's
 * desktop during a test run. `main.ts` is the only place a real one is
 * constructed.
 *
 * The production spawner is a thin layer over the {@link CommandRunner}
 * (`execFile` with an argv array, never a shell). It adds two rules:
 *
 * - The child's environment is a fixed allowlist built here, never the
 *   service's own inherited environment (threat T-04-19).
 * - stderr is reduced to a {@link StderrClass} inside this module and the
 *   raw text is dropped. `open(1)` stderr contains absolute paths ("The file
 *   /x does not exist.", the bundle ID it could not find), so the text is
 *   never returned, logged or forwarded (Pitfall 7, D-46).
 */

export type { StderrClass };

export interface SpawnOptions {
  /** Hard deadline; the child is killed when it passes. */
  readonly timeoutMs: number;
  /** Aborting kills a still-running child (the launch service's 4 s cap). */
  readonly signal?: AbortSignal;
}

/** A spawn's result with the stderr text already classified away. */
export interface SpawnOutcome {
  /** The exit status, or `null` when the process was killed or never started. */
  readonly exitCode: number | null;
  /** The spawn error code (`ENOENT`, `EACCES`, ...) when the process never started. */
  readonly errno: string | null;
  readonly stderrClass: StderrClass;
  /** The deadline passed and the process was killed. */
  readonly timedOut: boolean;
}

export interface DetachOptions {
  /** How long to watch for a spawn error or an early exit before reporting `running`. */
  readonly graceMs: number;
}

/** A detached start's result; see {@link DetachedStartOutcome}. */
export type DetachOutcome = DetachedStartOutcome;

export interface Spawner {
  /** Runs `argv[0]` with `argv.slice(1)` to completion, under a deadline. Never rejects. */
  run(argv: readonly string[], opts: SpawnOptions): Promise<SpawnOutcome>;
  /**
   * Starts `argv[0]` detached (own process group, no stdio, unref'd) and
   * reports how the grace period ended. There is deliberately no deadline
   * and no abort signal: a terminal binary run directly is never killed by
   * the launch cap (wave-4b review). Same fixed environment as `run`.
   * Never rejects.
   */
  detach(argv: readonly string[], opts: DetachOptions): Promise<DetachOutcome>;
}

/** stderr beyond this is never needed to classify an `open(1)` failure. */
const MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * The whole environment a launched child sees. `open(1)` needs nothing from
 * the service's environment; a fixed PATH, the home directory and the C
 * locale (so stderr is the English text the classifier matches) suffice.
 */
function spawnEnv(): Readonly<Record<string, string>> {
  return { PATH: "/usr/bin:/bin", HOME: homedir(), LC_ALL: "C" };
}

export function createCommandSpawner(
  runner: CommandRunner,
  starter: DetachedStarter = createDetachedStarter(),
): Spawner {
  return {
    detach(argv, opts) {
      const [file, ...args] = argv;
      if (file === undefined) return Promise.resolve({ kind: "not-started", errno: "EINVAL" });
      return starter.start(file, args, { env: spawnEnv(), graceMs: opts.graceMs });
    },
    async run(argv, opts) {
      const [file, ...args] = argv;
      if (file === undefined) {
        return { exitCode: null, errno: "EINVAL", stderrClass: "none", timedOut: false };
      }
      const outcome = await runner.run(file, args, {
        timeoutMs: opts.timeoutMs,
        env: spawnEnv(),
        maxBufferBytes: MAX_OUTPUT_BYTES,
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      });
      // The raw stderr ends here: only its class leaves this function.
      return {
        exitCode: outcome.exitCode,
        errno: outcome.errno,
        stderrClass: classifyStderr(outcome.stderr),
        timedOut: outcome.timedOut,
      };
    },
  };
}
