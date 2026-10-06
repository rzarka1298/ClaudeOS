// Filters, display maps, task route contracts and the tasks.changed payload
// (plan 06-05 task 3; D-28, D-33, D-34, D-37, D-38, UI-SPEC S3 and the glyph rule).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { API_BASE } from "./api.js";
import { APPROVAL_STATE_DISPLAY } from "./approval-view.js";
import * as browser from "./index.browser.js";
import * as full from "./index.js";
import { RUN_STATE_DISPLAY } from "./session.js";
import { TASK_PRIORITIES, TASK_STATUSES } from "./task-schema.js";
import {
  TASK_ATTENTION_PATH,
  TASK_ATTENTION_REASONS,
  TASK_CHANGED_MAX_PATHS,
  TASK_CHANGED_PATH,
  TASK_COUNTS_PATH,
  TASK_CREATE_PATH,
  TASK_CURSOR_MAX_LENGTH,
  TASK_DEFAULT_FILTER,
  TASK_DUE_TODAY_LIMIT,
  TASK_DUE_TODAY_PATH,
  TASK_ERROR_CODES,
  TASK_FILTER_LABELS,
  TASK_FILTER_SORTS,
  TASK_FILTERS,
  TASK_GET_PATH,
  TASK_LIST_PATH,
  TASK_PAGE_SIZE,
  TASK_PRD_FILTERS,
  TASK_PRIORITY_DISPLAY,
  TASK_PROJECT_PANEL_FILTERS,
  TASK_REBUILD_PATH,
  TASK_ROW_TAG_LIMIT,
  TASK_STATUS_DISPLAY,
  TaskAttentionRequestSchema,
  TaskAttentionResponseSchema,
  TaskChangedRequestSchema,
  TaskChangedResponseSchema,
  TaskCountsRequestSchema,
  TaskCountsResponseSchema,
  TaskCreateRequestSchema,
  TaskCreateResponseSchema,
  TaskDueTodayRequestSchema,
  TaskDueTodayResponseSchema,
  TaskErrorBodySchema,
  TaskGetRequestSchema,
  TaskGetResponseSchema,
  TaskListRequestSchema,
  TaskListResponseSchema,
  TaskRebuildRequestSchema,
  TaskRebuildResponseSchema,
  TaskRowSchema,
  TasksChangedPayloadSchema,
} from "./tasks.js";

const HERE = dirname(fileURLToPath(import.meta.url));

const ID_A = "abcdefghi0123456789abcdef";
const ID_B = "zyxwvutsr9876543210fedcba";
const PROJECT_ID = "abcdefghi0123456789abcdef";
const WORKSPACE_SCOPE = "workspace:abcdefghi0123456789abcdef";
const ZONE = "America/New_York";

const ROW = {
  id: ID_A,
  title: "Draft the weekly review",
  status: "ready",
  priority: "high",
  scope: "global",
  projectId: PROJECT_ID,
  dueAt: "2026-10-09T19:00:00.000Z",
  scheduledDate: "2026-10-08",
  tags: ["work", "review"],
  tagCount: 2,
  unmetDependencies: 1,
  overdue: false,
  updatedAt: "2026-10-05T12:00:00Z",
};

