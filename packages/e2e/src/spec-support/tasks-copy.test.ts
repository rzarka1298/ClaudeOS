import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../repo-paths.js";
import {
  type CopyTable,
  findCopyDrift,
  LIVE_CHECK_TABLE,
  LIVE_CHECK_TITLES,
  TASKS_CLASSES_TABLE,
  TASKS_TEXT,
  TASKS_TEXT_TABLE,
} from "./tasks-copy.js";

/**
 * Copy-drift guard for the tasks specs (05.2-07, T-05.2-37): every string or class name a tasks
 * spec asserts is mirrored in tasks-copy.ts with the plugin file that owns it, and these tests
 * read those files as text so a reworded label fails here instead of failing a live run.
 */

function realSource(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

describe("findCopyDrift (Test 1, the guard discriminates)", () => {
  const table: CopyTable = {
    label: ["Create a task", "owner.ts", "literal"],
    prefix: ["Accept task: ", "owner.ts", "fragment"],
  };
  const source = ['export const L = "Create a task";', 'const p = "Accept task: " + t;'].join("\n");

  it("reports nothing when every mirrored value is in its owner", () => {
    expect(findCopyDrift(table, () => source)).toEqual([]);
  });

  it("names the key of an altered mirror value", () => {
    const altered: CopyTable = { ...table, label: ["Create a Task", "owner.ts", "literal"] };
    expect(findCopyDrift(altered, () => source)).toEqual(["label"]);
  });

  it("requires the quoted form for a literal and any substring for a fragment", () => {
    const loose = 'const x = "Create a task now";';
    const label: CopyTable = { label: ["Create a task", "owner.ts", "literal"] };
    const prefix: CopyTable = { prefix: ["Accept task: ", "owner.ts", "fragment"] };
    expect(findCopyDrift(label, () => loose)).toEqual(["label"]);
    expect(findCopyDrift(prefix, () => "Accept task: x")).toEqual([]);
  });

  it("reports a missing owner file as drift, never as a pass", () => {
    const missing = (): string => {
      throw new Error("ENOENT");
    };
    expect(findCopyDrift(table, missing)).toEqual(["label", "prefix"]);
  });
});

describe("the mirrored tasks copy and class names (Test 1)", () => {
  it("every mirrored string appears in the plugin source that owns it", () => {
    expect(Object.keys(TASKS_TEXT_TABLE).length).toBeGreaterThan(10);
    expect(findCopyDrift(TASKS_TEXT_TABLE, realSource)).toEqual([]);
  });

  it("every mirrored class name appears in the plugin source that owns it", () => {
    expect(Object.keys(TASKS_CLASSES_TABLE).length).toBeGreaterThan(5);
    expect(findCopyDrift(TASKS_CLASSES_TABLE, realSource)).toEqual([]);
  });

  it("holds the words the plan names for the create-a-task item", () => {
    expect(TASKS_TEXT.createTask).toBe("Create a task");
    expect(TASKS_TEXT.addToInbox).toBe("Add to inbox");
    expect(TASKS_TEXT.addAsReady).toBe("Add as ready");
    expect(TASKS_TEXT.markDone).toBe("Mark done");
    expect(TASKS_TEXT.accept).toBe("Accept");
    expect(TASKS_TEXT.dismiss).toBe("Dismiss");
    expect(TASKS_TEXT.attentionHeading).toBe("Notes need attention");
    expect(TASKS_TEXT.tasksHeading).toBe("Tasks");
  });

  it("names owner files that exist", () => {
    for (const table of [TASKS_TEXT_TABLE, TASKS_CLASSES_TABLE, LIVE_CHECK_TABLE]) {
      for (const [, owner] of Object.values(table)) {
        expect(existsSync(join(REPO_ROOT, owner))).toBe(true);
      }
    }
  });
});

describe("the words the status-change, duplicate and proposed items assert (Task 2 Test 1)", () => {
  it("mirrors the chip, status, name-prefix and duplicate wording", () => {
    expect(TASKS_TEXT.chipProposed).toBe("Proposed");
    expect(TASKS_TEXT.statusDone).toBe("done");
    expect(TASKS_TEXT.statusCancelled).toBe("cancelled");
    expect(TASKS_TEXT.acceptNamePrefix).toBe("Accept task: ");
    expect(TASKS_TEXT.dismissNamePrefix).toBe("Dismiss task: ");
    expect(TASKS_TEXT.duplicateAttention).toBe("Shares its ID with");
    expect(TASKS_TEXT.taskActionsLabel).toBe("Task actions");
    expect(TASKS_TEXT.decisionAccepted).toBe("accepted");
  });

  it("every mirrored live-check title and the source link appears in the fixture that writes it", () => {
    expect(Object.keys(LIVE_CHECK_TABLE).length).toBeGreaterThanOrEqual(4);
    expect(findCopyDrift(LIVE_CHECK_TABLE, realSource)).toEqual([]);
    expect(LIVE_CHECK_TITLES.propertiesDate).toBe("Live check properties style date");
    expect(LIVE_CHECK_TITLES.proposedPlain).toBe("Live check proposed plain");
    expect(LIVE_CHECK_TITLES.proposedWithSource).toBe("Live check proposed with source");
  });

  it("takes the hostile proposed title from the same corpus entry the fixture writes", () => {
    const fixture = realSource("packages/test-fixtures/src/task-fixtures.ts");
    expect(fixture).toContain("VALID_HOSTILE_TASK_TITLES[0]");
    expect(LIVE_CHECK_TITLES.hostile).not.toBe("");
  });
});

describe("the words the views and project panel items assert (Task 3 Test 1)", () => {
  it("mirrors the eight view names in the order the chips use", () => {
    expect([
      TASKS_TEXT.chipAll,
      TASKS_TEXT.chipToday,
      TASKS_TEXT.chipUpcoming,
      TASKS_TEXT.chipOverdue,
      TASKS_TEXT.chipProject,
      TASKS_TEXT.chipProposed,
      TASKS_TEXT.chipBlocked,
      TASKS_TEXT.chipCompleted,
    ]).toEqual([
      "All",
      "Today",
      "Upcoming",
      "Overdue",
      "Project",
      "Proposed",
      "Blocked",
      "Completed",
    ]);
  });

  it("mirrors the Show tasks, panel, empty-line and filter-group wording", () => {
    expect(TASKS_TEXT.showTasksFor).toBe("Show tasks for ");
    expect(TASKS_TEXT.closeProjectTasks).toBe("Close project tasks");
    expect(TASKS_TEXT.emptyAllHeading).toBe("Nothing here yet");
    expect(TASKS_TEXT.taskFiltersLabel).toBe("Task filters");
    expect(TASKS_TEXT.showingPrefix).toBe("Showing ");
    expect(TASKS_TEXT.tabProjects).toBe("Projects");
    expect(TASKS_TEXT.tabProjectsId).toBe("projects");
  });
});
