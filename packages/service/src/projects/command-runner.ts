import { type ChildProcess, execFile, spawn } from "node:child_process";

/**
 * The service's process port (D-18, Shared Pattern 3): every child process
 * the projects code starts goes through a `CommandRunner`, so tests replace
 * it with a scripted fake and production wiring happens once, in `main.ts`.
 *
 * The production runner is `execFile` with an argv array — no shell is ever
 * involved, so no value in `args` can be interpreted as shell syntax — plus
 * a hard deadline (`SIGKILL` at `timeoutMs`), an output cap, and an
 * environment the CALLER builds. Nothing is inherited implicitly.
 *
 * `run` never rejects: a non-zero exit, a spawn failure, a timeout and an
 * output overflow all resolve as a {@link CommandOutcome}, so each caller
 * classifies one shape.
 *
 * `stdout` and `stderr` are raw, untrusted text — git output can carry
 * paths, branch names and commit subjects. They are for callers inside
 * `packages/service/src/projects/` to parse or classify; they are never
 * logged and never returned over the API (D-46).
 *
 * Rejected alternative: `execa` (already a `@ccc/keychain` dependency).
 * Using it here would add a dependency edge for nothing `execFile` lacks.
 */

export interface CommandRunOptions {
  /** Hard deadline; the child is killed with SIGKILL when it passes. */
  readonly timeoutMs: number;
  /** The child's whole environment. Callers build it from scratch. */
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
  /** Output cap per stream; defaults to 1 MiB. Past it the child is killed and `truncated` is set. */
  readonly maxBufferBytes?: number;
  /** Aborting kills the child with SIGKILL; the outcome reports errno `ABORT_ERR`. */
  readonly signal?: AbortSignal;
}

export interface CommandOutcome {
  /** The exit status, or `null` when the process was killed or never started. */
  readonly exitCode: number | null;
  /** The spawn error code (`ENOENT`, `EACCES`, ...) when the process never started. */
  readonly errno: string | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Output passed the cap; `stdout` holds what arrived before it. */
  readonly truncated: boolean;
  /** The deadline passed and the process was killed. */
  readonly timedOut: boolean;
}

export interface CommandRunner {
  run(file: string, args: readonly string[], options: CommandRunOptions): Promise<CommandOutcome>;
}

/** 1 MiB: far more than status/log/remote output of a sane repository. */
const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;

const MAX_BUFFER_CODE = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";

interface ExecFileFailure {
  code?: unknown;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
}

export function createExecFileCommandRunner(): CommandRunner {
  return {
    run(file, args, options) {
      return new Promise((resolve) => {
        execFile(
          file,
          [...args],
          {
            env: { ...options.env },
            timeout: options.timeoutMs,
            killSignal: "SIGKILL",
            maxBuffer: options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES,
            windowsHide: true,
            encoding: "utf8",
            ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          },
          (error, stdout, stderr) => {
            if (error === null) {
              resolve({
                exitCode: 0,
                errno: null,
                stdout,
                stderr,
                truncated: false,
                timedOut: false,
              });
              return;
            }
            const failure = error as ExecFileFailure;
            const truncated = failure.code === MAX_BUFFER_CODE;
            const timedOut = !truncated && failure.killed === true && failure.signal === "SIGKILL";
            resolve({
              exitCode: typeof failure.code === "number" ? failure.code : null,
              errno: typeof failure.code === "string" && !truncated ? failure.code : null,
              stdout,
              stderr,
              truncated,
              timedOut,
            });
          },
        );
      });
    },
  };
}

/**
 * How a detached start ended the grace period:
 * - `running`: still running when the grace passed; the child has been
 *   `unref`'d and is never killed by this service;
 * - `exited`: it exited within the grace (`exitCode` is `null` when a signal
 *   ended it);
 * - `not-started`: the spawn itself failed (`ENOENT`, `EACCES`, ...).
 */
export type DetachedStartOutcome =
  | { readonly kind: "running" }
  | { readonly kind: "exited"; readonly exitCode: number | null }
  | { readonly kind: "not-started"; readonly errno: string };

export interface DetachedStartOptions {
  /** The child's whole environment. Callers build it from scratch. */
  readonly env: Readonly<Record<string, string>>;
  /** How long to watch for a spawn error or an early exit before handing off. */
  readonly graceMs: number;
}

/**
 * Starts a process the service hands off and then lets go of: a terminal
 * binary run directly by a custom template (wave-4b review). It gets its own
 * process group (`detached`), no stdio and no deadline, so neither the
 * launch cap nor the service's own exit can kill it. Still no shell: `spawn`
 * with an argv array.
 */
export interface DetachedStarter {
  start(
    file: string,
    args: readonly string[],
    options: DetachedStartOptions,
  ): Promise<DetachedStartOutcome>;
}

function errnoOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "UNKNOWN";
}

export function createDetachedStarter(): DetachedStarter {
  return {
    start(file, args, options) {
      return new Promise((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const settle = (outcome: DetachedStartOutcome): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(outcome);
        };
        let child: ChildProcess;
        try {
          child = spawn(file, [...args], {
            detached: true,
            stdio: "ignore",
            env: { ...options.env },
            windowsHide: true,
          });
        } catch (error: unknown) {
          settle({ kind: "not-started", errno: errnoOf(error) });
          return;
        }
        // Kept for the child's lifetime: a late 'error' must never be unhandled.
        child.on("error", (error) => settle({ kind: "not-started", errno: errnoOf(error) }));
        child.once("exit", (code) => settle({ kind: "exited", exitCode: code }));
        timer = setTimeout(() => {
          child.unref();
          settle({ kind: "running" });
        }, options.graceMs);
      });
    },
  };
}
