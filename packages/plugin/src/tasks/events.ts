import type { ServiceEvent } from "@ccc/domain";
import { TasksChangedPayloadSchema } from "@ccc/domain/tasks.js";
import { signal } from "@preact/signals";

/**
 * The one place `tasks.changed` events land (plan 06-18, D-28, research Pattern
 * 13). The payload is a generation that only ever increases; it carries no row
 * and no path, so the signal means "ask again". Containers react to
 * {@link tasksGeneration} by refreshing their context. A payload that fails its
 * schema, an equal or lower generation (a replay) and any other event type are
 * ignored, so a replayed or hostile event can neither move the signal back nor
 * force a refetch loop.
 *
 * The generation resets when the service restarts; the wiring refreshes every
 * container on reconnect (06-23), so a restart never leaves a list stale.
 */
export const tasksGeneration = signal(0);

/** Clears the generation (tests, and a disposed plugin). */
export function resetTasksGeneration(): void {
  tasksGeneration.value = 0;
}

/** Applies a `tasks.changed` event; anything else, or a malformed or stale payload, is ignored. */
export function applyTasksChanged(event: ServiceEvent): void {
  if (event.type !== "tasks.changed") return;
  const parsed = TasksChangedPayloadSchema.safeParse(event.payload);
  if (!parsed.success) return;
  if (parsed.data.generation > tasksGeneration.peek()) {
    tasksGeneration.value = parsed.data.generation;
  }
}
