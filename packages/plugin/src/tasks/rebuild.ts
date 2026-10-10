import type { TaskAttentionItem, TaskRebuildResponse } from "@ccc/domain/tasks.js";
import { TaskAttentionResponseSchema } from "@ccc/domain/tasks.js";
import { signal } from "@preact/signals";
import { tasksApi } from "./api.js";
import { globalTasksContext, type TasksContext } from "./contexts.js";

/**
 * Rebuilding the task index and the attention list (plan 06-22; UI-SPEC S3
 * "Notes need attention", S5 Rebuild task index). Both belong to the whole
 * vault, so they are module state of the global Tasks destination, not of a
 * context: a project panel never shows them.
 */

/** True while a rebuild runs; the lists keep their last good rows and say so. */
export const tasksRebuilding = signal(false);

/** The notes the index left out, as loaded so far. */
export const tasksAttention = {
  items: signal<readonly TaskAttentionItem[]>([]),
  total: signal(0),
  nextCursor: signal<string | null>(null),
  /** A closed code from the last failed load; the list keeps its last good entries. */
  error: signal<string | null>(null),
};

let attentionSequence = 0;

/** Loads the first page of the attention list, replacing what was loaded. */
export async function loadAttention(): Promise<void> {
  const mine = ++attentionSequence;
  try {
    const parsed = TaskAttentionResponseSchema.safeParse(await tasksApi().attention({}));
    if (mine !== attentionSequence) return;
    if (!parsed.success) {
      tasksAttention.error.value = "unrecognised-response";
      return;
    }
    tasksAttention.items.value = parsed.data.items;
    tasksAttention.total.value = parsed.data.total;
    tasksAttention.nextCursor.value = parsed.data.nextCursor;
    tasksAttention.error.value = null;
  } catch (cause) {
    if (mine === attentionSequence) {
      tasksAttention.error.value =
        typeof cause === "object" && cause !== null && "code" in cause
          ? String(cause.code)
          : "unrecognised-response";
    }
  }
}

/** Appends the next page of the attention list. */
export async function loadMoreAttention(): Promise<void> {
  const cursor = tasksAttention.nextCursor.peek();
  if (cursor === null) return;
  const mine = ++attentionSequence;
  try {
    const parsed = TaskAttentionResponseSchema.safeParse(await tasksApi().attention({ cursor }));
    if (mine !== attentionSequence || !parsed.success) return;
    const known = new Set(tasksAttention.items.peek().map((item) => item.path));
    tasksAttention.items.value = [
      ...tasksAttention.items.peek(),
      ...parsed.data.items.filter((item) => !known.has(item.path)),
    ];
    tasksAttention.total.value = parsed.data.total;
    tasksAttention.nextCursor.value = parsed.data.nextCursor;
  } catch {
    // The entries already shown stay; the owner can press Show more again.
  }
}

let inFlight: Promise<TaskRebuildResponse> | null = null;

/**
 * Asks the service to rebuild the task index, then reloads the global context
 * and the attention list. A second call while one runs returns the same
 * promise. The flag clears on success and on failure; a failure is rethrown so
 * the caller (the settings action) can say so.
 */
export function rebuildTaskIndex(
  context: TasksContext = globalTasksContext,
): Promise<TaskRebuildResponse> {
  if (inFlight !== null) return inFlight;
  tasksRebuilding.value = true;
  const run = (async () => {
    try {
      const result = await tasksApi().rebuild();
      await Promise.all([context.refresh(), loadAttention()]);
      return result;
    } finally {
      tasksRebuilding.value = false;
      inFlight = null;
    }
  })();
  inFlight = run;
  return run;
}
