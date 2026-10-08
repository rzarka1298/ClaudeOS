import type { HostRegistry } from "../host-registry.js";
import { requestDestination } from "../view/navigation-request.js";

/**
 * The `Open approval inbox` palette command (plan 06-23; UI-SPEC S6, D-26): reveals
 * the command center on Agent runs with the Approvals heading to focus and the
 * Pending chip pressed. It selects nothing and acts on nothing.
 *
 * Nothing runs on load; only the owner running the command does. The intent is
 * set first (inside `requestDestination`), the view is revealed last, so a view
 * already open or the one the reveal creates consumes both, and it works before
 * any snapshot has arrived. No default hotkey; the id and name avoid the word
 * "command" and the plugin name (obsidianmd rules).
 */
export const OPEN_APPROVAL_INBOX_COMMAND_ID = "open-approval-inbox";
const OPEN_APPROVAL_INBOX_COMMAND_NAME = "Open approval inbox";

export function registerOpenApprovalInboxCommand(
  registry: Pick<HostRegistry, "command">,
  reveal: () => void,
): void {
  registry.command({
    id: OPEN_APPROVAL_INBOX_COMMAND_ID,
    name: OPEN_APPROVAL_INBOX_COMMAND_NAME,
    callback: () => {
      requestDestination("agent-runs", { focusApprovalsHeading: true });
      reveal();
    },
  });
}
