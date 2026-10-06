import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type LocalDayBounds,
  localDayBounds,
  normaliseDue,
  TASK_FILTERS,
  type TaskFilter,
  TaskRowSchema,
} from "@ccc/domain";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations } from "./migrate.js";
import {
  countTasks,
  getTask,
  InvalidTaskCursorError,
  InvalidTaskIndexError,
  InvalidTaskQueryError,
  queryTasks,
  type TaskCursor,
  type TaskIndexRecord,
  upsertTask,
} from "./task-index-store.js";
import {
  columnNames,
  openMigratedFileDb,
  REAL_MIGRATIONS_DIR,
  triggerNames,
} from "./test-support/migration-helper.js";
import {
  fixtureId,
  generateSyntheticTasks,
  makeTaskRecord,
  SYNTHETIC_PROJECT_IDS,
  SYNTHETIC_TASK_NOW,
  SYNTHETIC_TASK_ZONE,
  syntheticScopes,
} from "./test-support/synthetic-tasks.js";
import { getVaultNote } from "./vault-notes-store.js";

const WORKSPACE_A = "workspace:aaaaaaaaa0123456789abcdef";
const DAY = localDayBounds(SYNTHETIC_TASK_NOW, SYNTHETIC_TASK_ZONE);

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccc-task-index-"));
  db = openMigratedFileDb(join(dir, "operational.db"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function tableNames(): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
  ).map((row) => row.name);
}

function indexNames(table: string): string[] {
  return (
    db.prepare(`SELECT name FROM pragma_index_list('${table}')`).all() as { name: string }[]
  ).map((row) => row.name);
}

const APPROVAL_TRIGGERS = [
  "approval_audit_no_delete",
  "approval_audit_no_replace",
  "approval_audit_no_update",
  "proposals_identity_immutable",
  "proposals_no_delete",
  "proposals_no_replace",
  "proposals_payload_purge_only",
  "proposals_transition_guard",
];

describe("Test 1: the task index migration", () => {
  it("applies every migration to a fresh file-backed database and creates the three tables and their indexes", () => {
    expect(tableNames()).toEqual(expect.arrayContaining(["task_index", "task_tags", "task_deps"]));
    expect(indexNames("task_index")).toEqual(
      expect.arrayContaining([
        "task_scope_status_idx",
        "task_project_status_idx",
        "task_due_date_idx",
        "task_due_at_idx",
        "task_sched_date_idx",
        "task_sched_at_idx",
      ]),
    );
    expect(indexNames("task_deps")).toContain("task_deps_dep_idx");
  });

  it("is a no-op the second time and leaves the schema version at the migration count", () => {
    const files = readdirSync(REAL_MIGRATIONS_DIR).filter((name) => name.endsWith(".sql"));
    const before = db.prepare("SELECT version FROM schema_version").get();
    expect(before).toEqual({ version: files.length });
    applyMigrations(db, REAL_MIGRATIONS_DIR);
    expect(db.prepare("SELECT version FROM schema_version").get()).toEqual(before);
  });

  it("keeps every approvals trigger", () => {
    expect(triggerNames(db)).toEqual(APPROVAL_TRIGGERS);
  });
});

describe("Test 2: the index holds filter keys, never note content", () => {
  const FORBIDDEN = /^(body|description|content|excerpt|text|markdown)$/i;

  it("has no body-like column on any of the three tables", () => {
    for (const table of ["task_index", "task_tags", "task_deps"]) {
      const columns = columnNames(db, table);
      expect(columns.length).toBeGreaterThan(0);
      expect(columns.filter((name) => FORBIDDEN.test(name))).toEqual([]);
    }
  });

  const INSERT_BASE = `INSERT INTO task_index
    (note_id, path, scope, title, status, due_date, due_at, sched_date, sched_at, created_at, updated_at, content_hash, ai_generated, confidence)
    VALUES (@id, @path, 'global', 'T', 'ready', @dueDate, @dueAt, @schedDate, @schedAt, 'c', 'u', 'h', 'false', 'unverified')`;

  function insert(extra: Record<string, string | null>) {
    return () =>
      db.prepare(INSERT_BASE).run({
        id: fixtureId(1),
        path: "global/tasks/a.md",
        dueDate: null,
        dueAt: null,
        schedDate: null,
        schedAt: null,
        ...extra,
      });
  }

  it("rejects a row with both a due date and a due instant", () => {
    expect(insert({ dueDate: "2026-10-05", dueAt: "2026-10-05T10:00:00.000Z" })).toThrow(
      /CHECK constraint/,
    );
  });

  it("rejects a row with both a scheduled date and a scheduled instant", () => {
    expect(insert({ schedDate: "2026-10-05", schedAt: "2026-10-05T10:00:00.000Z" })).toThrow(
      /CHECK constraint/,
    );
  });

  it("accepts one of each shape", () => {
    expect(insert({ dueDate: "2026-10-05", schedAt: "2026-10-05T10:00:00.000Z" })).not.toThrow();
  });
});