describe("Test 1 (filters)", () => {
  it("lists all, today, upcoming, overdue, project, proposed, blocked, completed in that order", () => {
    expect([...TASK_FILTERS]).toEqual([
      "all",
      "today",
      "upcoming",
      "overdue",
      "project",
      "proposed",
      "blocked",
      "completed",
    ]);
  });

  it("exports the seven PRD filters as a distinct subset without All", () => {
    expect([...TASK_PRD_FILTERS]).toEqual([
      "today",
      "upcoming",
      "overdue",
      "project",
      "proposed",
      "blocked",
      "completed",
    ]);
    expect(TASK_PRD_FILTERS).toHaveLength(7);
    expect(
      TASK_FILTERS.filter((filter) => !(TASK_PRD_FILTERS as readonly string[]).includes(filter)),
    ).toEqual(["all"]);
  });

  it("gives the project panel the global list without Project", () => {
    expect([...TASK_PROJECT_PANEL_FILTERS]).toEqual(
      TASK_FILTERS.filter((filter) => filter !== "project"),
    );
    expect(TASK_PROJECT_PANEL_FILTERS).not.toContain("project");
    expect(TASK_PROJECT_PANEL_FILTERS).toContain("all");
  });

  it("defaults the global context to Today and labels every chip", () => {
    expect(TASK_DEFAULT_FILTER).toBe("today");
    expect(TASK_FILTER_LABELS).toEqual({
      all: "All",
      today: "Today",
      upcoming: "Upcoming",
      overdue: "Overdue",
      project: "Project",
      proposed: "Proposed",
      blocked: "Blocked",
      completed: "Completed",
    });
  });

  it("matches the UI-SPEC sort table for every filter", () => {
    expect(TASK_FILTER_SORTS).toEqual({
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
    });
    expect(Object.keys(TASK_FILTER_SORTS)).toEqual([...TASK_FILTERS]);
  });
});

/** Every glyph is one code point (a variation selector would make it an emoji). */
function codePoints(text: string): number {
  return [...text].length;
}

describe("Test 2 (display maps)", () => {
  it("matches the UI-SPEC labels and glyphs for statuses", () => {
    expect(TASK_STATUS_DISPLAY).toEqual({
      inbox: { label: "Inbox", glyph: "▤" },
      proposed: { label: "Proposed", glyph: "✦" },
      ready: { label: "Ready", glyph: "◎" },
      "in-progress": { label: "In progress", glyph: "▰" },
      blocked: { label: "Blocked", glyph: "‖" },
      done: { label: "Done", glyph: "✓" },
      cancelled: { label: "Cancelled", glyph: "⊘" },
    });
    expect(Object.keys(TASK_STATUS_DISPLAY)).toEqual([...TASK_STATUSES]);
  });

  it("matches the UI-SPEC labels and glyphs for priorities, and No priority has no glyph", () => {
    expect(TASK_PRIORITY_DISPLAY).toEqual({
      urgent: { label: "Urgent", glyph: "⇈" },
      high: { label: "High", glyph: "↑" },
      medium: { label: "Medium", glyph: "⇢" },
      low: { label: "Low", glyph: "↓" },
      none: { label: "No priority", glyph: null },
    });
    expect(Object.keys(TASK_PRIORITY_DISPLAY)).toEqual([...TASK_PRIORITIES, "none"]);
  });

  it("uses text-presentation glyphs only: no emoji-presentation code point, no variation selector", () => {
    const glyphs = [
      ...Object.values(TASK_STATUS_DISPLAY).map((entry) => entry.glyph),
      ...Object.values(TASK_PRIORITY_DISPLAY).map((entry) => entry.glyph),
    ].filter((glyph): glyph is string => glyph !== null);
    expect(glyphs).toHaveLength(7 + 4);
    for (const glyph of glyphs) {
      expect(codePoints(glyph), glyph).toBe(1);
      expect(/\p{Emoji_Presentation}/u.test(glyph), `emoji presentation: ${glyph}`).toBe(false);
      expect(/[︎️]/.test(glyph), `variation selector: ${glyph}`).toBe(false);
    }
  });

  it("repeats a glyph across vocabularies only for the three outcome glyphs", () => {
    const OUTCOME = new Set(["✓", "✕", "⊘"]);
    const vocabularies: Record<string, readonly string[]> = {
      taskStatus: Object.values(TASK_STATUS_DISPLAY).map((entry) => entry.glyph),
      taskPriority: Object.values(TASK_PRIORITY_DISPLAY)
        .map((entry) => entry.glyph)
        .filter((glyph): glyph is string => glyph !== null),
      approval: Object.values(APPROVAL_STATE_DISPLAY).map((entry) => entry.glyph),
      run: Object.values(RUN_STATE_DISPLAY).map((entry) => entry.glyph),
      // The freshness and Phase 4 sets are documented in the UI-SPEC glyph rule.
      freshness: ["●", "◐", "◔", "○"],
      phase4: ["⎇", "✱", "◌", "▲", "★", "◈", "△"],
    };
    const owners = new Map<string, string[]>();
    for (const [name, glyphs] of Object.entries(vocabularies)) {
      for (const glyph of new Set(glyphs)) {
        owners.set(glyph, [...(owners.get(glyph) ?? []), name]);
      }
    }
    // Earlier-phase overlaps (Phase 4's diamond and quarter circle) are out of scope and untouched.
    const taskOwned = new Set([...vocabularies.taskStatus, ...vocabularies.taskPriority]);
    for (const glyph of taskOwned) {
      const names = owners.get(glyph) ?? [];
      if (OUTCOME.has(glyph)) continue;
      expect(names, `glyph ${glyph}`).toHaveLength(1);
    }
    // And within the task and approval maps, every non-outcome glyph is unique.
    const own = [
      ...vocabularies.taskStatus,
      ...(vocabularies.taskPriority as string[]),
      ...(vocabularies.approval as string[]),
    ].filter((glyph) => !OUTCOME.has(glyph));
    expect(new Set(own).size).toBe(own.length);
  });

  it("lets only done, cancelled and failed share glyphs with other vocabularies", () => {
    expect(TASK_STATUS_DISPLAY.done.glyph).toBe(APPROVAL_STATE_DISPLAY.executed.glyph);
    expect(TASK_STATUS_DISPLAY.cancelled.glyph).toBe(APPROVAL_STATE_DISPLAY.denied.glyph);
    expect(APPROVAL_STATE_DISPLAY.failed.glyph).toBe("✕");
  });
});

