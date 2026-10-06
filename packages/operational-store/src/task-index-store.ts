import {
  CLAIM_TYPES,
  type ClaimType,
  CONFIDENCE_STATES,
  type ConfidenceState,
  isTaskNotePath,
  type LocalDayBounds,
  NOTE_ID_PATTERN,
  NOTE_SCOPE_PATTERN,
  type NoteId,
  normaliseDue,
  ProjectIdSchema,
  TASK_FILTERS,
  TASK_PAGE_SIZE,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type TaskFilter,
  TaskIdSchema,
  TaskInstantSchema,
  type TaskPriority,
  type TaskStatus,
  TaskTagSchema,
  TaskTitleSchema,
} from "@ccc/domain";
import type Database from "better-sqlite3";
import { upsertVaultNote } from "./vault-notes-store.js";

/**
 * The disposable task index (plan 06-14; D-32, D-33, ADR-0004, ADR-0022).
 *
 * One row per valid task note, holding only the keys a filter, a sort or a
 * list row needs, plus a generic `vault_notes` row for the same note (the first
 * production caller of {@link upsertVaultNote}, ADR-0022 policy b). The vault's
 * Markdown stays the ground truth: nothing here can hold a note body (the schema
 * has no such column, and a test asserts it), and the index can be dropped and
 * rebuilt from the vault at any time.
 *
 * Three rules hold across the module:
 *
 * 1. **Every value in SQL is bound.** WHERE clauses, sort keys and keyset
 *    predicates are assembled from the literal fragments below and nothing a
 *    caller supplies is ever concatenated into SQL text (threat T-06-19).
 * 2. **The day is an input.** `today`, and the UTC bounds of the local day,
 *    arrive from the caller (computed once per request with the domain
 *    `localDayBounds`), never from SQL and never from the machine clock, so a
 *    list and its counts cannot disagree about where today ends.
 * 3. **Enum and shape validation at the boundary.** A task note's frontmatter
 *    is hand-editable, so each record is validated here (like the generic
 *    store) before anything is written, and a failure writes nothing.
 */

// ---------------------------------------------------------------------------
// Types

/** What the service parsed from one valid task note: filter keys only, no body. */
export interface TaskIndexRecord {
  readonly noteId: string;
  /** Vault-relative `global/tasks/<name>.md` or `workspaces/<id>/tasks/<name>.md`. */
  readonly path: string;
  /** `global` or `workspace:<id>`; must agree with the path. */
  readonly scope: string;
  readonly projectId?: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly priority?: TaskPriority;
  /** The authored `due` value: a calendar date (all-day) or an offset instant. */
  readonly due?: string;
  /** The authored `scheduled` value, same shapes. */
  readonly scheduled?: string;
  /** The authored `completed` instant. */
  readonly completed?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly parentId?: string;
  readonly sourceType: string;
  readonly assignee?: "user" | "automation";
  /** SHA-256 of the whole note file (hex), so a metadata-only edit changes it. */
  readonly contentHash: string;
  readonly tags: readonly string[];
  readonly dependencies: readonly string[];
  readonly decision?: { readonly outcome: "accepted" | "dismissed"; readonly at: string };
  readonly aiGenerated: boolean;
  readonly claimType: ClaimType | null;
  readonly confidence: ConfidenceState;
}

/** One task as a list row: no body text, no absolute path, at most three tags. */
export interface TaskIndexRow {
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly priority?: TaskPriority;
  readonly scope: string;
  readonly projectId?: string;
  readonly dueDate?: string;
  readonly dueAt?: string;
  readonly scheduledDate?: string;
  readonly scheduledAt?: string;
  readonly completedAt?: string;
  readonly tags: readonly string[];
  readonly tagCount: number;
  /** Dependencies not `done` or `cancelled`; a dependency naming no task counts as unmet. */
  readonly unmetDependencies: number;
  /** Open and due before the start of the local day (false when no day was supplied). */
  readonly overdue: boolean;
  readonly updatedAt: string;
}

