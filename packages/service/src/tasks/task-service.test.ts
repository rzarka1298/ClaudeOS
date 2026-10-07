import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  isTaskNotePath,
  ProjectIdSchema,
  TASK_FILE_SUFFIX_LENGTH,
  TASK_SLUG_MAX_LENGTH,
  type TaskContext,
  type TaskCreateRequest,
  TaskCreateResponseSchema,
  VALID_HOSTILE_TASK_TITLES,
} from "@ccc/domain";
import { countTasks, getTask, queryTasks } from "@ccc/operational-store";
import { parseTaskNote, type TaskAttention } from "@ccc/vault-repo";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeServiceFixture,
  noteId,
  projectIdOf,
  publishedGenerations,
  type ServiceFixture,
  seedTasks,
  taskRecord,
} from "../test-support/task-fixtures.js";
import { createTaskServices } from "./task-service.js";
import type { TaskServiceHost, TaskServices } from "./types.js";

let fx: ServiceFixture;
let services: TaskServiceHost;

beforeEach(() => {
  fx = makeServiceFixture();
  services = createTaskServices(fx.deps);
});

afterEach(() => {
  vi.restoreAllMocks();
  fx.cleanup();
});

const ZONE = "America/New_York";
const PROJECT_ID = ProjectIdSchema.parse("abcdefghi0123456789abcdef");

function request(overrides: Partial<TaskCreateRequest> = {}): TaskCreateRequest {
  return { title: "Write the quarterly note", intent: "inbox", zone: ZONE, ...overrides };
}

function createOk(overrides: Partial<TaskCreateRequest> = {}) {
  const result = services.create(request(overrides));
  if (!result.ok) throw new Error(`create refused: ${result.code}`);
  return result.value;
}

function tasksFolder(scopeFolder = "global"): string {
  return join(fx.vault.root, ...scopeFolder.split("/"), "tasks");
}

function noteFiles(scopeFolder = "global"): string[] {
  return readdirSync(tasksFolder(scopeFolder)).filter((name) => name !== "index.md");
}

describe("Test 1 (create, global)", () => {
  it("writes global/tasks/{slug}-{suffix}.md that parses back as an inbox task at the capture stage", () => {
    const { task } = createOk();
    const files = noteFiles();
    expect(files).toHaveLength(1);
    const name = files[0] as string;
    expect(name).toMatch(/^write-the-quarterly-note-[0-9a-z]{8}\.md$/);
    const parsed = parseTaskNote(readFileSync(join(tasksFolder(), name), "utf8"));
    expect(parsed.frontmatter.status).toBe("inbox");
    expect(parsed.frontmatter.stage).toBe("capture");
    expect(parsed.frontmatter.id).toBe(task.id);
    expect(parsed.frontmatter.title).toBe("Write the quarterly note");
    expect(parsed.frontmatter.sourceType).toBe("manual");
  });

  it("indexes the note and answers with the row, which carries no body text or absolute path", () => {
    const { task } = createOk({ description: "A body that must stay in the note." });
    const indexed = getTask(fx.store.db, task.id);
    expect(indexed?.path).toMatch(/^global\/tasks\/.+\.md$/);
    expect(indexed?.title).toBe("Write the quarterly note");
    expect(TaskCreateResponseSchema.safeParse({ task }).success).toBe(true);
    const wire = JSON.stringify({ task });
    expect(wire).not.toContain("A body that must stay");
    expect(wire).not.toContain(fx.vault.root);
    expect(wire).not.toContain(".md");
    expect(task.status).toBe("inbox");
    expect(task.scope).toBe("global");
  });

  it("publishes tasks.changed with a higher generation for each create", () => {
    createOk();
    createOk({ title: "Second task" });
    const generations = publishedGenerations(fx.bus);
    expect(generations).toHaveLength(2);
    expect(generations[1]).toBeGreaterThan(generations[0] as number);
  });
});

