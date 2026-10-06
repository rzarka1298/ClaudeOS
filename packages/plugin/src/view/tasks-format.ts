import type { TaskRow } from "@ccc/domain/tasks.js";

/** Skeleton (plan 06-16): the formatter lands with the implementation commit. */
export interface TaskDatePhrase {
  readonly text: string;
  readonly overdue: boolean;
}

export function formatTaskDatePhrase(
  _row: TaskRow,
  _nowMs: number,
  _zone: string,
): TaskDatePhrase | null {
  return null;
}