/** A task's full indexed detail: the row plus the keys the detail pane and the no-op check need. */
export interface TaskIndexDetail extends TaskIndexRow {
  readonly path: string;
  readonly createdAt: string;
  readonly sourceType: string;
  readonly assignee?: "user" | "automation";
  readonly parentId?: string;
  readonly contentHash: string;
  readonly decision?: { readonly outcome: "accepted" | "dismissed"; readonly at: string };
  readonly aiGenerated: boolean;
  readonly claimType: ClaimType | null;
  readonly confidence: ConfidenceState;
}

/** The context every list and count is asked in (D-34): a scope selector and an optional project. */
export interface TaskQueryContext {
  /** `all`, `global` or `workspace:<id>`. */
  readonly scope: string;
  readonly projectId?: string;
}

/** The decoded keyset position: the last row's sort keys and id. The service encodes it. */
export interface TaskCursor {
  readonly filter: TaskFilter;
  readonly keys: readonly (string | number)[];
  readonly id: string;
}

export interface TaskQuery {
  readonly context: TaskQueryContext;
  readonly filter: TaskFilter;
  /** The local date and UTC day bounds, computed once per request by the caller. */
  readonly day: LocalDayBounds;
  readonly cursor?: TaskCursor;
  /** Rows per page; above {@link TASK_PAGE_SIZE} is clamped, below one is refused. */
  readonly limit?: number;
}

export interface TaskPage {
  readonly rows: readonly TaskIndexRow[];
  /** Every task the filter matches in this context, not the page length. */
  readonly total: number;
  readonly nextCursor: TaskCursor | null;
  /** True for the `project` filter with no project chosen: the page is empty by design. */
  readonly chooseProject: boolean;
}

/** Thrown when a record's field is outside its domain; nothing is written. */
export class InvalidTaskIndexError extends Error {
  constructor(field: string, value: string) {
    super(`${JSON.stringify(value.slice(0, 40))} is not a valid ${field}`);
    this.name = "InvalidTaskIndexError";
  }
}

/** Thrown when a query argument (scope, project, filter, day, limit) is outside its domain. */
export class InvalidTaskQueryError extends Error {
  constructor(field: string, value: string) {
    super(`${JSON.stringify(value.slice(0, 40))} is not a valid ${field}`);
    this.name = "InvalidTaskQueryError";
  }
}

/** Thrown when a cursor has the wrong shape or belongs to another filter. */
export class InvalidTaskCursorError extends Error {
  constructor(reason: string) {
    super(`invalid task cursor: ${reason}`);
    this.name = "InvalidTaskCursorError";
  }
}

// ---------------------------------------------------------------------------
// Validation (the boundary: frontmatter is untrusted, T-06-19)

interface TaskColumns {
  readonly noteId: string;
  readonly path: string;
  readonly scope: string;
  readonly projectId: string | null;
  readonly title: string;
  readonly status: string;
  readonly priority: string | null;
  readonly dueDate: string | null;
  readonly dueAt: string | null;
  readonly schedDate: string | null;
  readonly schedAt: string | null;
  readonly dueSort: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly parentId: string | null;
  readonly sourceType: string;
  readonly assignee: string | null;
  readonly contentHash: string;
  readonly decisionOutcome: string | null;
  readonly decisionAt: string | null;
  readonly aiGenerated: string;
  readonly claimType: string | null;
  readonly confidence: string;
}

interface ValidatedTask {
  readonly columns: TaskColumns;
  readonly tags: readonly string[];
  readonly dependencies: readonly string[];
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_TAGS = 20;
const MAX_DEPENDENCIES = 50;

function fail(field: string, value: unknown): never {
  throw new InvalidTaskIndexError(field, String(value));
}

/** An offset instant normalised to UTC ISO so text comparison orders instants. */
function toInstant(field: string, value: string): string {
  if (!TaskInstantSchema.safeParse(value).success) fail(field, value);
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) fail(field, value);
  return new Date(ms).toISOString();
}

/** The scope a path implies, or null when the path is not a task note path. */
function scopeOfTaskPath(path: string): string | null {
  if (!isTaskNotePath(path)) return null;
  if (path.startsWith("global/")) return "global";
  const workspaceId = path.split("/")[1];
  return workspaceId === undefined ? null : `workspace:${workspaceId}`;
}