describe("Test 2 (intent and fields)", () => {
  it("gives status ready for the ready intent", () => {
    const { task } = createOk({ intent: "ready" });
    expect(task.status).toBe("ready");
  });

  it("stores priority, project, tags, a scheduled date and a local due date with a time converted in the zone", () => {
    const { task } = createOk({
      priority: "high",
      projectId: PROJECT_ID,
      tags: ["alpha", "beta/gamma"],
      dueDate: "2026-10-09",
      dueTime: "15:00",
      scheduledDate: "2026-10-08",
    });
    expect(task.priority).toBe("high");
    expect(task.projectId).toBe(PROJECT_ID);
    expect(task.tags).toEqual(["alpha", "beta/gamma"]);
    expect(task.tagCount).toBe(2);
    // 15:00 in New York on 2026-10-09 is UTC-4.
    expect(task.dueAt).toBe("2026-10-09T19:00:00.000Z");
    expect(task.dueDate).toBeUndefined();
    expect(task.scheduledDate).toBe("2026-10-08");
    const name = noteFiles()[0] as string;
    const parsed = parseTaskNote(readFileSync(join(tasksFolder(), name), "utf8"));
    expect(parsed.frontmatter.due).toBe("2026-10-09T15:00:00-04:00");
    expect(parsed.frontmatter.scheduled).toBe("2026-10-08");
  });

  it("keeps a due date with no time as a date-only value", () => {
    const { task } = createOk({ dueDate: "2026-10-09" });
    expect(task.dueDate).toBe("2026-10-09");
    expect(task.dueAt).toBeUndefined();
  });

  it("writes the description as the note body verbatim", () => {
    createOk({ description: "Line one\n\nLine two" });
    const name = noteFiles()[0] as string;
    const parsed = parseTaskNote(readFileSync(join(tasksFolder(), name), "utf8"));
    expect(parsed.body).toBe("Line one\n\nLine two");
  });
});

describe("Test 3 (workspace scope)", () => {
  it("writes under the workspace's tasks folder", () => {
    const workspaceId = fx.vault.workspace();
    const { task } = createOk({ scope: `workspace:${workspaceId}` });
    expect(task.scope).toBe(`workspace:${workspaceId}`);
    expect(noteFiles(`workspaces/${workspaceId}`)).toHaveLength(1);
    expect(getTask(fx.store.db, task.id)?.path).toMatch(
      new RegExp(`^workspaces/${workspaceId}/tasks/`),
    );
  });

  it("creates the tasks folder and its summary index lazily for a workspace that predates the folder", () => {
    const workspaceId = fx.vault.workspace();
    rmSync(tasksFolder(`workspaces/${workspaceId}`), { recursive: true, force: true });
    expect(existsSync(tasksFolder(`workspaces/${workspaceId}`))).toBe(false);
    createOk({ scope: `workspace:${workspaceId}` });
    expect(existsSync(join(tasksFolder(`workspaces/${workspaceId}`), "index.md"))).toBe(true);
    expect(noteFiles(`workspaces/${workspaceId}`)).toHaveLength(1);
  });

  it("refuses a scope for a workspace that does not exist with invalid-scope and creates nothing", () => {
    const ghost = "workspace:0000000000000000000000000";
    const before = readdirSync(join(fx.vault.root, "workspaces"));
    const result = services.create(request({ scope: ghost }));
    expect(result).toEqual({ ok: false, code: "invalid-scope" });
    expect(readdirSync(join(fx.vault.root, "workspaces"))).toEqual(before);
    expect(noteFiles()).toHaveLength(0);
    expect(publishedGenerations(fx.bus)).toHaveLength(0);
  });
});

