import type { HostRegistry } from "../host-registry.js";
import type { ApprovalsApi } from "./api.js";

/**
 * Connects the approval modules to Obsidian and the service (plan 06-23).
 * Every registration goes through the host registry, and nothing here imports
 * a function that decides or approves a request (APPR-01, APPR-09): the only
 * proposal-creating call reachable from this file is the test route.
 */

/** The delay between pressing Send a test approval and the request being made (R-22). */
export const TEST_APPROVAL_DELAY_MS = 5_000;

export const TEST_APPROVAL_STARTED_NOTICE =
  "The test request arrives in 5 seconds. Switch to another app to see the notification.";
export const TEST_APPROVAL_FAILED_NOTICE =
  "Couldn't send the test request. Check the service in Settings → Diagnostics, then try again.";

export interface TestApprovalAction {
  /** Starts a test request, or does nothing while one is already waiting out its delay. */
  press(): void;
}

/**
 * The Send a test approval action (D-20, UI-SPEC S5). The start Notice shows at
 * once; the call itself is made after five seconds through a registry timer
 * slot, so unloading the plugin cancels it. A second press within the delay is
 * ignored; once the timer has fired the action can be used again.
 */
export function createTestApprovalAction(
  registry: Pick<HostRegistry, "timer">,
  api: Pick<ApprovalsApi, "test">,
  notice: (message: string) => void,
): TestApprovalAction {
  const slot = registry.timer();
  let waiting = false;
  return {
    press() {
      if (waiting) return;
      waiting = true;
      notice(TEST_APPROVAL_STARTED_NOTICE);
      slot.schedule(() => {
        waiting = false;
        api.test().then(
          () => undefined,
          () => {
            notice(TEST_APPROVAL_FAILED_NOTICE);
          },
        );
      }, TEST_APPROVAL_DELAY_MS);
    },
  };
}
