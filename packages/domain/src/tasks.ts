import { z } from "zod";
import { API_BASE } from "./api.js";
import { CONFIDENCE_STATES, GeneratedBySchema, NOTE_SCOPE_PATTERN } from "./note-schema.js";
import { ProjectIdSchema } from "./projects.js";
import {
  isTaskNotePath,
  TASK_NOTE_PATH_MAX_LENGTH,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TaskDecisionSchema,
  TaskIdSchema,
  TaskInstantSchema,
  type TaskPriority,
  type TaskStatus,
  TaskTagSchema,
  TaskTitleSchema,
} from "./task-schema.js";
import { isValidZone } from "./task-time.js";

/**
 * Task filters, display maps, route contracts and the `tasks.changed` event
 * payload (plan 06-05; D-28, D-33, D-34, D-37, D-38, UI-SPEC S3 to S5).
 *
 * Three rules hold across everything here:
 *
 * 1. **Fixed paths, no parameters.** The service's route table matches exact
 *    paths only, so every id, filter and cursor travels in a strict JSON body
 *    (the `VAULT_SETUP_PATH` precedent).
 * 2. **No filesystem path ever crosses the wire except a vault-relative task
 *    note path** that matches {@link isTaskNotePath}. A request that could name
 *    an arbitrary path would let any caller name any file (T-06-20).
 * 3. **Rows carry no body text.** Descriptions stay in the note; a list of ten
 *    thousand tasks must stay small (D-32).
 *
 * The `tasks.changed` payload schema lives here, not in `events.ts`, so the
 * shared event file only gains one line per phase.
 *
 * Node-free: reachable from the plugin's browser bundle.
 */

// ---------------------------------------------------------------------------
// Filters (D-33, UI-SPEC "Filter chips")

/**
 * The eight chips in their fixed order: the unfiltered `all`, then the seven PRD
 * filters. `all` is the only view that shows `cancelled` tasks.
 */
export const TASK_FILTERS = [
  "all",
  "today",
  "upcoming",
  "overdue",
  "project",
  "proposed",
  "blocked",
  "completed",
] as const;
export type TaskFilter = (typeof TASK_FILTERS)[number];
export const TaskFilterSchema = z.enum(TASK_FILTERS);

/** The seven PRD filters (TASK-06): the chips without the unfiltered `all`. */
export const TASK_PRD_FILTERS = [
  "today",
  "upcoming",
  "overdue",
  "project",
  "proposed",
  "blocked",
  "completed",
] as const satisfies readonly TaskFilter[];

/**
 * The project panel's chips (UI-SPEC S4): the global list without `project`,
 * because the project is already fixed there.
 */
export const TASK_PROJECT_PANEL_FILTERS = [
  "all",
  "today",
  "upcoming",
  "overdue",
  "proposed",
  "blocked",
  "completed",
] as const satisfies readonly TaskFilter[];

/** The chip pressed on first open of the global Tasks destination. The project panel opens on `all`. */
export const TASK_DEFAULT_FILTER = "today" as const satisfies TaskFilter;
export const TASK_PROJECT_PANEL_DEFAULT_FILTER = "all" as const satisfies TaskFilter;

/** The visible chip label, before the count. */
export const TASK_FILTER_LABELS: Readonly<Record<TaskFilter, string>> = {
  all: "All",
  today: "Today",
  upcoming: "Upcoming",
  overdue: "Overdue",
  project: "Project",
  proposed: "Proposed",
  blocked: "Blocked",
  completed: "Completed",
};

export type TaskSortField =
  | "updated"
  | "created"
  | "completed"
  | "due"
  | "time-of-day"
  | "priority";

export interface TaskSortKey {
  readonly field: TaskSortField;
  /** `asc` on `priority` means urgent first; on a date or time it means soonest or oldest first. */
  readonly direction: "asc" | "desc";
  /** Where a task with no value for the field goes. Absent means the field is always set. */
  readonly nulls?: "last";
}