describe("Test 5 (hostile title)", () => {
  it("makes ASCII slug file names within the cap and round-trips the stored title exactly", () => {
    expect(VALID_HOSTILE_TASK_TITLES.length).toBeGreaterThan(10);
    for (const title of VALID_HOSTILE_TASK_TITLES) {
      const { task } = createOk({ title });
      expect(task.title).toBe(title);
      const path = getTask(fx.store.db, task.id)?.path as string;
      expect(isTaskNotePath(path)).toBe(true);
      const name = path.slice(path.lastIndexOf("/") + 1);
      expect(name).toMatch(/^[a-z0-9-]+\.md$/);
      expect(name.length).toBeLessThanOrEqual(
        TASK_SLUG_MAX_LENGTH + 1 + TASK_FILE_SUFFIX_LENGTH + ".md".length,
      );
      expect(name).not.toMatch(/\.\./);
      const parsed = parseTaskNote(readFileSync(join(fx.vault.root, ...path.split("/")), "utf8"));
      expect(parsed.frontmatter.title).toBe(title);
    }
  });
});

describe("Test 4 (refusals leave nothing behind)", () => {
  it("answers vault-not-set-up when no vault root is registered and writes nothing", () => {
    fx.setVaultRoot(null);
    expect(services.create(request())).toEqual({ ok: false, code: "vault-not-set-up" });
    expect(noteFiles()).toHaveLength(0);
    expect(publishedGenerations(fx.bus)).toHaveLength(0);
  });

  it("refuses a due time without a date and a time that does not exist in the zone's calendar", () => {
    const badDate = services.create(request({ dueDate: "2026-02-30", dueTime: "10:00" }));
    expect(badDate).toEqual({ ok: false, code: "invalid-body" });
    expect(noteFiles()).toHaveLength(0);
  });
});

describe("Test 6 (failure)", () => {
  it("answers write-failed with no index change and logs the route name and error class only", () => {
    // A regular file where the tasks folder must be makes the folder impossible to create.
    rmSync(tasksFolder(), { recursive: true, force: true });
    writeFileSync(tasksFolder(), "not a folder /Users/USERNAME/secret");
    const result = services.create(request({ title: "A private title" }));
    expect(result).toEqual({ ok: false, code: "write-failed" });
    expect(fx.store.db.prepare("SELECT COUNT(*) AS n FROM task_index").get()).toEqual({ n: 0 });
    expect(publishedGenerations(fx.bus)).toHaveLength(0);
    expect(fx.lines).toHaveLength(1);
    const logged = JSON.stringify(fx.lines);
    expect(logged).toContain("create");
    expect(logged).toMatch(/Error/);
    expect(logged).not.toContain("A private title");
    expect(logged).not.toContain("/Users/");
    expect(logged).not.toContain(fx.vault.root);
  });
});

// ---------------------------------------------------------------------------
// Task 2: list, counts, get, due-today and attention

const WS = "0abcdefghijklmnopqrstuvwx";
const WS_SCOPE = `workspace:${WS}`;
const P1 = ProjectIdSchema.parse(projectIdOf(1));

function seedMixed(): void {
  seedTasks(fx.store, [
    taskRecord(1, { due: "2026-10-07" }),
    taskRecord(2, { due: "2026-10-07T18:00:00Z", priority: "high" }),
    taskRecord(3, { due: "2026-10-06" }),
    taskRecord(4, { due: "2026-10-20" }),
    taskRecord(5, { status: "proposed", assignee: "automation" }),
    taskRecord(6, { status: "done", completed: "2026-10-05T10:00:00Z" }),
    taskRecord(7, { status: "blocked" }),
    taskRecord(8, { projectId: P1 }),
    taskRecord(9, {
      scope: WS_SCOPE,
      path: `workspaces/${WS}/tasks/task-9.md`,
      due: "2026-10-07",
    }),
    taskRecord(10, { status: "cancelled" }),
  ]);
}

