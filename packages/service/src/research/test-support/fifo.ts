import { execFileSync, spawn } from "node:child_process";

/**
 * FIFO helpers for the "a special file where a note should be" tests (wave 5 fix round, opus M1).
 * Test code only.
 *
 * A reader that blocks on a FIFO blocks the whole process, so a test cannot time itself out. A
 * helper process opens the FIFO for writing after a delay: a reader that waited releases late,
 * and the elapsed time (not a hang) is what fails the test.
 */

/** How long the helper waits before releasing a reader that blocked. */
export const RELEASE_AFTER_SECONDS = 3;
/** A read that takes longer than this waited for the helper. */
export const FIFO_DEADLINE_MS = 1500;

export function makeFifo(path: string): void {
  execFileSync("mkfifo", [path]);
}

/** Starts the delayed writer. Call the returned function to stop it. */
export function releaseLater(fifo: string): () => void {
  const helper = spawn(
    "sh",
    ["-c", `sleep ${RELEASE_AFTER_SECONDS}; printf x > "$1"`, "sh", fifo],
    { stdio: "ignore" },
  );
  return () => {
    helper.kill("SIGKILL");
  };
}

/** Runs `read` with a delayed writer on `fifo`; returns its value and how long it took. */
export function timed<T>(fifo: string, read: () => T): { value: T; elapsedMs: number } {
  const stop = releaseLater(fifo);
  const started = Date.now();
  try {
    const value = read();
    return { value, elapsedMs: Date.now() - started };
  } finally {
    stop();
  }
}

/** The asynchronous form of {@link timed}. */
export async function timedAsync<T>(
  fifo: string,
  read: () => Promise<T>,
): Promise<{ value: T; elapsedMs: number }> {
  const stop = releaseLater(fifo);
  const started = Date.now();
  try {
    const value = await read();
    return { value, elapsedMs: Date.now() - started };
  } finally {
    stop();
  }
}
