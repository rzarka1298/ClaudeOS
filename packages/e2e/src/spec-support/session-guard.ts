/**
 * A guard against a closed Obsidian (FIX8). When the browser session dies in the middle of a file,
 * every later case used to fail on its own with the driver's raw "invalid session id" and a stack
 * trace, which buried the one case that was running when Obsidian closed. The guard names that case
 * once, and every later case in the file stops at once with that message instead.
 */
import { isSessionLostError } from "../driver.js";

/** The slice of Mocha's hooks the guard needs; the specs pass `beforeEach` and `afterEach`. */
export interface SessionGuardHooks {
  readonly beforeEach: (hook: () => Promise<void>) => void;
  readonly afterEach: (hook: (this: { currentTest?: GuardTest }) => void) => void;
}

/** The part of Mocha's test object the guard reads. */
export interface GuardTest {
  readonly title?: string;
  readonly err?: unknown;
}

/** The message every later case reports once the session is gone. */
export function sessionLostMessage(title: string | undefined): string {
  const during = title === undefined ? "an earlier case" : `"${title}"`;
  return `Obsidian closed during ${during}; its browser session is gone, so the remaining cases in this file are not run. Look at the kept Obsidian and chromedriver logs for why it closed.`;
}

/**
 * Installs the guard. `probe` is any cheap call that needs the live session (the specs pass a
 * trivial `browser.execute`); it runs before each case so a dead session is reported before the
 * case starts waiting on anything.
 */
export function installSessionGuard(hooks: SessionGuardHooks, probe: () => Promise<unknown>): void {
  let lost: string | null = null;
  hooks.beforeEach(async () => {
    if (lost !== null) throw new Error(lost);
    try {
      await probe();
    } catch (error) {
      if (!isSessionLostError(error)) throw error;
      lost = sessionLostMessage(undefined);
      throw new Error(lost);
    }
  });
  hooks.afterEach(function afterCase() {
    const test = this.currentTest;
    if (lost === null && test !== undefined && isSessionLostError(test.err)) {
      lost = sessionLostMessage(test.title);
    }
  });
}