function listOk(
  filter: Parameters<TaskServices["list"]>[0]["filter"],
  context: Parameters<TaskServices["list"]>[0]["context"] = { scope: "all" },
  extra: { cursor?: string; zone?: string | undefined } = {},
) {
  const result = services.list({
    context,
    filter,
    zone: ZONE,
    ...(extra.cursor === undefined ? {} : { cursor: extra.cursor }),
    ...(extra.zone === undefined ? {} : { zone: extra.zone }),
  });
  if (!result.ok) throw new Error(`list refused: ${result.code}`);
  return result.value;
}

describe("Task 2 Test 2 (list)", () => {
  it("returns for each of the eight filters the rows the store returns for the same inputs", () => {
    seedMixed();
    const day = {
      localDate: "2026-10-07",
      startsAt: "2026-10-07T04:00:00.000Z",
      endsAt: "2026-10-08T04:00:00.000Z",
    };
    for (const filter of [
      "all",
      "today",
      "upcoming",
      "overdue",
      "project",
      "proposed",
      "blocked",
      "completed",
    ] as const) {
      const context: TaskContext =
        filter === "project" ? { scope: "all", projectId: P1 } : { scope: "all" };
      const page = listOk(filter, context);
      const expected = queryTasks(fx.store.db, {
        context: {
          scope: context.scope,
          ...(context.projectId === undefined ? {} : { projectId: context.projectId }),
        },
        filter,
        day,
      });
      expect(page.rows.map((row) => row.id)).toEqual(expected.rows.map((row) => row.id));
      expect(page.total).toBe(expected.total);
      expect(page.chooseProject).toBe(false);
    }
    expect(listOk("today").rows.map((row) => row.id)).toEqual(
      expect.arrayContaining([noteId(1), noteId(2), noteId(9)]),
    );
    expect(listOk("proposed").rows.map((row) => row.id)).toEqual([noteId(5)]);
  });

  it("pages 25 at a time with a next cursor and the total", () => {
    seedTasks(
      fx.store,
      Array.from({ length: 30 }, (_, i) => taskRecord(100 + i)),
    );
    const first = listOk("all");
    expect(first.rows).toHaveLength(25);
    expect(first.total).toBe(30);
    expect(first.nextCursor).not.toBeNull();
    const second = listOk("all", { scope: "all" }, { cursor: first.nextCursor as string });
    expect(second.rows).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    const seen = new Set([...first.rows, ...second.rows].map((row) => row.id));
    expect(seen.size).toBe(30);
  });

  it("narrows by scope and by project", () => {
    seedMixed();
    expect(listOk("all", { scope: WS_SCOPE }).rows.map((row) => row.id)).toEqual([noteId(9)]);
    const global = listOk("all", { scope: "global" });
    expect(global.rows.map((row) => row.id)).not.toContain(noteId(9));
    expect(listOk("all", { scope: "all", projectId: P1 }).rows.map((row) => row.id)).toEqual([
      noteId(8),
    ]);
  });

  it("answers the choose-a-project flag with an empty page for Project with no project", () => {
    seedMixed();
    expect(listOk("project")).toEqual({
      rows: [],
      total: 0,
      nextCursor: null,
      chooseProject: true,
    });
  });

  it("carries no body text and no absolute path", () => {
    seedMixed();
    const wire = JSON.stringify(listOk("all"));
    expect(wire).not.toContain(fx.vault.root);
    expect(wire).not.toContain("global/tasks");
  });

  it("refuses a bad cursor with invalid-cursor, including one from another filter", () => {
    seedTasks(
      fx.store,
      Array.from({ length: 30 }, (_, i) => taskRecord(100 + i)),
    );
    const first = listOk("all");
    const cursor = first.nextCursor as string;
    expect(
      services.list({ context: { scope: "all" }, filter: "upcoming", zone: ZONE, cursor }),
    ).toEqual({ ok: false, code: "invalid-cursor" });
    expect(
      services.list({ context: { scope: "all" }, filter: "all", zone: ZONE, cursor: "bad!" }),
    ).toEqual({ ok: false, code: "invalid-cursor" });
  });
});

