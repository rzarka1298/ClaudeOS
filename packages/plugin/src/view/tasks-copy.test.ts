import { TASK_FILTERS } from "@ccc/domain/tasks.js";
import { describe, expect, it } from "vitest";
import {
  ATTENTION_HEADING,
  acceptName,
  blockedLine,
  CHOOSE_PROJECT_HEADING,
  CREATE_TASK_LABEL,
  chipName,
  chipText,
  DISCONNECTED_HEADING,
  DISCONNECTED_REASON,
  dismissName,
  EMPTY_ALL_BODY,
  EMPTY_ALL_HEADING,
  EMPTY_ALL_PROMPT,
  ERROR_HEADING,
  ERROR_HINT,
  FILTER_EMPTY,
  LOADING_LABEL,
  lastValuesLine,
  markDoneName,
  moreLoadedStatus,
  NOTES_EDITABLE_LINE,
  projectEmpty,
  REBUILDING_LINE,
  showMoreLabel,
  TASK_FILTERS_LABEL,
  TASKS_HEADING,
  tagOverflow,
} from "./tasks-copy.js";

describe("Test 7: the locked strings of the Tasks surfaces", () => {
  it("states the destination, button, toolbar and attention strings verbatim", () => {
    expect(TASKS_HEADING).toBe("Tasks");
    expect(CREATE_TASK_LABEL).toBe("Create a task");
    expect(ATTENTION_HEADING).toBe("Notes need attention");
    expect(TASK_FILTERS_LABEL).toBe("Task filters");
    expect(DISCONNECTED_REASON).toBe("The companion service isn't running.");
  });

  it("labels the eight chips verbatim, in the fixed order", () => {
    expect(TASK_FILTERS.map((filter) => chipText(filter, null))).toEqual([
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

  it("puts the count in the visible text, grouped, and states it in the accessible name", () => {
    expect(chipText("today", 3)).toBe("Today (3)");
    expect(chipText("all", 1234)).toBe("All (1,234)");
    expect(chipName("today", 3)).toBe("Today, 3 tasks");
    expect(chipName("all", 1234)).toBe("All, 1,234 tasks");
  });

  it("never says 1 tasks", () => {
    expect(chipName("overdue", 1)).toBe("Overdue, 1 task");
    expect(chipName("project", 0)).toBe("Project, 0 tasks");
  });

  it("names each row action with a verb and the task, clamping a long title", () => {
    expect(markDoneName("Draft the weekly review")).toBe("Mark done: Draft the weekly review");
    expect(acceptName("Draft the weekly review")).toBe("Accept task: Draft the weekly review");
    expect(dismissName("Draft the weekly review")).toBe("Dismiss task: Draft the weekly review");
    const long = "x".repeat(5000);
    expect(markDoneName(long).length).toBeLessThan(200);
    expect(markDoneName(long).startsWith("Mark done: xxx")).toBe(true);
  });
});

describe("the fixed copy of the destination states", () => {
  it("builds the blocked line plural-safe", () => {
    expect(blockedLine(1)).toBe("‖ Blocked — waiting on 1 unfinished task");
    expect(blockedLine(2)).toBe("‖ Blocked — waiting on 2 unfinished tasks");
  });

  it("builds the tag overflow and the pagination strings", () => {
    expect(tagOverflow(2)).toBe("+2 more");
    expect(showMoreLabel(25)).toBe("Show 25 more");
    expect(showMoreLabel(1)).toBe("Show 1 more");
    expect(moreLoadedStatus(25)).toBe("25 more tasks loaded.");
    expect(moreLoadedStatus(1)).toBe("1 more task loaded.");
  });

  it("states the first-run, loading, error, rebuilding and disconnected lines verbatim", () => {
    expect(LOADING_LABEL).toBe("Loading tasks");
    expect(EMPTY_ALL_HEADING).toBe("Nothing here yet");
    expect(EMPTY_ALL_BODY).toBe("Tasks has no items right now. New items appear as they arrive.");
    expect(EMPTY_ALL_PROMPT).toBe("Create your first task to start your list.");
    expect(ERROR_HEADING).toBe("Couldn't load tasks.");
    expect(ERROR_HINT).toBe("Check the service in Settings → Diagnostics, then refresh.");
    expect(REBUILDING_LINE).toBe("Rebuilding the task index…");
    expect(DISCONNECTED_HEADING).toBe("Service disconnected");
    expect(lastValuesLine("3 minutes ago")).toBe(
      "Showing the last values received 3 minutes ago. They may be out of date.",
    );
    expect(NOTES_EDITABLE_LINE).toBe(
      "Task notes are still editable in Obsidian; the lists catch up when the service is back.",
    );
    expect(CHOOSE_PROJECT_HEADING).toBe("Choose a project to see its tasks.");
  });

  it("has a heading and a next step for every filter, as the UI-SPEC table says", () => {
    expect(FILTER_EMPTY.today).toEqual({
      heading: "Nothing due today.",
      next: "Tasks with a due or scheduled date of today appear here.",
    });
    expect(FILTER_EMPTY.upcoming.heading).toBe("Nothing coming up.");
    expect(FILTER_EMPTY.overdue.heading).toBe("Nothing is overdue.");
    expect(FILTER_EMPTY.project).toEqual({
      heading: "Choose a project to see its tasks.",
      next: "Pick one from the Project list.",
    });
    expect(FILTER_EMPTY.proposed.heading).toBe("No suggested tasks.");
    expect(FILTER_EMPTY.blocked.heading).toBe("Nothing is blocked.");
    expect(FILTER_EMPTY.completed.heading).toBe("Nothing completed yet.");
    expect(FILTER_EMPTY.all).toEqual({ heading: "Nothing here yet", next: EMPTY_ALL_BODY });
    expect(projectEmpty("example-project")).toEqual({
      heading: "No tasks for example-project yet.",
      next: "Create a task and it appears here.",
    });
  });
});
