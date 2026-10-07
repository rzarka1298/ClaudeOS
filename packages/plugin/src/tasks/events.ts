import type { ServiceEvent } from "@ccc/domain";
import { signal } from "@preact/signals";

/** Skeleton: the implementation follows the RED commit (plan 06-18, Task 2). */
export const tasksGeneration = signal(0);
export function resetTasksGeneration(): void {
  tasksGeneration.value = 0;
}
export function applyTasksChanged(_event: ServiceEvent): void {}