describe("Task 2 Test 3 (zone)", () => {
  it("uses the request's zone: an instant late on the previous New York evening is today in UTC only", () => {
    seedTasks(fx.store, [taskRecord(1, { due: "2026-10-07T03:30:00Z" })]);
    expect(listOk("today", { scope: "all" }, { zone: "America/New_York" }).rows).toHaveLength(0);
    expect(listOk("overdue", { scope: "all" }, { zone: "America/New_York" }).rows).toHaveLength(1);
    expect(listOk("today", { scope: "all" }, { zone: "UTC" }).rows).toHaveLength(1);
  });

  it("refuses an invalid zone and falls back to the runtime zone when none is given", () => {
    expect(services.list({ context: { scope: "all" }, filter: "all", zone: "Not/AZone" })).toEqual({
      ok: false,
      code: "invalid-body",
    });
    const absent = services.list({ context: { scope: "all" }, filter: "all" });
    expect(absent.ok).toBe(true);
  });

  it("reads the clock exactly once per list, counts and due-today request", () => {
    seedMixed();
    let calls = 0;
    const counted = createTaskServices({
      ...fx.deps,
      now: () => {
        calls += 1;
        return fx.clock.now();
      },
    });
    const baseline = calls;
    counted.list({ context: { scope: "all" }, filter: "today", zone: ZONE });
    expect(calls - baseline).toBe(1);
    counted.counts({ context: { scope: "all" }, zone: ZONE });
    expect(calls - baseline).toBe(2);
    counted.dueToday({ zone: ZONE });
    expect(calls - baseline).toBe(3);
  });
});

describe("Task 2 Test 4 (counts)", () => {
  it("carries every chip count, the open total and equals the list totals for the same context", () => {
    seedMixed();
    const contexts: TaskContext[] = [
      { scope: "all" },
      { scope: "global" },
      { scope: WS_SCOPE },
      { scope: "all", projectId: P1 },
    ];
    for (const context of contexts) {
      const result = services.counts({ context, zone: ZONE });
      if (!result.ok) throw new Error("counts refused");
      for (const filter of [
        "all",
        "today",
        "upcoming",
        "overdue",
        "project",
        "proposed",
        "blocked",
        "completed",
      ] as const) {
        const page = listOk(filter, context);
        const expected =
          filter === "project" && context.projectId === undefined ? undefined : page.total;
        if (expected !== undefined) expect(result.value.counts[filter]).toBe(expected);
      }
    }
    const all = services.counts({ context: { scope: "all" }, zone: ZONE });
    if (!all.ok) throw new Error("counts refused");
    expect(all.value.counts.proposed).toBe(1);
    expect(all.value.open).toBe(
      countTasks(fx.store.db, {
        context: { scope: "all" },
        day: {
          localDate: "2026-10-07",
          startsAt: "2026-10-07T04:00:00.000Z",
          endsAt: "2026-10-08T04:00:00.000Z",
        },
      }).open,
    );
    expect(all.value.open).toBeLessThan(all.value.counts.all);
  });

  it("narrows to one project when the context fixes it", () => {
    seedMixed();
    const result = services.counts({ context: { scope: "all", projectId: P1 }, zone: ZONE });
    if (!result.ok) throw new Error("counts refused");
    expect(result.value.counts.all).toBe(1);
    expect(result.value.open).toBe(1);
  });
});

