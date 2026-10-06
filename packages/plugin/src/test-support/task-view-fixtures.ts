import type { TaskRow } from "@ccc/domain/tasks.js";

/**
 * Task row fixtures for the Tasks view tests (plan 06-16). Everything is
 * synthetic. Times are fixed against {@link TASK_NOW_MS} in
 * {@link TASK_ZONE}, so a rendered phrase never depends on when or where the
 * test ran: 2026-10-05 10:00 in New York is 14:00 UTC.
 */

/** The frozen "now" the task views take as a prop. */
export const TASK_NOW_MS = Date.parse("2026-10-05T14:00:00.000Z");

/** The owner's zone in every task test. Never the machine's zone. */
export const TASK_ZONE = "America/New_York";

/** A valid task id (nine base-36 characters plus sixteen hex), varied by `n`. */
export function taskId(n: number): string {
  return `0mfk1a2b3${n.toString(16).padStart(16, "0")}`;
}

/** A project id the row schema accepts, varied by `n`. */
export function projectIdFor(n: number): string {
  return `0mfk1a2b4${n.toString(16).padStart(16, "0")}`;
}

/**
 * One task row. Overrides replace keys wholesale, so a test can set a
 * calendar date or an instant without the other leaking in. Not parsed through
 * the row schema: the hostile-title tests need rows the index would never hold.
 */
export function taskRow(n: number, overrides: Record<string, unknown> = {}): TaskRow {
  return {
    id: taskId(n),
    title: `Task ${n}`,
    status: "ready",
    scope: "global",
    tags: [],
    tagCount: 0,
    unmetDependencies: 0,
    overdue: false,
    updatedAt: "2026-10-04T10:00:00.000Z",
    ...overrides,
  } as unknown as TaskRow;
}

/** `count` open rows numbered from 1. */
export function taskRows(count: number, status = "ready"): TaskRow[] {
  return Array.from({ length: count }, (_, index) => taskRow(index + 1, { status }));
}
