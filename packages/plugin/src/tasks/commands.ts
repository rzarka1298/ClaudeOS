import type { HostRegistry } from "../host-registry.js";
import { requestDestination } from "../view/navigation-request.js";

/**
 * The `Create task` palette command (plan 06-18; D-37, the D-26 precedent of
 * `registerSetUpLaunchersCommand`): opens the command center on the Tasks
 * destination with the create form requested.
 *
 * Nothing runs on load; only the owner running the command does. The intent is
 * set first (inside `requestDestination`, which raises the one-shot form
 * request before it names the destination), and the view is revealed last, so
 * whichever Tasks surface renders, an already-open one or the one the reveal
 * creates, consumes both. No default hotkey. The id and name avoid the word
 * "command" and the plugin name (obsidianmd rules).
 */
export const CREATE_TASK_COMMAND_ID = "create-task";
const CREATE_TASK_COMMAND_NAME = "Create task";

export function registerCreateTaskCommand(
  registry: Pick<HostRegistry, "command">,
  reveal: () => void,
): void {
  registry.command({
    id: CREATE_TASK_COMMAND_ID,
    name: CREATE_TASK_COMMAND_NAME,
    callback: () => {
      requestDestination("tasks", { openTaskForm: true });
      reveal();
    },
  });
}