/** Urgent sorts first; a task with no priority sorts after every priority. */
export const TASK_PRIORITY_RANK: Readonly<Record<TaskPriority, number>> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/**
 * The default order of each filter (UI-SPEC "Filter chips" table). The index
 * applies it with a keyset over `(sort key, note id)`; a cursor from one filter
 * is never valid for another.
 */
export const TASK_FILTER_SORTS: Readonly<Record<TaskFilter, readonly TaskSortKey[]>> = {
  all: [{ field: "updated", direction: "desc" }],
  today: [
    { field: "time-of-day", direction: "asc", nulls: "last" },
    { field: "priority", direction: "asc", nulls: "last" },
  ],
  upcoming: [{ field: "due", direction: "asc", nulls: "last" }],
  overdue: [{ field: "due", direction: "asc" }],
  project: [
    { field: "priority", direction: "asc", nulls: "last" },
    { field: "due", direction: "asc", nulls: "last" },
  ],
  proposed: [{ field: "created", direction: "desc" }],
  blocked: [{ field: "due", direction: "asc", nulls: "last" }],
  completed: [{ field: "completed", direction: "desc" }],
};

// ---------------------------------------------------------------------------
// Display maps (UI-SPEC "Task statuses", "Task priority", glyph rule)

export interface TaskStatusDisplay {
  readonly label: string;
  /** A text-presentation glyph beside the visible label. Never the only carrier of meaning. */
  readonly glyph: string;
}

/**
 * The single display mapping for the seven statuses. Every surface reads it. Only
 * the three outcome glyphs (`✓` finished, `✕` failed, `⊘` stopped or cancelled)
 * may repeat across vocabularies; every other glyph is unique (UI-SPEC glyph
 * rule). The status label itself is never rewritten to show an unmet dependency.
 */
export const TASK_STATUS_DISPLAY: Readonly<Record<TaskStatus, TaskStatusDisplay>> = {
  inbox: { label: "Inbox", glyph: "▤" },
  proposed: { label: "Proposed", glyph: "✦" },
  ready: { label: "Ready", glyph: "◎" },
  "in-progress": { label: "In progress", glyph: "▰" },
  blocked: { label: "Blocked", glyph: "‖" },
  done: { label: "Done", glyph: "✓" },
  cancelled: { label: "Cancelled", glyph: "⊘" },
};

export interface TaskPriorityDisplay {
  readonly label: string;
  /** Null for `none`: the label shows in the detail pane and the form, and is omitted from row meta. */
  readonly glyph: string | null;
}

/** The four priorities and the absent case (`none`, which has no glyph). */
export const TASK_PRIORITY_DISPLAY: Readonly<Record<TaskPriority | "none", TaskPriorityDisplay>> = {
  urgent: { label: "Urgent", glyph: "⇈" },
  high: { label: "High", glyph: "↑" },
  medium: { label: "Medium", glyph: "⇢" },
  low: { label: "Low", glyph: "↓" },
  none: { label: "No priority", glyph: null },
};

// ---------------------------------------------------------------------------
// Shared request pieces

/** The page size every list uses (UI-SPEC "Volume"). */
export const TASK_PAGE_SIZE = 25;
/** The longest opaque cursor a request may carry. */
export const TASK_CURSOR_MAX_LENGTH = 256;
/** At most this many rows per feed in the due-today response (D-38). */
export const TASK_DUE_TODAY_LIMIT = 50;
/** At most this many tags travel on a row; the rest are a count. */
export const TASK_ROW_TAG_LIMIT = 3;
/** The most paths one changed request names; more than this is a rescan (research Pattern 13). */
export const TASK_CHANGED_MAX_PATHS = 200;
/** The longest description a create request carries; it becomes the note body. */
export const TASK_DESCRIPTION_MAX_LENGTH = 10_000;

/** An IANA zone the runtime knows. The request carries it (assumption A6); an offset string is not a zone. */
export const TaskZoneSchema = z.string().refine((zone) => isValidZone(zone), {
  message: "must be an IANA time zone",
});