describe("Test 3: upsertTask", () => {
  it("inserts the task with its tags and dependencies and a generic vault_notes row for the same note", () => {
    const id = fixtureId(1);
    upsertTask(
      db,
      makeTaskRecord({
        noteId: id,
        title: "Draft the weekly review",
        priority: "high",
        due: "2026-10-09",
        tags: ["writing", "review"],
        dependencies: [fixtureId(2), fixtureId(3)],
        contentHash: "a".repeat(64),
      }),
    );
    const task = getTask(db, id, DAY);
    expect(task).toMatchObject({
      id,
      title: "Draft the weekly review",
      priority: "high",
      dueDate: "2026-10-09",
      tagCount: 2,
      unmetDependencies: 2,
    });
    expect(task?.tags).toEqual(["review", "writing"]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM task_tags").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM task_deps").get()).toEqual({ n: 2 });
    const note = getVaultNote(db, id as never);
    expect(note).toMatchObject({
      scope: "global",
      stage: "capture",
      path: `global/tasks/synthetic-task-${id.slice(-8)}.md`,
      contentHash: "a".repeat(64),
    });
  });

  it("replaces the task, tag and dependency rows on a second call, with no duplicates, and updates vault_notes", () => {
    const id = fixtureId(1);
    upsertTask(
      db,
      makeTaskRecord({
        noteId: id,
        tags: ["a", "b"],
        dependencies: [fixtureId(2)],
        due: "2026-10-09",
      }),
    );
    upsertTask(
      db,
      makeTaskRecord({
        noteId: id,
        title: "Renamed",
        status: "in-progress",
        tags: ["b", "c"],
        dependencies: [fixtureId(3)],
        due: "2026-10-12T14:00:00-04:00",
        updatedAt: "2026-09-02T00:00:00.000Z",
        contentHash: "b".repeat(64),
      }),
    );
    expect(db.prepare("SELECT COUNT(*) AS n FROM task_index").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT tag FROM task_tags ORDER BY tag").all()).toEqual([
      { tag: "b" },
      { tag: "c" },
    ]);
    expect(db.prepare("SELECT dep_id FROM task_deps").all()).toEqual([{ dep_id: fixtureId(3) }]);
    const task = getTask(db, id, DAY);
    expect(task).toMatchObject({ title: "Renamed", status: "in-progress" });
    expect(task?.dueDate).toBeUndefined();
    expect(task?.dueAt).toBe("2026-10-12T18:00:00.000Z");
    expect(getVaultNote(db, id as never)).toMatchObject({
      updatedAt: "2026-09-02T00:00:00.000Z",
      contentHash: "b".repeat(64),
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM vault_notes").get()).toEqual({ n: 1 });
  });

  it("lets a different note id claim a path by clearing the stale holder, tags and dependencies included", () => {
    const first = fixtureId(1);
    const second = fixtureId(2);
    const shared = "global/tasks/shared-name.md";
    upsertTask(
      db,
      makeTaskRecord({ noteId: first, path: shared, tags: ["old"], dependencies: [fixtureId(9)] }),
    );
    upsertTask(db, makeTaskRecord({ noteId: second, path: shared, tags: ["new"] }));
    expect(db.prepare("SELECT note_id FROM task_index").all()).toEqual([{ note_id: second }]);
    expect(db.prepare("SELECT note_id, tag FROM task_tags").all()).toEqual([
      { note_id: second, tag: "new" },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM task_deps").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT note_id FROM vault_notes").all()).toEqual([{ note_id: second }]);
  });
});

describe("Test 4: the enum and shape boundary", () => {
  const cases: [string, Partial<Parameters<typeof makeTaskRecord>[0]>][] = [
    ["an unknown status", { status: "archived" as never }],
    ["an unknown priority", { priority: "critical" as never }],
    ["an unknown scope", { scope: "workspace:short" }],
    ["a scope that does not match the path", { scope: WORKSPACE_A, path: "global/tasks/x.md" }],
    ["a title with a newline", { title: "two\nlines" }],
    ["a due value that is neither a date nor an instant", { due: "next tuesday" }],
    ["an offset-less due datetime", { due: "2026-10-05T10:00:00" }],
    ["a content hash that is not a SHA-256", { contentHash: "abc" }],
    ["a path that is not a task note path", { path: "global/wiki/a.md" }],
    ["an invalid tag", { tags: ["has space"] }],
    ["a dependency that is not a note id", { dependencies: ["../etc/passwd"] }],
  ];

  it.each(cases)("throws a typed error and writes nothing for %s", (_label, overrides) => {
    expect(() => upsertTask(db, makeTaskRecord({ noteId: fixtureId(1), ...overrides }))).toThrow(
      InvalidTaskIndexError,
    );
    for (const table of ["task_index", "task_tags", "task_deps", "vault_notes"]) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
  });
});