describe("Task 2 Test 5 (get)", () => {
  it("returns the row, the unfinished dependencies (resolved or not) and the parent id and title", () => {
    seedTasks(fx.store, [
      taskRecord(1, { title: "Parent task" }),
      taskRecord(2, { title: "Open dependency" }),
      taskRecord(3, {
        title: "Done dependency",
        status: "done",
        completed: "2026-10-05T10:00:00Z",
      }),
      taskRecord(4, {
        title: "Child",
        parentId: noteId(1),
        dependencies: [noteId(2), noteId(3), noteId(77)],
        assignee: "user",
      }),
    ]);
    const result = services.get({ taskId: noteId(4) });
    if (!result.ok) throw new Error("get refused");
    const detail = result.value.task;
    expect(detail.row.id).toBe(noteId(4));
    expect(detail.path).toBe("global/tasks/task-4.md");
    expect(detail.sourceType).toBe("manual");
    expect(detail.parent).toEqual({ id: noteId(1), title: "Parent task" });
    expect(detail.blockedBy).toEqual([
      { resolved: true, id: noteId(2), title: "Open dependency", status: "ready" },
      { resolved: false, id: noteId(77) },
    ]);
    expect(detail.assignee).toBe("user");
    expect(JSON.stringify(detail)).not.toContain(fx.vault.root);
  });

  it("answers not-found for an unknown id", () => {
    expect(services.get({ taskId: noteId(1) })).toEqual({ ok: false, code: "not-found" });
  });

  it("gives a missing parent a null title", () => {
    seedTasks(fx.store, [taskRecord(4, { parentId: noteId(55) })]);
    const result = services.get({ taskId: noteId(4) });
    if (!result.ok) throw new Error("get refused");
    expect(result.value.task.parent).toEqual({ id: noteId(55), title: null });
  });
});

describe("Task 2 Test 6 (due-today)", () => {
  it("returns due-today and overdue rows with task ids, at most 50 each, in the request zone", () => {
    seedTasks(fx.store, [
      ...Array.from({ length: 60 }, (_, i) => taskRecord(100 + i, { due: "2026-10-07" })),
      ...Array.from({ length: 55 }, (_, i) => taskRecord(300 + i, { due: "2026-10-01" })),
      taskRecord(500, { status: "proposed", due: "2026-10-07" }),
      taskRecord(501, { status: "done", due: "2026-10-07", completed: "2026-10-06T10:00:00Z" }),
    ]);
    const result = services.dueToday({ zone: ZONE });
    if (!result.ok) throw new Error("due-today refused");
    expect(result.value.due).toHaveLength(50);
    expect(result.value.overdue).toHaveLength(50);
    const ids = [...result.value.due, ...result.value.overdue].map((row) => row.taskId);
    expect(ids).not.toContain(noteId(500));
    expect(ids).not.toContain(noteId(501));
    expect(result.value.due[0]?.dueDate).toBe("2026-10-07");
  });

  it("fits the response within the 64 KiB transport cap for 50 + 50 maximal CJK rows", () => {
    const title = "漢".repeat(200);
    seedTasks(fx.store, [
      ...Array.from({ length: 50 }, (_, i) => taskRecord(100 + i, { title, due: "2026-10-07" })),
      ...Array.from({ length: 50 }, (_, i) => taskRecord(300 + i, { title, due: "2026-10-01" })),
    ]);
    const result = services.dueToday({ zone: ZONE });
    if (!result.ok) throw new Error("due-today refused");
    expect(Buffer.byteLength(JSON.stringify(result.value), "utf8")).toBeLessThanOrEqual(60 * 1024);
    expect(result.value.due.length).toBeGreaterThan(0);
    expect(result.value.overdue.length).toBeGreaterThan(0);
  });

  it("follows the scope and the zone", () => {
    seedTasks(fx.store, [
      taskRecord(1, { due: "2026-10-07T03:30:00Z" }),
      taskRecord(2, {
        due: "2026-10-07",
        scope: WS_SCOPE,
        path: `workspaces/${WS}/tasks/task-2.md`,
      }),
    ]);
    const ny = services.dueToday({ zone: "America/New_York" });
    const utc = services.dueToday({ zone: "UTC" });
    if (!ny.ok || !utc.ok) throw new Error("due-today refused");
    expect(ny.value.overdue.map((row) => row.taskId)).toEqual([noteId(1)]);
    expect(utc.value.due.map((row) => row.taskId)).toContain(noteId(1));
    const scoped = services.dueToday({ zone: "UTC", scope: WS_SCOPE });
    if (!scoped.ok) throw new Error("due-today refused");
    expect(scoped.value.due.map((row) => row.taskId)).toEqual([noteId(2)]);
  });
});