/**
 * Validates one record against its domain unions and shapes and returns the
 * column values to store. Throws {@link InvalidTaskIndexError} before any
 * write, so a rejected record leaves the index untouched.
 */
function validateTaskRecord(record: TaskIndexRecord): ValidatedTask {
  if (!NOTE_ID_PATTERN.test(record.noteId)) fail("note id", record.noteId);
  if (!NOTE_SCOPE_PATTERN.test(record.scope)) fail("scope", record.scope);
  const pathScope = scopeOfTaskPath(record.path);
  if (pathScope === null) fail("task note path", record.path);
  if (pathScope !== record.scope) fail("scope for this path", record.scope);
  if (!TaskTitleSchema.safeParse(record.title).success) fail("task title", record.title);
  if (!(TASK_STATUSES as readonly string[]).includes(record.status)) fail("status", record.status);
  if (
    record.priority !== undefined &&
    !(TASK_PRIORITIES as readonly string[]).includes(record.priority)
  ) {
    fail("priority", record.priority);
  }
  if (record.projectId !== undefined && !ProjectIdSchema.safeParse(record.projectId).success) {
    fail("project id", record.projectId);
  }
  if (record.parentId !== undefined && !TaskIdSchema.safeParse(record.parentId).success) {
    fail("parent id", record.parentId);
  }
  if (
    record.assignee !== undefined &&
    record.assignee !== "user" &&
    record.assignee !== "automation"
  ) {
    fail("assignee", record.assignee);
  }
  if (
    typeof record.sourceType !== "string" ||
    record.sourceType.length === 0 ||
    record.sourceType.length > 32
  ) {
    fail("source type", record.sourceType);
  }
  if (!SHA256_HEX.test(record.contentHash)) fail("content hash", record.contentHash);
  if (record.claimType !== null && !CLAIM_TYPES.includes(record.claimType)) {
    fail("claim type", record.claimType);
  }
  if (!CONFIDENCE_STATES.includes(record.confidence)) fail("confidence", record.confidence);

  let due = { date: null as string | null, instant: null as string | null };
  if (record.due !== undefined) {
    const parsed = normaliseDue(record.due);
    if (parsed === null) fail("due value", record.due);
    due = parsed;
  }
  let scheduled = { date: null as string | null, instant: null as string | null };
  if (record.scheduled !== undefined) {
    const parsed = normaliseDue(record.scheduled);
    if (parsed === null) fail("scheduled value", record.scheduled);
    scheduled = parsed;
  }
  if (record.decision !== undefined) {
    if (record.decision.outcome !== "accepted" && record.decision.outcome !== "dismissed") {
      fail("decision outcome", record.decision.outcome);
    }
  }

  if (record.tags.length > MAX_TAGS) fail("tag count", record.tags.length);
  for (const tag of record.tags) if (!TaskTagSchema.safeParse(tag).success) fail("tag", tag);
  if (record.dependencies.length > MAX_DEPENDENCIES) {
    fail("dependency count", record.dependencies.length);
  }
  for (const dep of record.dependencies) {
    if (!TaskIdSchema.safeParse(dep).success) fail("dependency id", dep);
  }

  return {
    columns: {
      noteId: record.noteId,
      path: record.path,
      scope: record.scope,
      projectId: record.projectId ?? null,
      title: record.title,
      status: record.status,
      priority: record.priority ?? null,
      dueDate: due.date,
      dueAt: due.instant,
      schedDate: scheduled.date,
      schedAt: scheduled.instant,
      dueSort: due.instant ?? due.date,
      completedAt: record.completed === undefined ? null : toInstant("completed", record.completed),
      createdAt: toInstant("created time", record.createdAt),
      updatedAt: toInstant("updated time", record.updatedAt),
      parentId: record.parentId ?? null,
      sourceType: record.sourceType,
      assignee: record.assignee ?? null,
      contentHash: record.contentHash,
      decisionOutcome: record.decision?.outcome ?? null,
      decisionAt:
        record.decision === undefined ? null : toInstant("decision time", record.decision.at),
      aiGenerated: record.aiGenerated ? "true" : "false",
      claimType: record.claimType,
      confidence: record.confidence,
    },
    tags: [...new Set(record.tags)],
    dependencies: [...new Set(record.dependencies)],
  };
}

