import type { HostRegistry } from "../host-registry.js";
import { requestLaunchersFocus } from "../view/launchers-focus.js";
import { requestDestination } from "../view/navigation-request.js";

/**
 * The `Set up launchers` command (D-30, D-38, S11): reruns onboarding at any
 * time by opening the command center on Settings › Launchers with focus on
 * the Launchers heading — the same place the S10 callout's button goes.
 *
 * No modal and nothing on load (D-30): registering runs nothing; only the
 * owner running the command does. No default hotkey (D-33). The name avoids
 * the word "command" (RR-22). `lifecycle.test.ts` calls THIS function.
 */
export const SET_UP_LAUNCHERS_COMMAND_ID = "set-up-launchers";
const SET_UP_LAUNCHERS_COMMAND_NAME = "Set up launchers";

export function registerSetUpLaunchersCommand(registry: HostRegistry, reveal: () => void): void {
  registry.command({
    id: SET_UP_LAUNCHERS_COMMAND_ID,
    name: SET_UP_LAUNCHERS_COMMAND_NAME,
    callback: () => {
      // Focus first, then the destination: whichever renders Settings —
      // a view already open or one the reveal below creates — consumes both.
      requestLaunchersFocus();
      requestDestination("settings");
      reveal();
    },
  });
}