/** An opaque keyset cursor: base64url-shaped, bounded. The service validates what it decodes to. */
export const TaskCursorSchema = z
  .string()
  .min(1)
  .max(TASK_CURSOR_MAX_LENGTH)
  .regex(/^[A-Za-z0-9_-]+$/, { message: "must be URL-safe" });

/** A vault-relative task note path and nothing else (T-06-20). */
export const TaskNotePathSchema = z
  .string()
  .max(TASK_NOTE_PATH_MAX_LENGTH)
  .refine((path) => isTaskNotePath(path), { message: "must be a vault-relative task note path" });

/** One concrete scope: `global` or `workspace:<id>`. */
export const TaskScopeSchema = z
  .string()
  .regex(NOTE_SCOPE_PATTERN, { message: "must be a note scope" });

/** The Scope selector of the global context: every scope, or one. */
export const TaskScopeSelectorSchema = z.union([z.literal("all"), TaskScopeSchema]);

/**
 * One query context (D-34). The global Tasks destination and each project panel
 * hold their own, so neither can mutate the other's filter state. `projectId` is
 * the project the `project` filter (or a project panel) is narrowed to.
 */
export const TaskContextSchema = z.strictObject({
  scope: TaskScopeSelectorSchema,
  projectId: ProjectIdSchema.optional(),
});
export type TaskContext = z.infer<typeof TaskContextSchema>;

const CalendarDateSchema = z.iso.date();
const NonNegativeInt = z.number().int().nonnegative();

// ---------------------------------------------------------------------------
// The row view (no body text, no absolute path)

/**
 * One task as a list row: everything the row's two meta lines and its actions
 * need, and nothing else. A date is either all-day (`*Date`) or an instant
 * (`*At`), never both: the index keeps the two apart so a later time-zone change
 * cannot move an all-day task.
 */
export const TaskRowSchema = z
  .strictObject({
    id: TaskIdSchema,
    // A display string from the index, which only ever holds validated titles; the plugin
    // still renders it as literal text. Plain bounds here so one odd row cannot reject a page.
    title: z.string().min(1).max(200),
    status: z.enum(TASK_STATUSES),
    priority: z.enum(TASK_PRIORITIES).optional(),
    scope: TaskScopeSchema,
    projectId: ProjectIdSchema.optional(),
    dueDate: CalendarDateSchema.optional(),
    dueAt: TaskInstantSchema.optional(),
    scheduledDate: CalendarDateSchema.optional(),
    scheduledAt: TaskInstantSchema.optional(),
    completedAt: TaskInstantSchema.optional(),
    /** Up to {@link TASK_ROW_TAG_LIMIT} tags; `tagCount` is the full number. */
    tags: z.array(TaskTagSchema).max(TASK_ROW_TAG_LIMIT),
    tagCount: z.number().int().min(0).max(20),
    /** Dependencies that are not `done` or `cancelled`, a missing one counting as unmet. */
    unmetDependencies: z.number().int().min(0).max(50),
    /** True when the task is open and its due value is before the start of the local day. */
    overdue: z.boolean(),
    updatedAt: z.iso.datetime(),
  })
  .refine((row) => row.dueDate === undefined || row.dueAt === undefined, {
    message: "a due value is a date or an instant, not both",
  })
  .refine((row) => row.scheduledDate === undefined || row.scheduledAt === undefined, {
    message: "a scheduled value is a date or an instant, not both",
  });
export type TaskRow = z.infer<typeof TaskRowSchema>;

// ---------------------------------------------------------------------------
// Create (TASK-03, D-37)

