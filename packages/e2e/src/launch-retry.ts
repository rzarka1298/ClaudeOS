/**
 * One bounded relaunch for an Obsidian window that closed under the driver before a spec's first
 * test (live runs 6 to 9: "invalid session id: session deleted as the browser has closed the
 * connection"). Only that error is retried, only once per session, and every retry is recorded as
 * a run-problem warning; any other failure, or a second death, propagates unchanged.
 */

const LAUNCH_DEATH = /session deleted as the browser has closed the connection/i;

export function isLaunchDeath(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return LAUNCH_DEATH.test(text);
}

export interface LaunchRetryPorts {
  /** A cheap round trip to the renderer; throws when the session is gone. */
  probe: () => Promise<unknown>;
  /** Starts a fresh Obsidian session for the same spec. */
  relaunch: () => Promise<void>;
  /** Records the warning (console and the kept wdio folder). */
  warn: (message: string) => void;
}

/** Returns true when a relaunch happened. */
export async function ensureLaunched(ports: LaunchRetryPorts): Promise<boolean> {
  try {
    await ports.probe();
    return false;
  } catch (error) {
    if (!isLaunchDeath(error)) throw error;
    ports.warn(
      "run-problem warning: the Obsidian window closed before the first test; relaunching once",
    );
  }
  await ports.relaunch();
  await ports.probe();
  return true;
}

const SESSION_DEATH =
  /invalid session id|session deleted as the browser has closed the connection/i;

export function isSessionDeath(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return SESSION_DEATH.test(text);
}

/**
 * Runs a self-contained test body; if the window closed under the driver, relaunches once and runs
 * the body again. Only for a body that starts from a clean slate (it clears what it needs), so the
 * second run proves the same thing the first would have. Any other failure, or a second death,
 * propagates, and every retry is warned about.
 */
export async function retryOnSessionDeath<T>(
  body: () => Promise<T>,
  relaunch: () => Promise<void>,
  warn: (message: string) => void,
): Promise<T> {
  try {
    return await body();
  } catch (error) {
    if (!isSessionDeath(error)) throw error;
    warn("run-problem warning: the Obsidian window closed during the test; relaunching once");
  }
  await relaunch();
  return await body();
}
