import {
  isValidZone,
  type LocalDayBounds,
  localDayBounds,
  resolvedZone,
  TASK_PAGE_SIZE,
  type TaskAttentionItem,
  type TaskAttentionResponse,
  TaskAttentionResponseSchema,
  type TaskContext,
  type TaskCountsResponse,
  TaskCountsResponseSchema,
  TaskCreateRequestSchema,
  type TaskCreateResponse,
  type TaskDueTodayResponse,
  TaskDueTodayResponseSchema,
  type TaskErrorCode,
  type TaskGetResponse,
  TaskGetResponseSchema,
  type TaskListResponse,
  TaskListResponseSchema,
  type TaskRow,
  TaskRowSchema,
  TaskScopeSchema,
  zonedLocalToInstant,
} from "@ccc/domain";
import {
  blockedBy,
  countTasks,
  getTask,
  InvalidTaskCursorError,
  InvalidTaskQueryError,
  listDueToday,
  queryTasks,
  type TaskCursor,
  type TaskIndexRow,
  upsertTask,
} from "@ccc/operational-store";
import {
  type TaskAttention,
  WorkspaceScopeViolationError,
  type WriteTaskNoteOptions,
  writeTaskNote,
} from "@ccc/vault-repo";
import { ZodError } from "zod";
import { applyChanged, type ChangedDeps } from "./changed.js";
import {
  decodeOffsetCursor,
  decodeTaskCursor,
  encodeOffsetCursor,
  encodeTaskCursor,
} from "./cursor.js";
import { toIndexRecord } from "./record.js";
import { createReindexer } from "./reindex.js";
import type {
  AttentionList,
  ProposedTaskInput,
  TaskResult,
  TaskServiceHost,
  TaskServices,
  TaskServicesDeps,
} from "./types.js";

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

/** The in-memory attention list: replaced whole by every walk, read without touching the file system. */
export function createAttentionList(): AttentionList {
  let current: readonly TaskAttention[] = [];
  return {
    get: () => current,
    set: (next) => {
      current = [...next];
    },
  };
}

/** The most UTF-8 bytes one attention page may take: well under the client's 64 KiB response cap. */
const ATTENTION_PAGE_BUDGET_BYTES = 48 * 1024;
const MAX_OTHER_PATHS = 50;

function displayName(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const bare = name.endsWith(".md") ? name.slice(0, -3) : name;
  return bare.slice(0, 200);
}

/** One item per note: a duplicate names each copy with the other copies' paths. */
function flattenAttention(list: readonly TaskAttention[]): TaskAttentionItem[] {
  const items: TaskAttentionItem[] = [];
  for (const entry of list) {
    for (const path of entry.paths) {
      items.push({
        path,
        title: displayName(path),
        reason: entry.reason,
        otherPaths: entry.paths.filter((other) => other !== path).slice(0, MAX_OTHER_PATHS),
      });
    }
  }
  return items;
}

/** The most UTF-8 bytes a due-today response may take: under the client's 64 KiB cap. */
const DUE_TODAY_BUDGET_BYTES = 56 * 1024;

/** Drops trailing rows, from the longer list first, until the response fits the byte budget. */
function fitDueToday(feed: TaskDueTodayResponse): TaskDueTodayResponse {
  const due = [...feed.due];
  const overdue = [...feed.overdue];
  const size = (): number => Buffer.byteLength(JSON.stringify({ due, overdue }), "utf8");
  while (size() > DUE_TODAY_BUDGET_BYTES && (due.length > 0 || overdue.length > 0)) {
    if (overdue.length >= due.length) overdue.pop();
    else due.pop();
  }
  return { due, overdue };
}

