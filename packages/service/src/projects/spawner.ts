import { homedir } from "node:os";
import type { CommandRunner } from "./command-runner.js";

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

/** What `classifyStderr` reduces `open(1)` stderr to. Replaced by the `@ccc/launchers` classifier in Task 2. */
export type StderrClass =
  | "none"
  | "bundle-not-found"
  | "path-missing"
  | "automation-denied"
  | "permission-denied"
  | "other";

/** Task 1 placeholder: every stderr is `other`. Replaced (not extended) by the real classifier. */
function classifyStderr(_text: string): StderrClass {
  return "other";
}

export interface SpawnOptions {
  /** Hard deadline; the child is killed when it passes. */
  readonly timeoutMs: number;
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

export interface Spawner {
  /** Runs `argv[0]` with `argv.slice(1)`. Never rejects. */
  run(argv: readonly string[], opts: SpawnOptions): Promise<SpawnOutcome>;
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

export function createCommandSpawner(runner: CommandRunner): Spawner {
  return {
    async run(argv, opts) {
      const [file, ...args] = argv;
      if (file === undefined) {
        return { exitCode: null, errno: "EINVAL", stderrClass: "none", timedOut: false };
      }
      const outcome = await runner.run(file, args, {
        timeoutMs: opts.timeoutMs,
        env: spawnEnv(),
        maxBufferBytes: MAX_OUTPUT_BYTES,
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