// ---------------------------------------------------------------------------
// Writes

const UPSERT_TASK_SQL = `INSERT INTO task_index
     (note_id, path, scope, project_id, title, status, priority, due_date, due_at, sched_date, sched_at,
      due_sort, completed_at, created_at, updated_at, parent_id, source_type, assignee, content_hash,
      decision_outcome, decision_at, ai_generated, claim_type, confidence)
   VALUES
     (@noteId, @path, @scope, @projectId, @title, @status, @priority, @dueDate, @dueAt, @schedDate, @schedAt,
      @dueSort, @completedAt, @createdAt, @updatedAt, @parentId, @sourceType, @assignee, @contentHash,
      @decisionOutcome, @decisionAt, @aiGenerated, @claimType, @confidence)
   ON CONFLICT(note_id) DO UPDATE SET
     path = excluded.path, scope = excluded.scope, project_id = excluded.project_id,
     title = excluded.title, status = excluded.status, priority = excluded.priority,
     due_date = excluded.due_date, due_at = excluded.due_at, sched_date = excluded.sched_date,
     sched_at = excluded.sched_at, due_sort = excluded.due_sort, completed_at = excluded.completed_at,
     created_at = excluded.created_at, updated_at = excluded.updated_at, parent_id = excluded.parent_id,
     source_type = excluded.source_type, assignee = excluded.assignee, content_hash = excluded.content_hash,
     decision_outcome = excluded.decision_outcome, decision_at = excluded.decision_at,
     ai_generated = excluded.ai_generated, claim_type = excluded.claim_type, confidence = excluded.confidence`;

/** Removes every row (task, tags, dependencies) of any OTHER note currently holding `path`. */
function clearStalePathHolder(db: Database.Database, path: string, noteId: string): void {
  const holders = db
    .prepare("SELECT note_id FROM task_index WHERE path = @path AND note_id <> @noteId")
    .all({ path, noteId }) as { note_id: string }[];
  for (const holder of holders) {
    db.prepare("DELETE FROM task_tags WHERE note_id = ?").run(holder.note_id);
    db.prepare("DELETE FROM task_deps WHERE note_id = ?").run(holder.note_id);
    db.prepare("DELETE FROM task_index WHERE note_id = ?").run(holder.note_id);
  }
}

function writeValidated(db: Database.Database, validated: ValidatedTask): void {
  const { columns } = validated;
  db.prepare(UPSERT_TASK_SQL).run(columns);
  db.prepare("DELETE FROM task_tags WHERE note_id = ?").run(columns.noteId);
  db.prepare("DELETE FROM task_deps WHERE note_id = ?").run(columns.noteId);
  const insertTag = db.prepare("INSERT INTO task_tags (note_id, tag) VALUES (?, ?)");
  for (const tag of validated.tags) insertTag.run(columns.noteId, tag);
  const insertDep = db.prepare("INSERT INTO task_deps (note_id, dep_id) VALUES (?, ?)");
  for (const dep of validated.dependencies) insertDep.run(columns.noteId, dep);
  upsertVaultNote(db, {
    noteId: columns.noteId as NoteId,
    path: columns.path,
    scope: columns.scope,
    stage: "capture",
    aiGenerated: columns.aiGenerated === "true",
    claimType: columns.claimType as ClaimType | null,
    confidence: columns.confidence as ConfidenceState,
    createdAt: columns.createdAt,
    updatedAt: columns.updatedAt,
    contentHash: columns.contentHash,
  });
}

/**
 * Indexes one task: replaces its task row and its tag and dependency rows and
 * upserts the generic `vault_notes` row for the same note, in ONE transaction.
 * A different note id already holding the path is cleared (the cache is
 * derived), exactly as the generic upsert does. Throws
 * {@link InvalidTaskIndexError} before writing anything for a record outside
 * its domain.
 */
export function upsertTask(db: Database.Database, record: TaskIndexRecord): void {
  const validated = validateTaskRecord(record);
  db.transaction(() => {
    clearStalePathHolder(db, validated.columns.path, validated.columns.noteId);
    writeValidated(db, validated);
  })();
}