export function createTaskServices(deps: TaskServicesDeps): TaskServiceHost {
  const attentionList = deps.attention ?? createAttentionList();
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

    return persist(
      {
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
      },
      request.zone,
      "create",
    );
  }

  /**
   * Writes one NEW note through the vault writer, indexes it and announces it.
   * The only place this service writes a note, and it only ever adds a file.
   */
  function persist(
    options: Omit<WriteTaskNoteOptions, "now">,
    zone: string,
    fn: string,
  ): TaskResult<{ readonly task: TaskRow }> {
    try {
      const now = deps.now();
      const written = writeTaskNote({ ...options, now });
      let row: ReturnType<typeof getTask>;
      try {
        upsertTask(deps.db, toIndexRecord(written.path, written.frontmatter, written.contentHash));
        row = getTask(deps.db, written.id, localDayBounds(now, zone));
      } catch (error: unknown) {
        // The note is already on disk: a retry would write a duplicate. Ask for
        // a rescan so the index picks the note up, and say so in the log.
        deps.log.error(
          { fn, errorName: errorName(error), phase: "index-after-write" },
          "task note written but not indexed; rescan requested",
        );
        reindexer.requestRescan();
        return fail("write-failed");
      }
      if (row === null) {
        deps.log.error({ fn, errorName: "MissingIndexRow" }, "task create failed");
        return fail("write-failed");
      }
      announce();
      return { ok: true, value: { task: toWireRow(row) } };
    } catch (error: unknown) {
      if (error instanceof WorkspaceScopeViolationError) return fail("invalid-scope");
      if (error instanceof ZodError) return fail("invalid-body");
      deps.log.error({ fn, errorName: errorName(error) }, "task create failed");
      return fail("write-failed");
    }
  }

  /** An automation's suggestion: status proposed, provenance, no approval (D-36, TASK-04, APPR-02). */
  function createProposedTask(input: ProposedTaskInput): TaskResult<{ readonly task: TaskRow }> {
    const vaultRoot = deps.getVaultRoot();
    if (vaultRoot === null || vaultRoot.length === 0) return fail("vault-not-set-up");
    const scope = TaskScopeSchema.safeParse(input.scope ?? "global");
    if (!scope.success) return fail("invalid-scope");
    return persist(
      {
        vaultRoot,
        scope: scope.data,
        title: input.title,
        ...(input.description === undefined ? {} : { body: input.description }),
        intent: "proposed",
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        ...(input.due === undefined ? {} : { due: input.due }),
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        ...(input.tags === undefined ? {} : { tags: input.tags }),
        assignee: "automation",
        sourceType: input.sourceType,
        ...(input.sourceLink === undefined ? {} : { sourceLink: input.sourceLink }),
        generatedBy: input.generatedBy,
        aiGenerated: true,
        claimType: "recommendation",
        confidence: "unverified",
      },
      resolvedZone(),
      "createProposedTask",
    );
  }

  /**
   * The local day, from ONE clock read per request, in the request's zone (or
   * the runtime's when none is given). `null` for a zone the runtime does not
   * know. List and counts share this computation, so a chip count can never
   * disagree with its list (D-33, UI-SPEC R-11).
   */
  function dayFor(zone: string | undefined): LocalDayBounds | null {
    const chosen = zone ?? resolvedZone();
    if (!isValidZone(chosen)) return null;
    return localDayBounds(deps.now(), chosen);
  }

  function queryContext(context: TaskContext) {
    return {
      scope: context.scope,
      ...(context.projectId === undefined ? {} : { projectId: context.projectId }),
    };
  }

  function list(request: Parameters<TaskServices["list"]>[0]): TaskResult<TaskListResponse> {
    const day = dayFor(request.zone);
    if (day === null) return fail("invalid-body");
    let cursor: TaskCursor | undefined;
    if (request.cursor !== undefined) {
      const decoded = decodeTaskCursor(request.cursor, request.filter);
      if (decoded === null) return fail("invalid-cursor");
      cursor = decoded;
    }
    try {
      const page = queryTasks(deps.db, {
        context: queryContext(request.context),
        filter: request.filter,
        day,
        ...(cursor === undefined ? {} : { cursor }),
        ...(request.limit === undefined ? {} : { limit: request.limit }),
      });
      return {
        ok: true,
        value: TaskListResponseSchema.parse({
          rows: page.rows.map(toWireRow),
          total: page.total,
          nextCursor: page.nextCursor === null ? null : encodeTaskCursor(page.nextCursor),
          chooseProject: page.chooseProject,
        }),
      };
    } catch (error: unknown) {
      if (error instanceof InvalidTaskCursorError) return fail("invalid-cursor");
      if (error instanceof InvalidTaskQueryError) return fail("invalid-body");
      throw error;
    }
  }

  function counts(request: Parameters<TaskServices["counts"]>[0]): TaskResult<TaskCountsResponse> {
    const day = dayFor(request.zone);
    if (day === null) return fail("invalid-body");
    try {
      const result = countTasks(deps.db, { context: queryContext(request.context), day });
      return {
        ok: true,
        value: TaskCountsResponseSchema.parse({ counts: result.counts, open: result.open }),
      };
    } catch (error: unknown) {
      if (error instanceof InvalidTaskQueryError) return fail("invalid-body");
      throw error;
    }
  }

  function get(request: Parameters<TaskServices["get"]>[0]): TaskResult<TaskGetResponse> {
    const day = dayFor(undefined);
    if (day === null) return fail("invalid-body");
    const detail = getTask(deps.db, request.taskId, day);
    if (detail === null) return fail("not-found");
    const parent =
      detail.parentId === undefined
        ? undefined
        : { id: detail.parentId, title: getTask(deps.db, detail.parentId)?.title ?? null };
    return {
      ok: true,
      value: TaskGetResponseSchema.parse({
        task: {
          row: toWireRow(detail),
          path: detail.path,
          createdAt: detail.createdAt,
          sourceType: detail.sourceType,
          ...(detail.assignee === undefined ? {} : { assignee: detail.assignee }),
          ...(parent === undefined ? {} : { parent }),
          blockedBy: blockedBy(deps.db, detail.id),
          aiGenerated: detail.aiGenerated,
          confidence: detail.confidence,
          ...(detail.decision === undefined ? {} : { decision: detail.decision }),
        },
      }),
    };
  }

  function dueToday(
    request: Parameters<TaskServices["dueToday"]>[0],
  ): TaskResult<TaskDueTodayResponse> {
    const day = dayFor(request.zone);
    if (day === null) return fail("invalid-body");
    try {
      const feed = listDueToday(deps.db, {
        day,
        ...(request.scope === undefined ? {} : { scope: request.scope }),
      });
      return { ok: true, value: TaskDueTodayResponseSchema.parse(fitDueToday(feed)) };
    } catch (error: unknown) {
      if (error instanceof InvalidTaskQueryError) return fail("invalid-body");
      throw error;
    }
  }

  function attention(
    request: Parameters<TaskServices["attention"]>[0],
  ): TaskResult<TaskAttentionResponse> {
    let offset = 0;
    if (request.cursor !== undefined) {
      const decoded = decodeOffsetCursor(request.cursor);
      if (decoded === null) return fail("invalid-cursor");
      offset = decoded;
    }
    const all = flattenAttention(attentionList.get());
    const limit = request.limit ?? TASK_PAGE_SIZE;
    const items: TaskAttentionItem[] = [];
    let bytes = 0;
    for (let index = offset; index < all.length && items.length < limit; index++) {
      const item = all[index] as TaskAttentionItem;
      const size = Buffer.byteLength(JSON.stringify(item), "utf8") + 1;
      // At least one item per page, so a very large item can never stall the paging.
      if (items.length > 0 && bytes + size > ATTENTION_PAGE_BUDGET_BYTES) break;
      items.push(item);
      bytes += size;
    }
    const end = offset + items.length;
    return {
      ok: true,
      value: TaskAttentionResponseSchema.parse({
        items,
        total: all.length,
        nextCursor: end < all.length ? encodeOffsetCursor(end) : null,
      }),
    };
  }

  const reindexer = createReindexer({
    db: deps.db,
    getVaultRoot: deps.getVaultRoot,
    attention: attentionList,
    now: deps.now,
    log: deps.log,
    onChanged: () => {
      announce();
    },
    minIntervalMs: deps.minWalkIntervalMs,
    timers: deps.timers,
  });

  const changedDeps: ChangedDeps = {
    db: deps.db,
    getVaultRoot: deps.getVaultRoot,
    log: deps.log,
    requestRescan: reindexer.requestRescan,
    announce,
    generation: () => generation,
    knownDuplicateId: (path) =>
      attentionList
        .get()
        .find((entry) => entry.reason === "duplicate-id" && entry.paths.includes(path))?.id,
  };

  return {
    create,
    list,
    counts,
    get,
    dueToday,
    attention,
    changed: (request) => {
      try {
        return applyChanged(changedDeps, request);
      } catch (error: unknown) {
        deps.log.error({ fn: "changed", errorName: errorName(error) }, "task change failed");
        return fail("write-failed");
      }
    },
    rebuild: reindexer.rebuild,
    createProposedTask,
    startupWalk: reindexer.walk,
    dispose: reindexer.dispose,
  };
}
