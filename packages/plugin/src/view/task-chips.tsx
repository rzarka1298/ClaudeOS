import type { TaskFilter } from "@ccc/domain/tasks.js";
import type { VNode } from "preact";

/** Skeleton (plan 06-16): renders nothing yet. */
export interface TaskChipsProps {
  readonly active: TaskFilter;
  readonly counts: Readonly<Partial<Record<TaskFilter, number>>> | null;
  readonly filters?: readonly TaskFilter[] | undefined;
  readonly onSelect: (filter: TaskFilter) => void;
}

export function TaskChips(_props: TaskChipsProps): VNode {
  return <div />;
}