/** `POST` — create a manual task. A proposed task has no HTTP route (D-36). */
export const TASK_CREATE_PATH = `${API_BASE}/tasks/create`;
/** `POST` — one page of a filter, in a context. */
export const TASK_LIST_PATH = `${API_BASE}/tasks/list`;
/** `POST` — every chip count for a context, from one computation. */
export const TASK_COUNTS_PATH = `${API_BASE}/tasks/counts`;
/** `POST` — one task's detail. */
export const TASK_GET_PATH = `${API_BASE}/tasks/get`;
/** `POST` — task notes changed on disk; the service re-reads frontmatter and never writes. */
export const TASK_CHANGED_PATH = `${API_BASE}/tasks/changed`;
/** `POST` — rebuild the disposable index from the vault. */
export const TASK_REBUILD_PATH = `${API_BASE}/tasks/rebuild`;
/** `POST` — notes that share an id, lack one, or cannot be read (D-37). */
export const TASK_ATTENTION_PATH = `${API_BASE}/tasks/attention`;
/** `POST` — the due-today and overdue feed Phase 8 surfaces (D-38). */
export const TASK_DUE_TODAY_PATH = `${API_BASE}/tasks/due-today`;

/** The two ways a manual task can enter: the inbox, or ready to work on. */
export const TASK_CREATE_INTENTS = ["inbox", "ready"] as const;
export type TaskCreateIntent = (typeof TASK_CREATE_INTENTS)[number];

const LocalTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: "must be HH:MM" });

/**
 * The create body (UI-SPEC "Create form"). `dueDate` with an optional `dueTime`
 * is the form's local date and time; the service turns the pair into an offset
 * instant with `zone`, and a date alone stays all-day. `description` becomes the
 * note body (the form's Description field). Strict: no id, status or path can
 * be supplied by a caller.
 */
export const TaskCreateRequestSchema = z
  .strictObject({
    title: TaskTitleSchema,
    description: z
      .string()
      .max(TASK_DESCRIPTION_MAX_LENGTH)
      .refine((value) => !value.includes("\0"), { message: "must not contain a NUL byte" })
      .optional(),
    intent: z.enum(TASK_CREATE_INTENTS),
    zone: TaskZoneSchema,
    dueDate: CalendarDateSchema.optional(),
    dueTime: LocalTimeSchema.optional(),
    scheduledDate: CalendarDateSchema.optional(),
    scope: TaskScopeSchema.optional(),
    projectId: ProjectIdSchema.optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    tags: z.array(TaskTagSchema).max(20).optional(),
  })
  .refine((body) => body.dueTime === undefined || body.dueDate !== undefined, {
    message: "a due time needs a due date",
  });
export type TaskCreateRequest = z.infer<typeof TaskCreateRequestSchema>;

export const TaskCreateResponseSchema = z.strictObject({ task: TaskRowSchema });
export type TaskCreateResponse = z.infer<typeof TaskCreateResponseSchema>;

// ---------------------------------------------------------------------------
// List and counts (TASK-06, TASK-07)

export const TaskListRequestSchema = z.strictObject({
  context: TaskContextSchema,
  filter: TaskFilterSchema,
  zone: TaskZoneSchema,
  cursor: TaskCursorSchema.optional(),
  limit: z.number().int().min(1).max(TASK_PAGE_SIZE).optional(),
});
export type TaskListRequest = z.infer<typeof TaskListRequestSchema>;

export const TaskListResponseSchema = z.strictObject({
  rows: z.array(TaskRowSchema).max(TASK_PAGE_SIZE),
  /** The full number of tasks the filter matches in this context, not the page length. */
  total: NonNegativeInt,
  nextCursor: TaskCursorSchema.nullable(),
  /** True for the `project` filter with no project chosen: the page is empty by design. */
  chooseProject: z.boolean(),
});
export type TaskListResponse = z.infer<typeof TaskListResponseSchema>;

export const TaskCountsRequestSchema = z.strictObject({
  context: TaskContextSchema,
  zone: TaskZoneSchema,
});
export type TaskCountsRequest = z.infer<typeof TaskCountsRequestSchema>;

/**
 * Every chip's count and the open total, from the SAME day bounds as the list, so
 * a chip count can never disagree with the list below it (UI-SPEC R-11).
 */
export const TaskCountsResponseSchema = z.strictObject({
  counts: z.strictObject({
    all: NonNegativeInt,
    today: NonNegativeInt,
    upcoming: NonNegativeInt,
    overdue: NonNegativeInt,
    project: NonNegativeInt,
    proposed: NonNegativeInt,
    blocked: NonNegativeInt,
    completed: NonNegativeInt,
  }),
  /** Actionable tasks: not done, cancelled or proposed (the summary line's "open"). */
  open: NonNegativeInt,
});
export type TaskCountsResponse = z.infer<typeof TaskCountsResponseSchema>;

