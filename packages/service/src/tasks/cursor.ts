import type { TaskFilter } from "@ccc/domain";
import type { TaskCursor } from "@ccc/operational-store";

/** Skeleton (plan 06-20 Task 2, RED). */
export function encodeTaskCursor(_cursor: TaskCursor): string {
  return "";
}

/** Skeleton: every cursor is invalid. */
export function decodeTaskCursor(_text: string, _filter: TaskFilter): TaskCursor | null {
  return null;
}

export function encodeOffsetCursor(_offset: number): string {
  return "";
}

export function decodeOffsetCursor(_text: string): number | null {
  return null;
}
