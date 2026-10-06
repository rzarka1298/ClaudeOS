import { TASK_FILTERS } from "@ccc/domain/tasks.js";
import { describe, expect, it } from "vitest";
import {
  ATTENTION_HEADING,
  acceptName,
  CREATE_TASK_LABEL,
  chipName,
  chipText,
  DISCONNECTED_REASON,
  dismissName,
  markDoneName,
  TASK_FILTERS_LABEL,
  TASKS_HEADING,
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