describe("Task 2 Test 7 (attention)", () => {
  function attentionFixture(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      reason: "unreadable" as const,
      paths: [`global/tasks/broken-${String(i).padStart(3, "0")}.md`],
      detail: "task note frontmatter is not valid YAML",
    }));
  }

  it("pages the in-memory list 25 at a time with reasons and vault-relative paths", () => {
    let list: readonly TaskAttention[] = attentionFixture(30);
    const rootReads = vi.fn(() => fx.vault.root);
    const withList = createTaskServices({
      ...fx.deps,
      getVaultRoot: rootReads,
      attention: {
        get: () => list,
        set: (next) => {
          list = [...next];
        },
      },
    });
    const first = withList.attention({});
    if (!first.ok) throw new Error("attention refused");
    expect(first.value.items).toHaveLength(25);
    expect(first.value.total).toBe(30);
    expect(first.value.items[0]).toEqual({
      path: "global/tasks/broken-000.md",
      title: "broken-000",
      reason: "unreadable",
      otherPaths: [],
    });
    const second = withList.attention({ cursor: first.value.nextCursor as string });
    if (!second.ok) throw new Error("attention refused");
    expect(second.value.items).toHaveLength(5);
    expect(second.value.nextCursor).toBeNull();
    expect(rootReads).not.toHaveBeenCalled();
  });

  it("names each copy of a duplicate with the other copies' paths", () => {
    const withList = createTaskServices({
      ...fx.deps,
      attention: {
        get: () => [
          {
            reason: "duplicate-id",
            id: noteId(1),
            paths: ["global/tasks/a-1.md", "global/tasks/b-1.md"],
            detail: "x",
          },
        ],
        set: () => undefined,
      },
    });
    const result = withList.attention({});
    if (!result.ok) throw new Error("attention refused");
    expect(result.value.items.map((item) => [item.path, item.otherPaths])).toEqual([
      ["global/tasks/a-1.md", ["global/tasks/b-1.md"]],
      ["global/tasks/b-1.md", ["global/tasks/a-1.md"]],
    ]);
    expect(result.value.items.every((item) => item.reason === "duplicate-id")).toBe(true);
  });

  it("returns an empty page for an empty list", () => {
    expect(services.attention({})).toEqual({
      ok: true,
      value: { items: [], total: 0, nextCursor: null },
    });
  });

  it("refuses a bad cursor", () => {
    expect(services.attention({ cursor: "garbage!" })).toEqual({
      ok: false,
      code: "invalid-cursor",
    });
  });

  it("keeps a page under the client response cap even with very long duplicate paths", () => {
    const longName = (n: number) =>
      `global/tasks/${"d".repeat(200)}-${String(n).padStart(3, "0")}.md`;
    const list = Array.from({ length: 25 }, (_, i) => ({
      reason: "duplicate-id" as const,
      id: noteId(i),
      paths: Array.from({ length: 51 }, (_, j) => longName(i * 100 + j)),
      detail: "x",
    }));
    const withList = createTaskServices({
      ...fx.deps,
      attention: { get: () => list, set: () => undefined },
    });
    let cursor: string | undefined;
    let seen = 0;
    for (let guard = 0; guard < 2000; guard++) {
      const page = withList.attention(cursor === undefined ? {} : { cursor });
      if (!page.ok) throw new Error("attention refused");
      expect(Buffer.byteLength(JSON.stringify(page.value), "utf8")).toBeLessThan(60 * 1024);
      seen += page.value.items.length;
      if (page.value.nextCursor === null) break;
      cursor = page.value.nextCursor;
    }
    expect(seen).toBe(25 * 51);
  });
});