describe("Test 3 (routes)", () => {
  const PATHS = {
    create: TASK_CREATE_PATH,
    list: TASK_LIST_PATH,
    counts: TASK_COUNTS_PATH,
    get: TASK_GET_PATH,
    changed: TASK_CHANGED_PATH,
    rebuild: TASK_REBUILD_PATH,
    attention: TASK_ATTENTION_PATH,
    dueToday: TASK_DUE_TODAY_PATH,
  };

  it("keeps every route a fixed path under API_BASE with no parameter segment", () => {
    for (const [name, path] of Object.entries(PATHS)) {
      expect(path.startsWith(`${API_BASE}/tasks`), name).toBe(true);
      expect(path, name).toMatch(/^\/api\/v1\/tasks(?:\/[a-z-]+)?$/);
      expect(path, name).not.toMatch(/[:{}*?]/);
    }
    expect(new Set(Object.values(PATHS)).size).toBe(Object.keys(PATHS).length);
  });

  describe("create request", () => {
    const minimal = { title: "Draft the weekly review", intent: "inbox", zone: ZONE };

    it("requires a title, an intent of inbox or ready, and an IANA zone", () => {
      expect(TaskCreateRequestSchema.safeParse(minimal).success).toBe(true);
      expect(TaskCreateRequestSchema.safeParse({ ...minimal, intent: "ready" }).success).toBe(true);
      expect(TaskCreateRequestSchema.safeParse({ intent: "inbox", zone: ZONE }).success).toBe(
        false,
      );
      expect(TaskCreateRequestSchema.safeParse({ title: "x", zone: ZONE }).success).toBe(false);
      expect(TaskCreateRequestSchema.safeParse({ title: "x", intent: "inbox" }).success).toBe(
        false,
      );
    });

    it("never lets a request create a proposed task (no HTTP route creates one)", () => {
      for (const intent of ["proposed", "done", "in-progress", "", "Inbox"]) {
        expect(TaskCreateRequestSchema.safeParse({ ...minimal, intent }).success, intent).toBe(
          false,
        );
      }
    });

    it("may carry a date, a local time, a scope, a project, a priority, a scheduled date, tags and a description", () => {
      const result = TaskCreateRequestSchema.safeParse({
        ...minimal,
        description: "Some plain text.\nSecond line.",
        dueDate: "2026-10-09",
        dueTime: "15:00",
        scheduledDate: "2026-10-08",
        scope: WORKSPACE_SCOPE,
        projectId: PROJECT_ID,
        priority: "high",
        tags: ["work", "q4/review"],
      });
      expect(result.success).toBe(true);
      expect(TaskCreateRequestSchema.safeParse({ ...minimal, scope: "global" }).success).toBe(true);
    });

    it("rejects an unknown key, including anything shaped like a path or a status", () => {
      for (const extra of [
        { path: "global/tasks/x.md" },
        { status: "done" },
        { id: ID_A },
        { note: 1 },
      ]) {
        expect(TaskCreateRequestSchema.safeParse({ ...minimal, ...extra }).success).toBe(false);
      }
    });

    it("rejects an empty title, a title over 200 characters and a hostile title", () => {
      expect(TaskCreateRequestSchema.safeParse({ ...minimal, title: "" }).success).toBe(false);
      expect(
        TaskCreateRequestSchema.safeParse({ ...minimal, title: "x".repeat(201) }).success,
      ).toBe(false);
      expect(
        TaskCreateRequestSchema.safeParse({ ...minimal, title: "x".repeat(200) }).success,
      ).toBe(true);
      expect(TaskCreateRequestSchema.safeParse({ ...minimal, title: "a\nb" }).success).toBe(false);
      expect(TaskCreateRequestSchema.safeParse({ ...minimal, title: "a‮b" }).success).toBe(false);
    });

    it("rejects a bad zone, date, time, scope, priority and tag list", () => {
      const bad: Record<string, unknown>[] = [
        { zone: "Not/AZone" },
        { zone: "+05:00" },
        { dueDate: "2026-02-30" },
        { dueDate: "tomorrow" },
        { dueDate: "2026-10-09", dueTime: "25:00" },
        { dueDate: "2026-10-09", dueTime: "3pm" },
        { dueTime: "15:00" },
        { scheduledDate: "2026-10-09T10:00:00Z" },
        { scope: "all" },
        { scope: "workspace:short" },
        { scope: "../global" },
        { projectId: "not a project" },
        { priority: "none" },
        { tags: Array.from({ length: 21 }, (_, i) => `t${i}`) },
        { tags: ["has space"] },
        { description: "x".repeat(10_001) },
        { description: "nul\u0000byte" },
      ];
      for (const patch of bad) {
        expect(
          TaskCreateRequestSchema.safeParse({ ...minimal, ...patch }).success,
          JSON.stringify(patch),
        ).toBe(false);
      }
    });

    it("answers with the created row", () => {
      expect(TaskCreateResponseSchema.safeParse({ task: ROW }).success).toBe(true);
      expect(
        TaskCreateResponseSchema.safeParse({ task: ROW, path: "global/tasks/x.md" }).success,
      ).toBe(false);
    });
  });

  describe("list request", () => {
    const list = { context: { scope: "all" }, filter: "today", zone: ZONE };

    it("carries a context, a filter, an IANA zone, an optional cursor and a limit", () => {
      expect(TaskListRequestSchema.safeParse(list).success).toBe(true);
      expect(
        TaskListRequestSchema.safeParse({
          context: { scope: WORKSPACE_SCOPE, projectId: PROJECT_ID },
          filter: "project",
          zone: ZONE,
          cursor: "abc_DEF-123",
          limit: 25,
        }).success,
      ).toBe(true);
      expect(
        TaskListRequestSchema.safeParse({ ...list, context: { scope: "global" } }).success,
      ).toBe(true);
    });

    it("bounds the cursor at 256 URL-safe characters and the limit at 25", () => {
      expect(TASK_CURSOR_MAX_LENGTH).toBe(256);
      expect(TASK_PAGE_SIZE).toBe(25);
      expect(TaskListRequestSchema.safeParse({ ...list, cursor: "a".repeat(256) }).success).toBe(
        true,
      );
      for (const cursor of [
        "a".repeat(257),
        "",
        "a b",
        "a/b",
        "a=b",
        "a+b",
        "../x",
        "a\nb",
        "a.b",
      ]) {
        expect(
          TaskListRequestSchema.safeParse({ ...list, cursor }).success,
          JSON.stringify(cursor),
        ).toBe(false);
      }
      expect(TaskListRequestSchema.safeParse({ ...list, limit: 26 }).success).toBe(false);
      expect(TaskListRequestSchema.safeParse({ ...list, limit: 0 }).success).toBe(false);
      expect(TaskListRequestSchema.safeParse({ ...list, limit: 1.5 }).success).toBe(false);
    });

    it("rejects an unknown filter, a bad zone, a bad scope and any extra key", () => {
      expect(TaskListRequestSchema.safeParse({ ...list, filter: "nope" }).success).toBe(false);
      expect(TaskListRequestSchema.safeParse({ ...list, zone: "Nowhere/Land" }).success).toBe(
        false,
      );
      expect(
        TaskListRequestSchema.safeParse({ ...list, context: { scope: "elsewhere" } }).success,
      ).toBe(false);
      expect(
        TaskListRequestSchema.safeParse({ ...list, context: { scope: "all", path: "x" } }).success,
      ).toBe(false);
      expect(TaskListRequestSchema.safeParse({ ...list, path: "global/tasks" }).success).toBe(
        false,
      );
    });

    it("carries the same context and zone on the counts request", () => {
      expect(
        TaskCountsRequestSchema.safeParse({ context: { scope: "all" }, zone: ZONE }).success,
      ).toBe(true);
      expect(TaskCountsRequestSchema.safeParse({ context: { scope: "all" } }).success).toBe(false);
      expect(
        TaskCountsRequestSchema.safeParse({
          context: { scope: "all" },
          zone: ZONE,
          filter: "today",
        }).success,
      ).toBe(false);
    });
  });

  describe("changed request", () => {
    const PATH = "global/tasks/x-abc12345.md";

    it("accepts at most 200 task note paths, or a rescan flag", () => {
      expect(TASK_CHANGED_MAX_PATHS).toBe(200);
      expect(TaskChangedRequestSchema.safeParse({ paths: [PATH] }).success).toBe(true);
      expect(TaskChangedRequestSchema.safeParse({ rescan: true }).success).toBe(true);
      expect(TaskChangedRequestSchema.safeParse({ paths: [PATH], rescan: true }).success).toBe(
        true,
      );
      expect(
        TaskChangedRequestSchema.safeParse({ paths: Array.from({ length: 200 }, () => PATH) })
          .success,
      ).toBe(true);
      expect(
        TaskChangedRequestSchema.safeParse({ paths: Array.from({ length: 201 }, () => PATH) })
          .success,
      ).toBe(false);
    });

    it("is never empty", () => {
      for (const body of [{}, { paths: [] }, { rescan: false }, { paths: [], rescan: false }]) {
        expect(TaskChangedRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
      }
    });

    it("accepts only vault-relative task note paths", () => {
      for (const path of [
        "../x.md",
        "/etc/passwd",
        "/Users/USERNAME/vault/global/tasks/x.md",
        "global/tasks/../../x.md",
        "global/tasks/index.md",
        "global/notes/x.md",
        "global\\tasks\\x.md",
        "global/tasks/x.txt",
        "~/x.md",
        "",
      ]) {
        expect(TaskChangedRequestSchema.safeParse({ paths: [path] }).success, path).toBe(false);
      }
    });

    it("rejects an extra key", () => {
      expect(TaskChangedRequestSchema.safeParse({ paths: [PATH], root: "/" }).success).toBe(false);
    });

    it("answers with the accepted count and the generation", () => {
      expect(TaskChangedResponseSchema.safeParse({ accepted: 3, generation: 7 }).success).toBe(
        true,
      );
      expect(TaskChangedResponseSchema.safeParse({ accepted: -1, generation: 7 }).success).toBe(
        false,
      );
    });
  });

  it("accepts no filesystem path other than a vault-relative task note path", () => {
    const requests = {
      create: TaskCreateRequestSchema,
      list: TaskListRequestSchema,
      counts: TaskCountsRequestSchema,
      get: TaskGetRequestSchema,
      changed: TaskChangedRequestSchema,
      rebuild: TaskRebuildRequestSchema,
      attention: TaskAttentionRequestSchema,
      dueToday: TaskDueTodayRequestSchema,
    };
    for (const [name, schema] of Object.entries(requests)) {
      const keys = Object.keys(schema.shape);
      for (const key of keys) {
        if (name === "changed" && key === "paths") continue;
        expect(key, `${name}.${key}`).not.toMatch(/path|file|dir|root|folder|url/i);
      }
    }
    expect(TaskGetRequestSchema.safeParse({ taskId: "../etc/passwd" }).success).toBe(false);
    expect(TaskGetRequestSchema.safeParse({ taskId: ID_A }).success).toBe(true);
  });
});

describe("Test 4 (responses)", () => {
  it("parses a task row and rejects an extra key, an all-day plus instant due and body text", () => {
    expect(TaskRowSchema.safeParse(ROW).success).toBe(true);
    expect(TaskRowSchema.safeParse({ ...ROW, body: "text" }).success).toBe(false);
    expect(TaskRowSchema.safeParse({ ...ROW, dueDate: "2026-10-09" }).success).toBe(false);
    expect(
      TaskRowSchema.safeParse({ ...ROW, scheduledAt: "2026-10-08T10:00:00.000Z" }).success,
    ).toBe(false);
    expect(TaskRowSchema.safeParse({ ...ROW, status: "waiting" }).success).toBe(false);
    expect(TaskRowSchema.safeParse({ ...ROW, tags: ["a", "b", "c", "d"] }).success).toBe(false);
    expect(TASK_ROW_TAG_LIMIT).toBe(3);
  });

  it("parses a list page and rejects an extra key or more than 25 rows", () => {
    const page = { rows: [ROW], total: 1, nextCursor: null, chooseProject: false };
    expect(TaskListResponseSchema.safeParse(page).success).toBe(true);
    expect(TaskListResponseSchema.safeParse({ ...page, nextCursor: "abc_def" }).success).toBe(true);
    expect(TaskListResponseSchema.safeParse({ ...page, extra: 1 }).success).toBe(false);
    expect(
      TaskListResponseSchema.safeParse({ ...page, rows: Array.from({ length: 26 }, () => ROW) })
        .success,
    ).toBe(false);
    expect(TaskListResponseSchema.safeParse({ ...page, nextCursor: "has space" }).success).toBe(
      false,
    );
  });

  it("parses the counts for every chip and rejects a missing or extra chip", () => {
    const counts = {
      all: 212,
      today: 3,
      upcoming: 12,
      overdue: 1,
      project: 40,
      proposed: 2,
      blocked: 4,
      completed: 56,
    };
    expect(TaskCountsResponseSchema.safeParse({ counts, open: 12 }).success).toBe(true);
    const { completed, ...missing } = counts;
    expect(completed).toBe(56);
    expect(TaskCountsResponseSchema.safeParse({ counts: missing, open: 12 }).success).toBe(false);
    expect(
      TaskCountsResponseSchema.safeParse({ counts: { ...counts, extra: 1 }, open: 12 }).success,
    ).toBe(false);
    expect(
      TaskCountsResponseSchema.safeParse({ counts: { ...counts, today: -1 }, open: 12 }).success,
    ).toBe(false);
  });

  it("parses a task detail whose blocked-by list may carry an unresolved dependency", () => {
    const task = {
      row: ROW,
      path: "global/tasks/draft-the-weekly-review-89abcdef.md",
      createdAt: "2026-10-05T12:00:00Z",
      sourceType: "email",
      sourceLink: "plain text, never a link",
      assignee: "automation",
      parent: { id: ID_B, title: "Quarterly planning" },
      blockedBy: [
        { resolved: true, id: ID_B, title: "Collect the numbers", status: "in-progress" },
        { resolved: false, id: "mmmmmmmmm0000000000mmmmmm" },
      ],
      aiGenerated: true,
      generatedBy: { skill: "inbox-triage" },
      confidence: "unverified",
      decision: { outcome: "accepted", at: "2026-10-05T13:00:00Z" },
    };
    const parsed = TaskGetResponseSchema.safeParse({ task });
    expect(parsed.success).toBe(true);
    expect(
      TaskGetResponseSchema.safeParse({ task: { ...task, path: "/Users/USERNAME/x.md" } }).success,
    ).toBe(false);
    expect(TaskGetResponseSchema.safeParse({ task: { ...task, extra: 1 } }).success).toBe(false);
    expect(
      TaskGetResponseSchema.safeParse({
        task: { ...task, blockedBy: [{ resolved: false, id: ID_B, title: "x" }] },
      }).success,
    ).toBe(false);
    expect(
      TaskGetResponseSchema.safeParse({
        task: {
          ...task,
          blockedBy: Array.from({ length: 51 }, () => ({ resolved: false, id: ID_B })),
        },
      }).success,
    ).toBe(false);
    // A detail with only the required parts.
    expect(
      TaskGetResponseSchema.safeParse({
        task: {
          row: ROW,
          path: "global/tasks/x-abc12345.md",
          createdAt: "2026-10-05T12:00:00Z",
          sourceType: "manual",
          blockedBy: [],
          aiGenerated: false,
          confidence: "unverified",
        },
      }).success,
    ).toBe(true);
  });

  it("parses the rebuild response", () => {
    expect(TaskRebuildRequestSchema.safeParse({}).success).toBe(true);
    expect(TaskRebuildRequestSchema.safeParse({ force: true }).success).toBe(false);
    expect(TaskRebuildResponseSchema.safeParse({ tasks: 212, attention: 2 }).success).toBe(true);
    expect(
      TaskRebuildResponseSchema.safeParse({ tasks: 212, attention: 2, path: "x" }).success,
    ).toBe(false);
  });

  it("parses attention items with their reasons and the other copies' paths", () => {
    expect([...TASK_ATTENTION_REASONS]).toEqual(["duplicate-id", "missing-id", "unreadable"]);
    expect(TaskAttentionRequestSchema.safeParse({}).success).toBe(true);
    expect(TaskAttentionRequestSchema.safeParse({ cursor: "abc", limit: 25 }).success).toBe(true);
    const item = (reason: string, otherPaths: string[] = []) => ({
      path: "global/tasks/copy-of-a-task-89abcdef.md",
      title: "Copy of a task",
      reason,
      otherPaths,
    });
    const page = {
      items: [
        item("duplicate-id", ["global/tasks/a-task-12345678.md"]),
        item("missing-id"),
        item("unreadable"),
      ],
      total: 3,
      nextCursor: null,
    };
    expect(TaskAttentionResponseSchema.safeParse(page).success).toBe(true);
    expect(TaskAttentionResponseSchema.safeParse({ ...page, items: [item("weird")] }).success).toBe(
      false,
    );
    expect(
      TaskAttentionResponseSchema.safeParse({ ...page, items: [item("missing-id", ["../x.md"])] })
        .success,
    ).toBe(false);
    expect(
      TaskAttentionResponseSchema.safeParse({
        ...page,
        items: Array.from({ length: 26 }, () => item("missing-id")),
      }).success,
    ).toBe(false);
    expect(TaskAttentionResponseSchema.safeParse({ ...page, extra: 1 }).success).toBe(false);
  });

  it("parses the due-today feed with due and overdue rows carrying an id, title and due value", () => {
    expect(TaskDueTodayRequestSchema.safeParse({ zone: ZONE }).success).toBe(true);
    expect(
      TaskDueTodayRequestSchema.safeParse({ zone: ZONE, scope: WORKSPACE_SCOPE }).success,
    ).toBe(true);
    expect(TaskDueTodayRequestSchema.safeParse({}).success).toBe(false);
    const feed = {
      due: [{ taskId: ID_A, title: "Draft the weekly review", dueAt: "2026-10-09T19:00:00.000Z" }],
      overdue: [{ taskId: ID_B, title: "File the report", dueDate: "2026-10-02" }],
    };
    expect(TaskDueTodayResponseSchema.safeParse(feed).success).toBe(true);
    expect(TaskDueTodayResponseSchema.safeParse({ ...feed, extra: 1 }).success).toBe(false);
    expect(
      TaskDueTodayResponseSchema.safeParse({
        ...feed,
        due: [
          { taskId: ID_A, title: "x", dueDate: "2026-10-09", dueAt: "2026-10-09T19:00:00.000Z" },
        ],
      }).success,
    ).toBe(false);
    expect(TASK_DUE_TODAY_LIMIT).toBe(50);
    expect(
      TaskDueTodayResponseSchema.safeParse({
        ...feed,
        overdue: Array.from({ length: 51 }, () => ({
          taskId: ID_B,
          title: "x",
          dueDate: "2026-10-02",
        })),
      }).success,
    ).toBe(false);
  });
});

describe("Test 4b (errors)", () => {
  it("is a closed code enum", () => {
    expect([...TASK_ERROR_CODES]).toEqual([
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
    ]);
    for (const code of TASK_ERROR_CODES) {
      expect(TaskErrorBodySchema.safeParse({ error: code }).success, code).toBe(true);
    }
  });

  it("rejects any other code, a message, a path or an extra key", () => {
    expect(TaskErrorBodySchema.safeParse({ error: "something else" }).success).toBe(false);
    expect(TaskErrorBodySchema.safeParse({ error: "not-found", message: "x" }).success).toBe(false);
    expect(TaskErrorBodySchema.safeParse({ error: "not-found", path: "/x" }).success).toBe(false);
    expect(TaskErrorBodySchema.safeParse({}).success).toBe(false);
    expect(TaskErrorBodySchema.safeParse({ error: 5 }).success).toBe(false);
  });
});

describe("tasks.changed payload", () => {
  it("carries a non-negative integer generation and ignores added keys (additive rule)", () => {
    expect(TasksChangedPayloadSchema.safeParse({ generation: 1 }).success).toBe(true);
    expect(TasksChangedPayloadSchema.safeParse({ generation: 0 }).success).toBe(true);
    expect(TasksChangedPayloadSchema.safeParse({ generation: 4, later: "field" }).success).toBe(
      true,
    );
    expect(TasksChangedPayloadSchema.safeParse({ generation: -1 }).success).toBe(false);
    expect(TasksChangedPayloadSchema.safeParse({ generation: 1.5 }).success).toBe(false);
    expect(TasksChangedPayloadSchema.safeParse({}).success).toBe(false);
  });
});

describe("Test 6 (exports)", () => {
  const NAMES = [
    "TASK_FILTERS",
    "TASK_STATUS_DISPLAY",
    "TASK_PRIORITY_DISPLAY",
    "TaskFrontmatterSchema",
    "TASK_FRONTMATTER_KEY_ORDER",
    "taskFileName",
    "isTaskNotePath",
    "localDayBounds",
    "zonedLocalToInstant",
    "TaskCreateRequestSchema",
    "TasksChangedPayloadSchema",
  ];

  it("reaches the browser-safe barrel and the full barrel", () => {
    for (const name of NAMES) {
      expect(Object.keys(browser), `browser ${name}`).toContain(name);
      expect(Object.keys(full), `full ${name}`).toContain(name);
    }
  });

  it("puts the hostile corpus in the full barrel only", () => {
    for (const name of ["HOSTILE_TASK_TITLES", "VALID_HOSTILE_TASK_TITLES", "YAML_NOTE_VARIANTS"]) {
      expect(Object.keys(full), name).toContain(name);
      expect(Object.keys(browser), name).not.toContain(name);
    }
  });

  it("keeps the new modules free of Node built-ins", () => {
    for (const file of ["task-schema.ts", "task-time.ts", "tasks.ts", "task-corpus.ts"]) {
      const code = readFileSync(join(HERE, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(code, file).not.toMatch(/["']node:[a-z/_]+["']/);
      expect(code, file).not.toMatch(/\brequire\s*\(/);
      expect(code, file).not.toMatch(/\bimport\s*\(/);
    }
  });

  it("is reachable through the wildcard export with no package.json edit", () => {
    const manifest = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8")) as {
      exports: Record<string, unknown>;
    };
    expect(Object.keys(manifest.exports)).toEqual([".", "./*.js", "./browser"]);
  });
});