// ---------------------------------------------------------------------------
// Reading: SQL fragments (all literal; callers' values are only ever bound)

/** Actionable: not finished and not a suggestion waiting for a decision (D-33 refinement). */
const OPEN = "t.status NOT IN ('done','cancelled','proposed')";
const TODAY_PREDICATE = `${OPEN} AND (t.due_date = @today OR t.sched_date = @today OR (t.due_at >= @s AND t.due_at < @e) OR (t.sched_at >= @s AND t.sched_at < @e))`;
const IS_OVERDUE = "(t.due_date < @today OR t.due_at < @s)";
const UNMET_COUNT =
  "(SELECT COUNT(*) FROM task_deps d LEFT JOIN task_index x ON x.note_id = d.dep_id WHERE d.note_id = t.note_id AND (x.note_id IS NULL OR x.status NOT IN ('done','cancelled')))";

const ROW_COLUMNS = `t.*,
  (SELECT COUNT(*) FROM task_tags g WHERE g.note_id = t.note_id) AS tag_count,
  (SELECT group_concat(tag, char(31)) FROM (SELECT tag FROM task_tags WHERE note_id = t.note_id ORDER BY tag LIMIT 3)) AS tag_list,
  ${UNMET_COUNT} AS unmet_count,
  CASE WHEN ${OPEN} AND ${IS_OVERDUE} THEN 1 ELSE 0 END AS overdue_flag`;

interface TaskRowSql {
  note_id: string;
  path: string;
  scope: string;
  project_id: string | null;
  title: string;
  status: string;
  priority: string | null;
  due_date: string | null;
  due_at: string | null;
  sched_date: string | null;
  sched_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  parent_id: string | null;
  source_type: string | null;
  assignee: string | null;
  content_hash: string | null;
  decision_outcome: string | null;
  decision_at: string | null;
  ai_generated: string;
  claim_type: string | null;
  confidence: string;
  tag_count: number;
  tag_list: string | null;
  unmet_count: number;
  overdue_flag: number;
  [key: `k${number}`]: string | number;
}