// ---------------------------------------------------------------------------
// Task 3: the internal proposed-task creator (D-36, TASK-04, APPR-02)

describe("Task 3 Test 8 (proposed task)", () => {
  function propose(overrides: Record<string, unknown> = {}) {
    const result = services.createProposedTask({
      title: "Review the weekly research digest",
      sourceType: "research",
      sourceLink: "https://example.test/digest",
      generatedBy: { automation: "weekly-research" },
      due: "2026-10-07",
      projectId: P1,
      priority: "high",
      ...overrides,
    });
    if (!result.ok) throw new Error(`createProposedTask refused: ${result.code}`);
    return result.value.task;
  }

  it("writes a note with status proposed, provenance and a plain-text source, indexes it and announces it", () => {
    const task = propose({ description: "Why this was suggested." });
    const path = getTask(fx.store.db, task.id)?.path as string;
    const parsed = parseTaskNote(readFileSync(join(fx.vault.root, ...path.split("/")), "utf8"));
    expect(parsed.frontmatter.status).toBe("proposed");
    expect(parsed.frontmatter.aiGenerated).toBe(true);
    expect(parsed.frontmatter.claimType).toBe("recommendation");
    expect(parsed.frontmatter.confidence).toBe("unverified");
    expect(parsed.frontmatter.generatedBy).toEqual({ automation: "weekly-research" });
    expect(parsed.frontmatter.assignee).toBe("automation");
    expect(parsed.frontmatter.sourceType).toBe("research");
    expect(parsed.frontmatter.sourceLink).toBe("https://example.test/digest");
    expect(parsed.body).toBe("Why this was suggested.");
    expect(task.status).toBe("proposed");
    expect(publishedGenerations(fx.bus)).toHaveLength(1);
  });

  it("appears under Proposed and All and under none of today, upcoming, overdue, project, blocked or completed", () => {
    const task = propose();
    const ids = (filter: Parameters<typeof listOk>[0], context = { scope: "all" } as TaskContext) =>
      listOk(filter, context).rows.map((row) => row.id);
    expect(ids("proposed")).toEqual([task.id]);
    expect(ids("all")).toEqual([task.id]);
    for (const filter of ["today", "upcoming", "overdue", "blocked", "completed"] as const) {
      expect(ids(filter)).toEqual([]);
    }
    expect(ids("project", { scope: "all", projectId: P1 })).toEqual([]);
    const counts = services.counts({ context: { scope: "all" }, zone: ZONE });
    if (!counts.ok) throw new Error("counts refused");
    expect(counts.value.counts.proposed).toBe(1);
    expect(counts.value.open).toBe(0);
    const feed = services.dueToday({ zone: ZONE });
    if (!feed.ok) throw new Error("due-today refused");
    expect(feed.value.due).toEqual([]);
    expect(feed.value.overdue).toEqual([]);
  });

  it("refuses a missing vault and an invalid scope with closed codes and writes nothing", () => {
    expect(
      services.createProposedTask({
        title: "x",
        sourceType: "research",
        generatedBy: { automation: "a" },
        scope: "workspace:0000000000000000000000000",
      }),
    ).toEqual({ ok: false, code: "invalid-scope" });
    fx.setVaultRoot(null);
    expect(
      services.createProposedTask({
        title: "x",
        sourceType: "research",
        generatedBy: { automation: "a" },
      }),
    ).toEqual({ ok: false, code: "vault-not-set-up" });
    expect(noteFiles()).toHaveLength(0);
  });

  it("is a no-approval write: the services module imports nothing from the approval engine", () => {
    const source = readFileSync(join(import.meta.dirname, "task-service.ts"), "utf8");
    expect(source).not.toMatch(/from\s+"[^"]*approval/i);
  });
});
