import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localDayBounds } from "@ccc/domain";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "./migrate.js";
import { getTask, InvalidTaskIndexError, queryTasks, upsertTask } from "./task-index-store.js";
import {
  columnNames,
  openMigratedFileDb,
  REAL_MIGRATIONS_DIR,
  triggerNames,
} from "./test-support/migration-helper.js";
import {
  fixtureId,
  makeTaskRecord,
  SYNTHETIC_TASK_NOW,
  SYNTHETIC_TASK_ZONE,
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