function rowToView(row: TaskRowSql): TaskIndexRow {
  return {
    id: row.note_id,
    title: row.title,
    status: row.status as TaskStatus,
    ...(row.priority === null ? {} : { priority: row.priority as TaskPriority }),
    scope: row.scope,
    ...(row.project_id === null ? {} : { projectId: row.project_id }),
    ...(row.due_date === null ? {} : { dueDate: row.due_date }),
    ...(row.due_at === null ? {} : { dueAt: row.due_at }),
    ...(row.sched_date === null ? {} : { scheduledDate: row.sched_date }),
    ...(row.sched_at === null ? {} : { scheduledAt: row.sched_at }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    tags: row.tag_list === null ? [] : row.tag_list.split("\u001f"),
    tagCount: row.tag_count,
    unmetDependencies: row.unmet_count,
    overdue: row.overdue_flag === 1,
    updatedAt: row.updated_at,
  };
}

function rowToDetail(row: TaskRowSql): TaskIndexDetail {
  return {
    ...rowToView(row),
    path: row.path,
    createdAt: row.created_at,
    sourceType: row.source_type ?? "manual",
    ...(row.assignee === null ? {} : { assignee: row.assignee as "user" | "automation" }),
    ...(row.parent_id === null ? {} : { parentId: row.parent_id }),
    contentHash: row.content_hash ?? "",
    ...(row.decision_outcome === null || row.decision_at === null
      ? {}
      : {
          decision: {
            outcome: row.decision_outcome as "accepted" | "dismissed",
            at: row.decision_at,
          },
        }),
    aiGenerated: row.ai_generated === "true",
    claimType: row.claim_type as ClaimType | null,
    confidence: row.confidence as ConfidenceState,
  };
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertDay(day: LocalDayBounds): void {
  if (
    !LOCAL_DATE.test(day.localDate) ||
    !ISO_INSTANT.test(day.startsAt) ||
    !ISO_INSTANT.test(day.endsAt)
  ) {
    throw new InvalidTaskQueryError("day bounds", `${day.localDate} ${day.startsAt}`);
  }
}

function dayParams(day: LocalDayBounds | undefined) {
  return day === undefined
    ? { today: null, s: null, e: null }
    : { today: day.localDate, s: day.startsAt, e: day.endsAt };
}

/** Reads one task's full indexed detail by note id, or null. `day` only affects the overdue flag. */
export function getTask(
  db: Database.Database,
  noteId: string,
  day?: LocalDayBounds,
): TaskIndexDetail | null {
  if (day !== undefined) assertDay(day);
  const row = db
    .prepare(`SELECT ${ROW_COLUMNS} FROM task_index t WHERE t.note_id = @noteId`)
    .get({ noteId, ...dayParams(day) }) as TaskRowSql | undefined;
  return row === undefined ? null : rowToDetail(row);
}

// ---------------------------------------------------------------------------
// Views: one literal predicate and one sort per filter (UI-SPEC "Filter chips")

interface SortKey {
  /** A SQL expression that is never NULL, so a keyset comparison is total. */
  readonly expr: string;
  readonly direction: "ASC" | "DESC";
  readonly kind: "text" | "int";
}

interface ViewDefinition {
  readonly predicate: string;
  readonly keys: readonly SortKey[];
}

const PRIORITY_RANK =
  "CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END";

const DUE_KEY = "COALESCE(t.due_sort, '~')";

/**
 * The earliest FUTURE due or scheduled value, so a task due in the past but
 * scheduled ahead is listed by its schedule. `'~'` sorts after every digit, so a
 * missing value never wins the scalar `min`.
 */
const UPCOMING_KEY =
  "min(COALESCE(CASE WHEN t.due_date > @today THEN t.due_date WHEN t.due_at >= @e THEN t.due_at END, '~'), " +
  "COALESCE(CASE WHEN t.sched_date > @today THEN t.sched_date WHEN t.sched_at >= @e THEN t.sched_at END, '~'))";

const BLOCKED_PREDICATE = `${OPEN} AND (t.status = 'blocked' OR EXISTS (SELECT 1 FROM task_deps d LEFT JOIN task_index x ON x.note_id = d.dep_id WHERE d.note_id = t.note_id AND (x.note_id IS NULL OR x.status NOT IN ('done','cancelled'))))`;

const VIEWS: Readonly<Record<TaskFilter, ViewDefinition>> = {
  all: {
    predicate: "1 = 1",
    keys: [{ expr: "t.updated_at", direction: "DESC", kind: "text" }],
  },
  today: {
    predicate: TODAY_PREDICATE,
    keys: [
      {
        expr: "CASE WHEN t.due_at >= @s AND t.due_at < @e THEN t.due_at WHEN t.sched_at >= @s AND t.sched_at < @e THEN t.sched_at ELSE '~' END",
        direction: "ASC",
        kind: "text",
      },
      { expr: PRIORITY_RANK, direction: "ASC", kind: "int" },
    ],
  },
  upcoming: {
    predicate: `${OPEN} AND (t.due_date > @today OR t.due_at >= @e OR t.sched_date > @today OR t.sched_at >= @e)`,
    keys: [{ expr: UPCOMING_KEY, direction: "ASC", kind: "text" }],
  },
  overdue: {
    predicate: `${OPEN} AND ${IS_OVERDUE}`,
    keys: [{ expr: DUE_KEY, direction: "ASC", kind: "text" }],
  },
  project: {
    predicate: `${OPEN} AND t.project_id IS NOT NULL`,
    keys: [
      { expr: PRIORITY_RANK, direction: "ASC", kind: "int" },
      { expr: DUE_KEY, direction: "ASC", kind: "text" },
    ],
  },
  proposed: {
    predicate: "t.status = 'proposed'",
    keys: [{ expr: "t.created_at", direction: "DESC", kind: "text" }],
  },
  blocked: {
    predicate: BLOCKED_PREDICATE,
    keys: [{ expr: DUE_KEY, direction: "ASC", kind: "text" }],
  },
  completed: {
    predicate: "t.status = 'done'",
    keys: [{ expr: "COALESCE(t.completed_at, t.updated_at)", direction: "DESC", kind: "text" }],
  },
};

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return TASK_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1)
    throw new InvalidTaskQueryError("limit", String(limit));
  return Math.min(limit, TASK_PAGE_SIZE);
}

