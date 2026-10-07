import {
  localDayBounds,
  TaskCreateRequestSchema,
  type TaskCreateResponse,
  type TaskErrorCode,
  TaskRowSchema,
  zonedLocalToInstant,
} from "@ccc/domain";
import { getTask, type TaskIndexRow, upsertTask } from "@ccc/operational-store";
import { WorkspaceScopeViolationError, writeTaskNote } from "@ccc/vault-repo";
import { ZodError } from "zod";
import { toIndexRecord } from "./record.js";
import type { TaskResult, TaskServices, TaskServicesDeps } from "./types.js";

/**
 * The task services (plan 06-20; D-28, D-35, D-36, D-37).
 *
 * Tasks are canonical in the vault: this service CREATES new notes through the
 * vault writer (never the editor) and keeps the disposable index in step. It
 * never edits an existing note: the plugin does that, because it holds the
 * editor buffer (D-35). Every failure is a closed code; the log gets a
 * function name and an error class name, never a title, a path or a body.
 */

function fail<T>(code: TaskErrorCode): TaskResult<T> {
  return { ok: false, code };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * The wire row for an index row or detail: only the row's own keys, validated,
 * so a detail's extra keys never reach a list and one odd row cannot leak an
 * unbounded value.
 */
export function toWireRow(row: TaskIndexRow) {
  const {
    id,
    title,
    status,
    priority,
    scope,
    projectId,
    dueDate,
    dueAt,
    scheduledDate,
    scheduledAt,
    completedAt,
    tags,
    tagCount,
    unmetDependencies,
    overdue,
    updatedAt,
  } = row;
  return TaskRowSchema.parse({
    id,
    title,
    status,
    ...(priority === undefined ? {} : { priority }),
    scope,
    ...(projectId === undefined ? {} : { projectId }),
    ...(dueDate === undefined ? {} : { dueDate }),
    ...(dueAt === undefined ? {} : { dueAt }),
    ...(scheduledDate === undefined ? {} : { scheduledDate }),
    ...(scheduledAt === undefined ? {} : { scheduledAt }),
    ...(completedAt === undefined ? {} : { completedAt }),
    tags,
    tagCount,
    unmetDependencies,
    overdue,
    updatedAt,
  });
}

export function createTaskServices(deps: TaskServicesDeps): TaskServices {
  // A generation that only ever increases, even across a restart: seeded from the clock.
  let generation = deps.now().getTime();

  function announce(): number {
    generation += 1;
    try {
      deps.eventBus.publish("tasks.changed", { generation });
    } catch (error: unknown) {
      deps.log.error({ fn: "announce", errorName: errorName(error) }, "task event publish failed");
    }
    return generation;
  }

  function create(input: unknown): TaskResult<TaskCreateResponse> {
    const parsed = TaskCreateRequestSchema.safeParse(input);
    if (!parsed.success) return fail("invalid-body");
    const request = parsed.data;

    const vaultRoot = deps.getVaultRoot();
    if (vaultRoot === null || vaultRoot.length === 0) return fail("vault-not-set-up");

    let due: string | undefined;
    if (request.dueDate !== undefined) {
      if (request.dueTime === undefined) {
        due = request.dueDate;
      } else {
        const instant = zonedLocalToInstant(request.dueDate, request.dueTime, request.zone);
        if (instant === null) return fail("invalid-body");
        due = instant;
      }
    }

    try {
      const now = deps.now();
      const written = writeTaskNote({
        vaultRoot,
        scope: request.scope ?? "global",
        title: request.title,
        ...(request.description === undefined ? {} : { body: request.description }),
        intent: request.intent,
        ...(request.priority === undefined ? {} : { priority: request.priority }),
        ...(due === undefined ? {} : { due }),
        ...(request.scheduledDate === undefined ? {} : { scheduled: request.scheduledDate }),
        ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
        ...(request.tags === undefined ? {} : { tags: request.tags }),
        sourceType: "manual",
        now,
      });
      upsertTask(deps.db, toIndexRecord(written.path, written.frontmatter, written.contentHash));
      const row = getTask(deps.db, written.id, localDayBounds(now, request.zone));
      if (row === null) {
        deps.log.error({ fn: "create", errorName: "MissingIndexRow" }, "task create failed");
        return fail("write-failed");
      }
      announce();
      return { ok: true, value: { task: toWireRow(row) } };
    } catch (error: unknown) {
      if (error instanceof WorkspaceScopeViolationError) return fail("invalid-scope");
      if (error instanceof ZodError) return fail("invalid-body");
      deps.log.error({ fn: "create", errorName: errorName(error) }, "task create failed");
      return fail("write-failed");
    }
  }

  const notYet = <T>(): TaskResult<T> => fail("not-found");
  return {
    create,
    list: () => notYet(),
    counts: () => notYet(),
    get: () => notYet(),
    dueToday: () => notYet(),
    attention: () => notYet(),
  };
}
