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
 * The service's generation may restart from a low value. This signal is only
 * cleared on unload (not on reconnect), so after a restart `tasks.changed`
 * events at or below the highest generation seen are ignored until the service
 * passes it. The reconnect hook (06-23) re-requests a rescan and refreshes the
 * containers once, which covers the changes made while disconnected, but not
 * those low-generation events.
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
