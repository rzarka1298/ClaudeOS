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
