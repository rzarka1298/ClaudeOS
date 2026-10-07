import type { HostRegistry } from "../host-registry.js";

/** Skeleton: the implementation follows the RED commit (plan 06-18, Task 3). */
export const CREATE_TASK_COMMAND_ID = "create-task";
const CREATE_TASK_COMMAND_NAME = "Create task";

export function registerCreateTaskCommand(
  registry: Pick<HostRegistry, "command">,
  _reveal: () => void,
): void {
  registry.command({
    id: CREATE_TASK_COMMAND_ID,
    name: CREATE_TASK_COMMAND_NAME,
    callback: () => {},
  });
}
