import type { VNode } from "preact";
import type { ConnectionState } from "../connection-state.js";
import type { TasksContext } from "../tasks/contexts.js";
import type { TaskFormOption } from "./task-form.js";
import type { TasksViewState } from "./tasks-view-state.js";

export interface TasksDestinationProps {
  readonly connection: ConnectionState;
  readonly now: number;
  readonly context?: TasksContext | undefined;
  readonly view?: TasksViewState | undefined;
  readonly zone?: string | undefined;
  readonly projects?: readonly TaskFormOption[] | undefined;
  readonly workspaces?: readonly TaskFormOption[] | undefined;
}

export function TasksDestination(_props: TasksDestinationProps): VNode {
  return <div />;
}