// ---------------------------------------------------------------------------
// Detail

export const TaskGetRequestSchema = z.strictObject({ taskId: TaskIdSchema });
export type TaskGetRequest = z.infer<typeof TaskGetRequestSchema>;

/**
 * A dependency that is not finished: resolved to a task with its title and
 * status, or unresolved (the id names no task; shown as "can't be found").
 */
export const TaskBlockedByEntrySchema = z.discriminatedUnion("resolved", [
  z.strictObject({
    resolved: z.literal(true),
    id: TaskIdSchema,
    title: z.string().min(1).max(200),
    status: z.enum(TASK_STATUSES),
  }),
  z.strictObject({ resolved: z.literal(false), id: TaskIdSchema }),
]);
export type TaskBlockedByEntry = z.infer<typeof TaskBlockedByEntrySchema>;

/**
 * Everything the detail pane shows beyond the row. Never the description (the
 * plugin reads the note itself), and the only path is the vault-relative note
 * path, shown in mono and never as an absolute path.
 */
export const TaskDetailSchema = z.strictObject({
  row: TaskRowSchema,
  path: TaskNotePathSchema,
  createdAt: z.iso.datetime(),
  sourceType: z.string().min(1).max(32),
  sourceLink: z.string().max(2048).optional(),
  assignee: z.enum(["user", "automation"]).optional(),
  parent: z.strictObject({ id: TaskIdSchema, title: z.string().max(200).nullable() }).optional(),
  blockedBy: z.array(TaskBlockedByEntrySchema).max(50),
  aiGenerated: z.boolean(),
  generatedBy: GeneratedBySchema.optional(),
  confidence: z.enum(CONFIDENCE_STATES),
  decision: TaskDecisionSchema.optional(),
});
export type TaskDetail = z.infer<typeof TaskDetailSchema>;

export const TaskGetResponseSchema = z.strictObject({ task: TaskDetailSchema });
export type TaskGetResponse = z.infer<typeof TaskGetResponseSchema>;

// ---------------------------------------------------------------------------
// Changed, rebuild, attention (D-35, D-37)

/**
 * Task notes that changed on disk, as vault-relative paths, or a rescan after a
 * folder-level event or a batch above the cap. At least one of the two. The
 * route never writes a note, which makes a modify-changed-write loop unreachable.
 */
export const TaskChangedRequestSchema = z
  .strictObject({
    paths: z.array(TaskNotePathSchema).max(TASK_CHANGED_MAX_PATHS).optional(),
    rescan: z.boolean().optional(),
  })
  .refine((body) => (body.paths?.length ?? 0) > 0 || body.rescan === true, {
    message: "names no path and requests no rescan",
  });
export type TaskChangedRequest = z.infer<typeof TaskChangedRequestSchema>;

export const TaskChangedResponseSchema = z.strictObject({
  accepted: NonNegativeInt,
  generation: NonNegativeInt,
});
export type TaskChangedResponse = z.infer<typeof TaskChangedResponseSchema>;

export const TaskRebuildRequestSchema = z.strictObject({});
export type TaskRebuildRequest = z.infer<typeof TaskRebuildRequestSchema>;

export const TaskRebuildResponseSchema = z.strictObject({
  /** Valid tasks indexed. */
  tasks: NonNegativeInt,
  /** Notes left out and listed under attention. */
  attention: NonNegativeInt,
});
export type TaskRebuildResponse = z.infer<typeof TaskRebuildResponseSchema>;

/** Why a task note is left out of every list. Never auto-resolved: no route mints or rewrites an id. */
export const TASK_ATTENTION_REASONS = ["duplicate-id", "missing-id", "unreadable"] as const;
export type TaskAttentionReason = (typeof TASK_ATTENTION_REASONS)[number];