interface ContextClause {
  readonly sql: string;
  readonly params: Record<string, string>;
}

function contextClause(context: TaskQueryContext): ContextClause {
  const parts: string[] = [];
  const params: Record<string, string> = {};
  if (context.scope !== "all") {
    if (!NOTE_SCOPE_PATTERN.test(context.scope))
      throw new InvalidTaskQueryError("scope", context.scope);
    parts.push("t.scope = @scope");
    params.scope = context.scope;
  }
  if (context.projectId !== undefined) {
    if (!ProjectIdSchema.safeParse(context.projectId).success) {
      throw new InvalidTaskQueryError("project id", context.projectId);
    }
    parts.push("t.project_id = @project");
    params.project = context.projectId;
  }
  return { sql: parts.join(" AND "), params };
}

function decodeCursor(view: ViewDefinition, filter: TaskFilter, cursor: TaskCursor): void {
  if (cursor.filter !== filter) throw new InvalidTaskCursorError("it belongs to another filter");
  if (!Array.isArray(cursor.keys) || cursor.keys.length !== view.keys.length) {
    throw new InvalidTaskCursorError("wrong number of sort keys");
  }
  cursor.keys.forEach((value, index) => {
    const key = view.keys[index];
    if (key === undefined) throw new InvalidTaskCursorError("wrong number of sort keys");
    if (
      key.kind === "text"
        ? typeof value !== "string" || value.length > 64
        : !Number.isInteger(value)
    ) {
      throw new InvalidTaskCursorError("a sort key has the wrong type");
    }
  });
  if (typeof cursor.id !== "string" || !NOTE_ID_PATTERN.test(cursor.id)) {
    throw new InvalidTaskCursorError("the id is not a note id");
  }
}

/** The keyset predicate "strictly after the cursor" for ordered keys plus the id ascending. */
function keysetClause(view: ViewDefinition): string {
  const alternatives: string[] = [];
  view.keys.forEach((key, index) => {
    const equal = view.keys.slice(0, index).map((earlier, j) => `${earlier.expr} = @c${j}`);
    equal.push(`${key.expr} ${key.direction === "ASC" ? ">" : "<"} @c${index}`);
    alternatives.push(`(${equal.join(" AND ")})`);
  });
  const allEqual = view.keys.map((key, j) => `${key.expr} = @c${j}`);
  allEqual.push("t.note_id > @cid");
  alternatives.push(`(${allEqual.join(" AND ")})`);
  return `(${alternatives.join(" OR ")})`;
}

/**
 * One page of a filter in a context, with the total number of rows the filter
 * matches there. Keyset-paginated on the view's sort keys and the note id (as
 * the final tiebreak), so no row is skipped or repeated when rows tie.
 */
