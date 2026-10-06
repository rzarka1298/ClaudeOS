import type { TaskFilter, TaskRow } from "@ccc/domain/tasks.js";
import type { VNode } from "preact";

/** Skeleton (plan 06-16): renders nothing yet. */
export type TaskRowAction = "mark-done" | "accept" | "dismiss";

export interface TaskListProps {
  readonly filter: TaskFilter;
  readonly rows: readonly TaskRow[];
  readonly total: number;
  readonly selectedId: string | null;
  readonly connected: boolean;
  onSelect(id: string): void;
  onAction(action: TaskRowAction, row: TaskRow): Promise<void>;
}

export function TaskList(_props: TaskListProps): VNode {
  return <div />;
}