describe("Test 5: the Today list in a fixed zone and clock", () => {
  it("returns exactly the open tasks due or scheduled in the local day", () => {
    // Fixed clock: 2026-10-05 12:00 in New York. The local day is 04:00Z to 04:00Z next day.
    expect(DAY).toEqual({
      localDate: "2026-10-05",
      startsAt: "2026-10-05T04:00:00.000Z",
      endsAt: "2026-10-06T04:00:00.000Z",
    });
    const put = (n: number, overrides: Partial<Parameters<typeof makeTaskRecord>[0]>) =>
      upsertTask(db, makeTaskRecord({ noteId: fixtureId(n), title: `Task ${n}`, ...overrides }));
    put(1, { due: "2026-10-05" }); // all-day today: in
    put(2, { due: "2026-10-05T20:00:00Z" }); // 16:00 local: in
    put(3, { due: "2026-10-06" }); // tomorrow: out
    put(4, { scheduled: "2026-10-05" }); // scheduled today: in
    put(5, { status: "done", due: "2026-10-05", completed: "2026-10-05T12:00:00Z" }); // done: out
    put(6, { due: "2026-10-06T03:30:00Z" }); // 23:30 local on the 5th: in
    put(7, { due: "2026-10-06T04:30:00Z" }); // 00:30 local on the 6th: out
    put(8, { status: "cancelled", due: "2026-10-05" }); // cancelled: out
    put(9, { status: "proposed", due: "2026-10-05" }); // proposed: out
    put(10, { scheduled: "2026-10-05T14:00:00-04:00" }); // 14:00 local: in
    put(11, { due: "2026-10-04" }); // yesterday: out

    const page = queryTasks(db, { context: { scope: "all" }, filter: "today", day: DAY });
    expect(page.rows.map((row) => row.id).sort()).toEqual(
      [1, 2, 4, 6, 10].map((n) => fixtureId(n)).sort(),
    );
    expect(page.total).toBe(5);
    expect(page.nextCursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Task 2: every view, one-pass counts, keyset pagination, dependency-aware blocking

const WORKSPACE_B = "workspace:bbbbbbbbb0123456789abcdef";
const P1 = SYNTHETIC_PROJECT_IDS[0] as string;
const P2 = SYNTHETIC_PROJECT_IDS[1] as string;

function put(n: number, overrides: Partial<TaskIndexRecord> = {}): TaskIndexRecord {
  const record = makeTaskRecord({ noteId: fixtureId(n), title: `Task ${n}`, ...overrides });
  upsertTask(db, record);
  return record;
}

function ids(...numbers: number[]): string[] {
  return numbers.map((n) => fixtureId(n));
}

/** Every id a filter returns, paging through the keyset until the end. */
function allIds(
  filter: TaskFilter,
  context: { scope: string; projectId?: string } = { scope: "all" },
  day: LocalDayBounds = DAY,
  limit?: number,
): string[] {
  const out: string[] = [];
  let cursor: TaskCursor | undefined;
  for (let guard = 0; guard < 1000; guard++) {
    const page = queryTasks(db, {
      context,
      filter,
      day,
      ...(cursor === undefined ? {} : { cursor }),
      ...(limit === undefined ? {} : { limit }),
    });
    out.push(...page.rows.map((row) => row.id));
    if (page.nextCursor === null) return out;
    cursor = page.nextCursor;
  }
  throw new Error("paging did not terminate");
}

function putPredicateFixture(): void {
  put(1, { due: "2026-10-05", priority: "high", projectId: P1 }); // all-day today
  put(2, { due: "2026-10-05T20:00:00Z", priority: "urgent", projectId: P1 }); // 16:00 local
  put(3, { due: "2026-10-07", priority: "medium" }); // upcoming
  put(4, { due: "2026-10-04", priority: "low", projectId: P2 }); // overdue by date
  put(5, { due: "2026-10-05T03:00:00Z" }); // 23:00 local on the 4th: overdue by instant
  put(6, { status: "inbox" });
  put(7, { status: "proposed", due: "2026-10-05", projectId: P1, dependencies: ids(10) });
  put(8, { status: "blocked", due: "2026-10-10" });
  put(9, { dependencies: ids(10) }); // unmet: 10 is not done
  put(10, {});
  put(11, { dependencies: ids(12, 13) }); // met: done and cancelled
  put(12, { status: "done", due: "2026-10-05", completed: "2026-10-05T10:00:00Z", projectId: P1 });
  put(13, { status: "cancelled", due: "2026-10-05" });
  put(14, { dependencies: ids(99) }); // dangling: unmet
  put(15, { scheduled: "2026-10-06T14:00:00Z" }); // upcoming by instant
  put(16, { scheduled: "2026-10-05" }); // today by schedule
}

describe("Filters 1: the eight views return exactly the expected ids", () => {
  it("answers each view from a fixture covering every status, date shape and dependency state", () => {
    putPredicateFixture();
    const expected: Record<Exclude<TaskFilter, "project">, string[]> = {
      all: ids(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16),
      today: ids(1, 2, 16),
      upcoming: ids(3, 8, 15),
      overdue: ids(4, 5),
      proposed: ids(7),
      blocked: ids(8, 9, 14),
      completed: ids(12),
    };
    for (const [filter, want] of Object.entries(expected)) {
      const got = allIds(filter as TaskFilter);
      expect({ filter, ids: [...got].sort() }).toEqual({ filter, ids: [...want].sort() });
    }
  });

  it("project requires a project id: none gives an empty page that asks for one", () => {
    putPredicateFixture();
    const none = queryTasks(db, { context: { scope: "all" }, filter: "project", day: DAY });
    expect(none).toMatchObject({ rows: [], total: 0, nextCursor: null, chooseProject: true });
    expect(allIds("project", { scope: "all", projectId: P1 }).sort()).toEqual(ids(1, 2));
    expect(allIds("project", { scope: "all", projectId: P2 })).toEqual(ids(4));
  });

  it("keeps a proposed task with a due date, a project and an unmet dependency out of every actionable view", () => {
    putPredicateFixture();
    const proposed = fixtureId(7);
    for (const filter of ["today", "upcoming", "overdue", "blocked", "completed"] as const) {
      expect(allIds(filter)).not.toContain(proposed);
    }
    expect(allIds("project", { scope: "all", projectId: P1 })).not.toContain(proposed);
    expect(allIds("proposed")).toContain(proposed);
    expect(allIds("all")).toContain(proposed);
    const counts = countTasks(db, { context: { scope: "all" }, day: DAY });
    expect(counts.counts).toMatchObject({ today: 3, overdue: 2, blocked: 3, proposed: 1 });
  });

  it("shows a cancelled task only under All", () => {
    putPredicateFixture();
    const cancelled = fixtureId(13);
    for (const filter of TASK_FILTERS.filter((f) => f !== "all" && f !== "project")) {
      expect(allIds(filter)).not.toContain(cancelled);
    }
    expect(allIds("all")).toContain(cancelled);
  });

  it("treats a dependency on a done or cancelled task as met and a missing one as unmet", () => {
    putPredicateFixture();
    expect(allIds("blocked")).not.toContain(fixtureId(11));
    expect(allIds("blocked")).toContain(fixtureId(14));
    const row = queryTasks(db, {
      context: { scope: "all" },
      filter: "blocked",
      day: DAY,
    }).rows.find((r) => r.id === fixtureId(14));
    expect(row?.unmetDependencies).toBe(1);
  });

  it("rejects an unknown filter and a malformed day", () => {
    expect(() =>
      queryTasks(db, { context: { scope: "all" }, filter: "someday" as never, day: DAY }),
    ).toThrow(InvalidTaskQueryError);
    expect(() =>
      queryTasks(db, {
        context: { scope: "all" },
        filter: "today",
        day: { localDate: "today", startsAt: "x", endsAt: "y" },
      }),
    ).toThrow(InvalidTaskQueryError);
  });
});

describe("Filters 2: day boundaries on a fixed clock and zone", () => {
  function dayFor(iso: string, zone: string): LocalDayBounds {
    return localDayBounds(new Date(iso), zone);
  }

  it("lands the spring-forward day (23 hours) correctly, in instants and in dates", () => {
    const day = dayFor("2026-03-08T17:00:00Z", "America/New_York");
    expect(day).toEqual({
      localDate: "2026-03-08",
      startsAt: "2026-03-08T05:00:00.000Z",
      endsAt: "2026-03-09T04:00:00.000Z",
    });
    put(1, { due: "2026-03-09T03:59:00Z" }); // 23:59 local on the 8th: today
    put(2, { due: "2026-03-09T04:00:00Z" }); // midnight local on the 9th: upcoming
    put(3, { due: "2026-03-08T04:59:00Z" }); // 23:59 local on the 7th: overdue
    put(4, { due: "2026-03-08T05:00:00Z" }); // midnight local on the 8th: today
    put(5, { due: "2026-03-07" });
    put(6, { due: "2026-03-08" });
    put(7, { due: "2026-03-09" });
    expect(allIds("today", { scope: "all" }, day).sort()).toEqual(ids(1, 4, 6));
    expect(allIds("overdue", { scope: "all" }, day).sort()).toEqual(ids(3, 5));
    expect(allIds("upcoming", { scope: "all" }, day).sort()).toEqual(ids(2, 7));
  });

  it("lands the fall-back day (25 hours) correctly", () => {
    const day = dayFor("2026-11-01T17:00:00Z", "America/New_York");
    expect(day).toEqual({
      localDate: "2026-11-01",
      startsAt: "2026-11-01T04:00:00.000Z",
      endsAt: "2026-11-02T05:00:00.000Z",
    });
    put(1, { due: "2026-11-02T04:59:00Z" }); // 23:59 EST on the 1st: today
    put(2, { due: "2026-11-02T05:00:00Z" }); // midnight on the 2nd: upcoming
    put(3, { due: "2026-11-01T03:59:00Z" }); // 23:59 EDT on Oct 31: overdue
    put(4, { due: "2026-11-01T04:00:00Z" }); // midnight EDT on the 1st: today
    expect(allIds("today", { scope: "all" }, day).sort()).toEqual(ids(1, 4));
    expect(allIds("overdue", { scope: "all" }, day)).toEqual(ids(3));
    expect(allIds("upcoming", { scope: "all" }, day)).toEqual(ids(2));
  });

  it("never moves an all-day task when the same data is queried in a different zone", () => {
    put(1, { due: "2026-10-05" }); // all-day
    put(2, { due: "2026-10-05T20:00:00Z" }); // an instant: 16:00 in New York, the 6th in Auckland
    // 10:00Z is still the 5th in both New York (06:00) and Auckland (23:00).
    const newYork = dayFor("2026-10-05T10:00:00Z", "America/New_York");
    const auckland = dayFor("2026-10-05T10:00:00Z", "Pacific/Auckland");
    expect(newYork.localDate).toBe("2026-10-05");
    expect(auckland.localDate).toBe("2026-10-05");
    expect(allIds("today", { scope: "all" }, newYork).sort()).toEqual(ids(1, 2));
    expect(allIds("today", { scope: "all" }, auckland)).toEqual(ids(1));
    expect(allIds("upcoming", { scope: "all" }, auckland)).toEqual(ids(2));
    const stored = db
      .prepare("SELECT due_date, due_at FROM task_index WHERE note_id = ?")
      .get(fixtureId(1));
    expect(stored).toEqual({ due_date: "2026-10-05", due_at: null });
  });
});

describe("Filters 3: scope", () => {
  function putScoped(): void {
    put(1, { due: "2026-10-05" }); // global
    put(2, { due: "2026-10-05", scope: WORKSPACE_A, projectId: P1 });
    put(3, { due: "2026-10-05", scope: WORKSPACE_A, projectId: P2 });
    put(4, { due: "2026-10-05", scope: WORKSPACE_B, projectId: P1 });
    put(5, { due: "2026-10-04", scope: WORKSPACE_A, projectId: P1 });
  }

  it("returns each scope's own rows only, and its counts follow", () => {
    putScoped();
    expect(allIds("today", { scope: "all" }).sort()).toEqual(ids(1, 2, 3, 4));
    expect(allIds("today", { scope: "global" })).toEqual(ids(1));
    expect(allIds("today", { scope: WORKSPACE_A }).sort()).toEqual(ids(2, 3));
    expect(allIds("today", { scope: WORKSPACE_B })).toEqual(ids(4));
    for (const scope of ["all", "global", WORKSPACE_A, WORKSPACE_B]) {
      const { counts } = countTasks(db, { context: { scope }, day: DAY });
      for (const filter of [
        "all",
        "today",
        "upcoming",
        "overdue",
        "proposed",
        "blocked",
        "completed",
      ] as const) {
        expect(counts[filter]).toBe(allIds(filter, { scope }).length);
      }
    }
  });

  it("intersects a project with a workspace scope", () => {
    putScoped();
    expect(allIds("project", { scope: WORKSPACE_A, projectId: P1 }).sort()).toEqual(ids(2, 5));
    expect(allIds("project", { scope: WORKSPACE_B, projectId: P1 })).toEqual(ids(4));
    expect(allIds("project", { scope: "global", projectId: P1 })).toEqual([]);
    expect(allIds("today", { scope: WORKSPACE_A, projectId: P1 })).toEqual(ids(2));
  });

  it("refuses a malformed scope or project instead of building SQL from it", () => {
    expect(() =>
      queryTasks(db, { context: { scope: "x' OR '1'='1" }, filter: "all", day: DAY }),
    ).toThrow(InvalidTaskQueryError);
    expect(() =>
      queryTasks(db, { context: { scope: "all", projectId: "../x" }, filter: "all", day: DAY }),
    ).toThrow(InvalidTaskQueryError);
  });
});

describe("Filters 4: counts come from one statement and equal the list sizes", () => {
  it("prepares exactly one statement and returns every chip count, the open total and the rest", () => {
    putPredicateFixture();
    const spy = vi.spyOn(db, "prepare");
    const result = countTasks(db, { context: { scope: "all" }, day: DAY });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    expect(result).toEqual({
      counts: {
        all: 16,
        today: 3,
        upcoming: 3,
        overdue: 2,
        project: 3, // open tasks with any project: 1, 2, 4
        proposed: 1,
        blocked: 3,
        completed: 1,
      },
      open: 13,
    });
  });

  it("agrees with the list totals for every chip that shares a predicate", () => {
    putPredicateFixture();
    const { counts } = countTasks(db, { context: { scope: "all" }, day: DAY });
    for (const filter of TASK_FILTERS.filter((f) => f !== "project")) {
      const page = queryTasks(db, { context: { scope: "all" }, filter, day: DAY });
      expect({ filter, total: page.total }).toEqual({ filter, total: counts[filter] });
    }
  });

  it("returns zeros for an empty index", () => {
    expect(countTasks(db, { context: { scope: "all" }, day: DAY })).toEqual({
      counts: {
        all: 0,
        today: 0,
        upcoming: 0,
        overdue: 0,
        project: 0,
        proposed: 0,
        blocked: 0,
        completed: 0,
      },
      open: 0,
    });
  });
});

describe("Filters 5: two contexts are independent", () => {
  it("returns separate counts for a global context and a project-fixed context over the same data", () => {
    putPredicateFixture();
    const global = countTasks(db, { context: { scope: "all" }, day: DAY });
    const panel = countTasks(db, { context: { scope: "all", projectId: P1 }, day: DAY });
    expect(panel.counts).toMatchObject({ all: 4, today: 2, completed: 1, proposed: 1, project: 2 });
    expect(panel.open).toBe(2);
    // Asking the panel did not change the global answer.
    expect(countTasks(db, { context: { scope: "all" }, day: DAY })).toEqual(global);
    // The panel's list and its counts agree.
    expect(
      queryTasks(db, { context: { scope: "all", projectId: P1 }, filter: "today", day: DAY }).total,
    ).toBe(panel.counts.today);
  });
});

describe("Filters 6: each view sorts as the UI-SPEC table says", () => {
  it("All: updated time, newest first", () => {
    put(1, { updatedAt: "2026-09-01T00:00:00Z" });
    put(2, { updatedAt: "2026-09-03T00:00:00Z" });
    put(3, { updatedAt: "2026-09-02T00:00:00Z" });
    expect(allIds("all")).toEqual(ids(2, 3, 1));
  });

  it("Today: time of day, then priority urgent first, all-day last", () => {
    put(1, { due: "2026-10-05T20:00:00Z", priority: "urgent" });
    put(2, { due: "2026-10-05T14:00:00Z", priority: "low" });
    put(3, { scheduled: "2026-10-05T14:00:00Z", priority: "urgent" });
    put(4, { due: "2026-10-05", priority: "urgent" });
    put(5, { due: "2026-10-05", priority: "low" });
    put(6, { due: "2026-10-05" });
    expect(allIds("today")).toEqual(ids(3, 2, 1, 4, 5, 6));
  });

  it("Upcoming: soonest first, a date before an instant on the same day", () => {
    put(1, { due: "2026-10-09" });
    put(2, { due: "2026-10-08T15:00:00Z" });
    put(3, { due: "2026-10-08" });
    put(4, { scheduled: "2026-10-07" });
    put(5, { due: "2026-10-01", scheduled: "2026-10-12" }); // listed by its future schedule
    expect(allIds("upcoming")).toEqual(ids(4, 3, 2, 1, 5));
  });

  it("Overdue: due date, oldest first", () => {
    put(1, { due: "2026-10-03" });
    put(2, { due: "2026-10-01" });
    put(3, { due: "2026-10-02T12:00:00Z" });
    expect(allIds("overdue")).toEqual(ids(2, 3, 1));
  });

  it("Project: priority, then due, undated last", () => {
    put(1, { projectId: P1, priority: "urgent", due: "2026-10-09" });
    put(2, { projectId: P1, priority: "urgent" });
    put(3, { projectId: P1, priority: "high", due: "2026-10-01" });
    put(4, { projectId: P1, due: "2026-10-02" });
    put(5, { projectId: P1, priority: "urgent", due: "2026-10-03" });
    expect(allIds("project", { scope: "all", projectId: P1 })).toEqual(ids(5, 1, 2, 3, 4));
  });

  it("Proposed: created time, newest first", () => {
    put(1, { status: "proposed", createdAt: "2026-09-01T00:00:00Z" });
    put(2, { status: "proposed", createdAt: "2026-09-03T00:00:00Z" });
    put(3, { status: "proposed", createdAt: "2026-09-02T00:00:00Z" });
    expect(allIds("proposed")).toEqual(ids(2, 3, 1));
  });

  it("Blocked: due soonest, undated last", () => {
    put(1, { status: "blocked" });
    put(2, { status: "blocked", due: "2026-10-09" });
    put(3, { status: "blocked", due: "2026-10-07" });
    expect(allIds("blocked")).toEqual(ids(3, 2, 1));
  });

  it("Completed: completed time, newest first, falling back to the updated time", () => {
    put(1, { status: "done", completed: "2026-10-01T00:00:00Z" });
    put(2, { status: "done", completed: "2026-10-03T00:00:00Z" });
    put(3, { status: "done", updatedAt: "2026-10-02T00:00:00Z" }); // no completed key
    expect(allIds("completed")).toEqual(ids(2, 3, 1));
  });

  it("breaks every tie on the note id", () => {
    for (const n of [5, 3, 4, 1, 2]) put(n, { updatedAt: "2026-09-01T00:00:00Z" });
    expect(allIds("all")).toEqual(ids(1, 2, 3, 4, 5));
  });
});

// An independent oracle: the same predicates and sorts written over plain records.
function oracle(
  records: readonly TaskIndexRecord[],
  filter: TaskFilter,
  context: { scope: string; projectId?: string },
  day: LocalDayBounds,
): string[] {
  const byId = new Map(records.map((r) => [r.noteId, r]));
  const inDay = (v: string | null) => v !== null && v >= day.startsAt && v < day.endsAt;
  const parts = (value: string | undefined) => {
    const n = value === undefined ? null : normaliseDue(value);
    return { date: n?.date ?? null, instant: n?.instant ?? null };
  };
  const open = (r: TaskIndexRecord) => !["done", "cancelled", "proposed"].includes(r.status);
  const rank = (r: TaskIndexRecord) =>
    r.priority === undefined ? 4 : ["urgent", "high", "medium", "low"].indexOf(r.priority);
  const dueSort = (r: TaskIndexRecord) => {
    const d = parts(r.due);
    return d.instant ?? d.date ?? "~";
  };
  const tod = (r: TaskIndexRecord) => {
    const d = parts(r.due);
    const s = parts(r.scheduled);
    if (inDay(d.instant)) return d.instant as string;
    if (inDay(s.instant)) return s.instant as string;
    return "~";
  };
  const upcomingKey = (r: TaskIndexRecord) => {
    const d = parts(r.due);
    const s = parts(r.scheduled);
    const future = (p: { date: string | null; instant: string | null }) =>
      p.date !== null && p.date > day.localDate
        ? p.date
        : p.instant !== null && p.instant >= day.endsAt
          ? p.instant
          : null;
    const candidates = [future(d), future(s)].filter((v): v is string => v !== null).sort();
    return candidates[0] ?? "~";
  };
  const unmet = (r: TaskIndexRecord) =>
    r.dependencies.some((dep) => {
      const target = byId.get(dep);
      return target === undefined || !["done", "cancelled"].includes(target.status);
    });
  const matches: Record<TaskFilter, (r: TaskIndexRecord) => boolean> = {
    all: () => true,
    today: (r) => {
      const d = parts(r.due);
      const s = parts(r.scheduled);
      return (
        open(r) &&
        (d.date === day.localDate ||
          s.date === day.localDate ||
          inDay(d.instant) ||
          inDay(s.instant))
      );
    },
    overdue: (r) => {
      const d = parts(r.due);
      return (
        open(r) &&
        ((d.date !== null && d.date < day.localDate) ||
          (d.instant !== null && d.instant < day.startsAt))
      );
    },
    upcoming: (r) => open(r) && upcomingKey(r) !== "~",
    project: (r) => open(r) && r.projectId !== undefined,
    proposed: (r) => r.status === "proposed",
    blocked: (r) => open(r) && (r.status === "blocked" || unmet(r)),
    completed: (r) => r.status === "done",
  };
  const compare = (a: TaskIndexRecord, b: TaskIndexRecord): number => {
    const byKeys = (pairs: [string | number, string | number][]): number => {
      for (const [x, y] of pairs) if (x !== y) return x < y ? -1 : 1;
      return 0;
    };
    const iso = (v: string) => new Date(v).toISOString();
    let c = 0;
    switch (filter) {
      case "all":
        c = byKeys([[iso(b.updatedAt), iso(a.updatedAt)]]);
        break;
      case "today":
        c = byKeys([
          [tod(a), tod(b)],
          [rank(a), rank(b)],
        ]);
        break;
      case "upcoming":
        c = byKeys([[upcomingKey(a), upcomingKey(b)]]);
        break;
      case "overdue":
        c = byKeys([[dueSort(a), dueSort(b)]]);
        break;
      case "project":
        c = byKeys([
          [rank(a), rank(b)],
          [dueSort(a), dueSort(b)],
        ]);
        break;
      case "proposed":
        c = byKeys([[iso(b.createdAt), iso(a.createdAt)]]);
        break;
      case "blocked":
        c = byKeys([[dueSort(a), dueSort(b)]]);
        break;
      case "completed":
        c = byKeys([[iso(b.completed ?? b.updatedAt), iso(a.completed ?? a.updatedAt)]]);
        break;
    }
    return c !== 0 ? c : a.noteId < b.noteId ? -1 : 1;
  };
  return records
    .filter((r) => context.scope === "all" || r.scope === context.scope)
    .filter((r) => context.projectId === undefined || r.projectId === context.projectId)
    .filter(matches[filter])
    .sort(compare)
    .map((r) => r.noteId);
}

describe("Filters 7: keyset pages return every row exactly once, in order, with ties", () => {
  it.each(TASK_FILTERS)(
    "pages the %s view in fives through ties and matches the oracle",
    (filter) => {
      const records = generateSyntheticTasks(300);
      for (const record of records) upsertTask(db, record);
      const context = filter === "project" ? { scope: "all", projectId: P1 } : { scope: "all" };
      const want = oracle(records, filter, context, DAY);
      expect(want.length).toBeGreaterThan(0);
      expect(allIds(filter, context, DAY, 5)).toEqual(want);
      // Page size 25 gives the same sequence.
      expect(allIds(filter, context, DAY, 25)).toEqual(want);
    },
  );

  it("pages within one scope and one project too", () => {
    const records = generateSyntheticTasks(400);
    for (const record of records) upsertTask(db, record);
    const scope = syntheticScopes()[1] as string;
    for (const filter of TASK_FILTERS) {
      const context = { scope, projectId: P2 };
      expect(allIds(filter, context, DAY, 7)).toEqual(oracle(records, filter, context, DAY));
    }
  });

  it("rejects a cursor from another filter and an invalid cursor shape, with a typed error", () => {
    const records = generateSyntheticTasks(120);
    for (const record of records) upsertTask(db, record);
    const first = queryTasks(db, { context: { scope: "all" }, filter: "all", day: DAY, limit: 5 });
    const cursor = first.nextCursor as TaskCursor;
    expect(cursor).not.toBeNull();
    const run = (c: unknown, filter: TaskFilter = "all") =>
      queryTasks(db, { context: { scope: "all" }, filter, day: DAY, cursor: c as TaskCursor });
    expect(() => run(cursor, "overdue")).toThrow(InvalidTaskCursorError);
    expect(() => run({ ...cursor, keys: [] })).toThrow(InvalidTaskCursorError);
    expect(() => run({ ...cursor, keys: [5] })).toThrow(InvalidTaskCursorError);
    expect(() => run({ ...cursor, id: "x' OR 1=1 --" })).toThrow(InvalidTaskCursorError);
    expect(() => run({ ...cursor, filter: "all", keys: ["a".repeat(500)] })).toThrow(
      InvalidTaskCursorError,
    );
    expect(() => run(null)).toThrow();
  });
});

describe("Filters 8: limits, totals and row views", () => {
  it("clamps a page size above 25 and refuses zero, negative and fractional sizes", () => {
    for (const record of generateSyntheticTasks(100)) upsertTask(db, record);
    const big = queryTasks(db, { context: { scope: "all" }, filter: "all", day: DAY, limit: 100 });
    expect(big.rows).toHaveLength(25);
    const dflt = queryTasks(db, { context: { scope: "all" }, filter: "all", day: DAY });
    expect(dflt.rows).toHaveLength(25);
    for (const limit of [0, -3, 1.5, Number.NaN]) {
      expect(() =>
        queryTasks(db, { context: { scope: "all" }, filter: "all", day: DAY, limit }),
      ).toThrow(InvalidTaskQueryError);
    }
  });

  it("returns a total without the keyset, equal to the chip count, for every chip", () => {
    const records = generateSyntheticTasks(200);
    for (const record of records) upsertTask(db, record);
    const { counts } = countTasks(db, { context: { scope: "all" }, day: DAY });
    for (const filter of TASK_FILTERS.filter((f) => f !== "project")) {
      const first = queryTasks(db, { context: { scope: "all" }, filter, day: DAY, limit: 5 });
      expect(first.total).toBe(counts[filter]);
      if (first.nextCursor !== null) {
        const second = queryTasks(db, {
          context: { scope: "all" },
          filter,
          day: DAY,
          limit: 5,
          cursor: first.nextCursor,
        });
        expect(second.total).toBe(counts[filter]);
      }
    }
  });

  it("gives a Project filter with a chosen project the total of that project", () => {
    const records = generateSyntheticTasks(200);
    for (const record of records) upsertTask(db, record);
    const page = queryTasks(db, {
      context: { scope: "all", projectId: P1 },
      filter: "project",
      day: DAY,
      limit: 5,
    });
    expect(page.total).toBe(
      oracle(records, "project", { scope: "all", projectId: P1 }, DAY).length,
    );
    expect(page.chooseProject).toBe(false);
  });

  it("carries at most three tags plus the tag count, the unmet count and the overdue flag, and no body", () => {
    put(1, {
      due: "2026-10-01",
      tags: ["d", "a", "c", "b", "e"],
      dependencies: ids(2, 3),
    });
    const row = queryTasks(db, { context: { scope: "all" }, filter: "overdue", day: DAY }).rows[0];
    expect(row).toMatchObject({
      tags: ["a", "b", "c"],
      tagCount: 5,
      unmetDependencies: 2,
      overdue: true,
    });
    expect(Object.keys(row as object).sort()).toEqual(
      [
        "dueDate",
        "id",
        "overdue",
        "scope",
        "status",
        "tagCount",
        "tags",
        "title",
        "unmetDependencies",
        "updatedAt",
      ].sort(),
    );
    for (const key of Object.keys(row as object)) {
      expect(key).not.toMatch(/body|description|content|excerpt|markdown/i);
    }
  });

  it("produces rows the wire schema accepts", () => {
    for (const record of generateSyntheticTasks(60)) upsertTask(db, record);
    for (const filter of TASK_FILTERS) {
      const context = filter === "project" ? { scope: "all", projectId: P1 } : { scope: "all" };
      const page = queryTasks(db, { context, filter, day: DAY });
      for (const row of page.rows) expect(() => TaskRowSchema.parse(row)).not.toThrow();
    }
  });
});