export function queryTasks(db: Database.Database, query: TaskQuery): TaskPage {
  if (!(TASK_FILTERS as readonly string[]).includes(query.filter)) {
    throw new InvalidTaskQueryError("filter", String(query.filter));
  }
  assertDay(query.day);
  const limit = clampLimit(query.limit);
  const view = VIEWS[query.filter];
  const context = contextClause(query.context);
  if (query.filter === "project" && query.context.projectId === undefined) {
    // The Project chip needs a project: the page is empty by design and says so.
    return { rows: [], total: 0, nextCursor: null, chooseProject: true };
  }
  const params: Record<string, string | number | null> = {
    ...dayParams(query.day),
    ...context.params,
  };
  const base = [context.sql, view.predicate].filter((part) => part !== "").join(" AND ");

  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM task_index t WHERE ${base}`).get(params) as { n: number }
  ).n;

  let where = base;
  if (query.cursor !== undefined) {
    decodeCursor(view, query.filter, query.cursor);
    where = `${base} AND ${keysetClause(view)}`;
    query.cursor.keys.forEach((value, index) => {
      params[`c${index}`] = value;
    });
    params.cid = query.cursor.id;
  }
  const keyColumns = view.keys.map((key, index) => `${key.expr} AS k${index}`).join(", ");
  const order = [...view.keys.map((key) => `${key.expr} ${key.direction}`), "t.note_id ASC"].join(
    ", ",
  );
  params.fetch = limit + 1;
  const fetched = db
    .prepare(
      `SELECT ${ROW_COLUMNS}, ${keyColumns} FROM task_index t WHERE ${where} ORDER BY ${order} LIMIT @fetch`,
    )
    .all(params) as TaskRowSql[];
  const pageRows = fetched.slice(0, limit);
  const last = pageRows[pageRows.length - 1];
  const nextCursor: TaskCursor | null =
    fetched.length > limit && last !== undefined
      ? {
          filter: query.filter,
          keys: view.keys.map((_key, index) => last[`k${index}`] as string | number),
          id: last.note_id,
        }
      : null;
  return {
    rows: pageRows.map(rowToView),
    total,
    nextCursor,
    chooseProject: false,
  };
}

/** Every chip's count and the open total for one context and day. */
export interface TaskCounts {
  readonly counts: Readonly<Record<TaskFilter, number>>;
  /** Actionable tasks: not done, cancelled or proposed. */
  readonly open: number;
}

/**
 * Every chip count and the open total for one context, from ONE statement: a
 * single `SELECT` of conditional sums over the same scope and project clause the
 * list uses, with the same day bounds, so a chip can never disagree with its list
 * (UI-SPEC R-11, D-34). With a project in the context every count is narrowed to
 * that project; the `project` chip is then the open tasks of that project.
 */
export function countTasks(
  db: Database.Database,
  query: { readonly context: TaskQueryContext; readonly day: LocalDayBounds },
): TaskCounts {
  assertDay(query.day);
  const context = contextClause(query.context);
  const sums = TASK_FILTERS.filter((filter) => filter !== "all")
    .map(
      (filter) =>
        `COALESCE(SUM(CASE WHEN ${VIEWS[filter].predicate} THEN 1 ELSE 0 END), 0) AS c_${filter}`,
    )
    .join(", ");
  const where = context.sql === "" ? "" : ` WHERE ${context.sql}`;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c_all, ${sums}, COALESCE(SUM(CASE WHEN ${OPEN} THEN 1 ELSE 0 END), 0) AS c_open FROM task_index t${where}`,
    )
    .get({ ...dayParams(query.day), ...context.params }) as Record<string, number>;
  const count = (key: string): number => row[key] ?? 0;
  return {
    counts: {
      all: count("c_all"),
      today: count("c_today"),
      upcoming: count("c_upcoming"),
      overdue: count("c_overdue"),
      project: count("c_project"),
      proposed: count("c_proposed"),
      blocked: count("c_blocked"),
      completed: count("c_completed"),
    },
    open: count("c_open"),
  };
}

/** A feed row: the task id, its title and the date values it carries. */
export interface TaskDueTodayRow {
  readonly taskId: string;
  readonly title: string;
  readonly dueDate?: string;
  readonly dueAt?: string;
  readonly scheduledDate?: string;
  readonly scheduledAt?: string;
}

/** A dependency that is not finished: a task with its title and status, or an id naming no task. */
export type TaskBlockedByItem =
  | {
      readonly resolved: true;
      readonly id: string;
      readonly title: string;
      readonly status: TaskStatus;
    }
  | { readonly resolved: false; readonly id: string };

/** RED skeletons (plan 06-14 task 3). */
export function rebuildTaskIndex(
  _db: Database.Database,
  _records: readonly TaskIndexRecord[],
): void {}
export function removeTaskByPath(_db: Database.Database, _path: string): boolean {
  return false;
}
export function getTaskByPath(
  _db: Database.Database,
  _path: string,
  _day?: LocalDayBounds,
): TaskIndexDetail | null {
  return null;
}
export function blockedBy(_db: Database.Database, _noteId: string): TaskBlockedByItem[] {
  return [];
}
export function listDueToday(
  _db: Database.Database,
  _query: { readonly day: LocalDayBounds; readonly scope?: string },
): { readonly due: TaskDueTodayRow[]; readonly overdue: TaskDueTodayRow[] } {
  return { due: [], overdue: [] };
}