export const TaskAttentionRequestSchema = z.strictObject({
  cursor: TaskCursorSchema.optional(),
  limit: z.number().int().min(1).max(TASK_PAGE_SIZE).optional(),
});
export type TaskAttentionRequest = z.infer<typeof TaskAttentionRequestSchema>;

export const TaskAttentionItemSchema = z.strictObject({
  path: TaskNotePathSchema,
  /** The note's title, or its file name when it has none. A display string. */
  title: z.string().max(200).optional(),
  reason: z.enum(TASK_ATTENTION_REASONS),
  /** For a shared id, the other copies' paths. Empty for the other reasons. */
  otherPaths: z.array(TaskNotePathSchema).max(50),
});
export type TaskAttentionItem = z.infer<typeof TaskAttentionItemSchema>;

export const TaskAttentionResponseSchema = z.strictObject({
  items: z.array(TaskAttentionItemSchema).max(TASK_PAGE_SIZE),
  total: NonNegativeInt,
  nextCursor: TaskCursorSchema.nullable(),
});
export type TaskAttentionResponse = z.infer<typeof TaskAttentionResponseSchema>;

// ---------------------------------------------------------------------------
// Due-today feed (D-38)

export const TaskDueTodayRequestSchema = z.strictObject({
  zone: TaskZoneSchema,
  scope: TaskScopeSelectorSchema.optional(),
});
export type TaskDueTodayRequest = z.infer<typeof TaskDueTodayRequestSchema>;

/** One feed row: the task id (so a Today card can open the task), its title and the date it is due. */
export const TaskDueTodayRowSchema = z
  .strictObject({
    taskId: TaskIdSchema,
    title: z.string().min(1).max(200),
    dueDate: CalendarDateSchema.optional(),
    dueAt: TaskInstantSchema.optional(),
    scheduledDate: CalendarDateSchema.optional(),
    scheduledAt: TaskInstantSchema.optional(),
  })
  .refine((row) => row.dueDate === undefined || row.dueAt === undefined, {
    message: "a due value is a date or an instant, not both",
  })
  .refine((row) => row.scheduledDate === undefined || row.scheduledAt === undefined, {
    message: "a scheduled value is a date or an instant, not both",
  });
export type TaskDueTodayRow = z.infer<typeof TaskDueTodayRowSchema>;

export const TaskDueTodayResponseSchema = z.strictObject({
  due: z.array(TaskDueTodayRowSchema).max(TASK_DUE_TODAY_LIMIT),
  overdue: z.array(TaskDueTodayRowSchema).max(TASK_DUE_TODAY_LIMIT),
});
export type TaskDueTodayResponse = z.infer<typeof TaskDueTodayResponseSchema>;

// ---------------------------------------------------------------------------
// Errors (the plugin owns the copy; no body carries a message, a title or a path)

export const TASK_ERROR_CODES = [
  "vault-not-set-up",
  "invalid-scope",
  "write-failed",
  "not-found",
  "invalid-cursor",
  "invalid-path",
  "invalid-body",
  "service-disconnected",
  "timeout",
  "unrecognised-response",
] as const;
export type TaskErrorCode = (typeof TASK_ERROR_CODES)[number];
export const TaskErrorCodeSchema = z.enum(TASK_ERROR_CODES);

/** A closed code and nothing else. A body with another code or an extra key is not a task error. */
export const TaskErrorBodySchema = z.strictObject({ error: TaskErrorCodeSchema });
export type TaskErrorBody = z.infer<typeof TaskErrorBodySchema>;

// ---------------------------------------------------------------------------
// The event payload

/**
 * The `tasks.changed` event payload: a generation that only ever increases, so a
 * container can tell a newer signal from a replayed one and re-query. It carries
 * no row and no path (the signal is "ask again"), and later fields may be added:
 * the schema ignores keys it does not know.
 */
export const TasksChangedPayloadSchema = z.object({
  generation: NonNegativeInt,
});
export type TasksChangedPayload = z.infer<typeof TasksChangedPayloadSchema>;
