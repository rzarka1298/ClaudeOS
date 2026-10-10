import type { TaskRow } from "@ccc/domain/tasks.js";
import { describe, expect, it } from "vitest";
import { TASK_NOW_MS, TASK_ZONE, taskRow } from "../test-support/task-view-fixtures.js";
import { formatTaskDatePhrase } from "./tasks-format.js";

/**
 * The fixed clock is 2026-10-05 10:00 in New York (14:00 UTC). No test reads
 * the machine clock or the machine zone.
 */
function phrase(row: TaskRow, nowMs = TASK_NOW_MS, zone = TASK_ZONE) {
  return formatTaskDatePhrase(row, nowMs, zone);
}

describe("Test 1: date phrases", () => {
  it("reads Due today for a date due on the local day", () => {
    expect(phrase(taskRow(1, { dueDate: "2026-10-05" }))).toEqual({
      text: "Due today",
      overdue: false,
    });
  });

  it("reads Due {Mon D} for a later date this year", () => {
    expect(phrase(taskRow(1, { dueDate: "2026-10-12" }))?.text).toBe("Due Oct 12");
    expect(phrase(taskRow(1, { dueDate: "2026-10-05" }), TASK_NOW_MS)?.text).not.toContain("Oct");
  });

  it("reads Due {Mon D}, {time} for an instant, in the owner's zone", () => {
    // 19:00 UTC on Oct 8 is 3:00 PM in New York.
    expect(phrase(taskRow(1, { dueAt: "2026-10-08T19:00:00.000Z" }))?.text).toBe(
      "Due Oct 8, 3:00 PM",
    );
    // 03:30 UTC on Oct 6 is still Oct 5, 11:30 PM in New York.
    expect(phrase(taskRow(1, { dueAt: "2026-10-06T03:30:00.000Z" }))?.text).toBe(
      "Due Oct 5, 11:30 PM",
    );
  });

  it("reads Scheduled {Mon D} when only scheduled", () => {
    expect(phrase(taskRow(1, { scheduledDate: "2026-10-06" }))?.text).toBe("Scheduled Oct 6");
    expect(phrase(taskRow(1, { scheduledAt: "2026-10-06T13:00:00.000Z" }))?.text).toBe(
      "Scheduled Oct 6, 9:00 AM",
    );
  });

  it("prefers the due value when both are set", () => {
    expect(phrase(taskRow(1, { dueDate: "2026-10-09", scheduledDate: "2026-10-06" }))?.text).toBe(
      "Due Oct 9",
    );
  });

  it("reads Overdue — due {Mon D} for an overdue task and flags it", () => {
    expect(phrase(taskRow(1, { dueDate: "2026-10-02", overdue: true }))).toEqual({
      text: "Overdue — due Oct 2",
      overdue: true,
    });
    expect(phrase(taskRow(1, { dueAt: "2026-10-02T19:00:00.000Z", overdue: true }))?.text).toBe(
      "Overdue — due Oct 2",
    );
  });

  it("does not call a finished task's past date overdue", () => {
    expect(phrase(taskRow(1, { status: "done", dueDate: "2026-10-02" }))).toEqual({
      text: "Due Oct 2",
      overdue: false,
    });
  });

  it.each(["UTC", "America/Los_Angeles", "Pacific/Auckland", "Asia/Tokyo", "Pacific/Kiritimati"])(
    "never shows a time, or moves the day, for a date-only value in %s",
    (zone) => {
      const text = phrase(taskRow(1, { dueDate: "2026-12-25" }), TASK_NOW_MS, zone)?.text;
      expect(text).toBe("Due Dec 25");
      expect(text).not.toMatch(/\d:\d/);
    },
  );

  it("decides what today is in the owner's zone, not the machine's", () => {
    // 03:30 UTC on Oct 6: still Oct 5 in New York, already Oct 6 in Auckland.
    const lateNight = Date.parse("2026-10-06T03:30:00.000Z");
    const row = taskRow(1, { dueDate: "2026-10-05" });
    expect(phrase(row, lateNight, "America/New_York")?.text).toBe("Due today");
    expect(phrase(row, lateNight, "Pacific/Auckland")?.text).toBe("Due Oct 5");
  });

  it("includes the year when it is not the current year", () => {
    expect(phrase(taskRow(1, { dueDate: "2027-01-15" }))?.text).toBe("Due Jan 15, 2027");
    expect(phrase(taskRow(1, { dueAt: "2027-01-15T20:00:00.000Z" }))?.text).toBe(
      "Due Jan 15, 2027, 3:00 PM",
    );
    expect(phrase(taskRow(1, { scheduledDate: "2025-12-31" }))?.text).toBe(
      "Scheduled Dec 31, 2025",
    );
  });

  it("never uses a slash-separated numeric date", () => {
    for (const row of [
      taskRow(1, { dueDate: "2026-10-12" }),
      taskRow(2, { dueAt: "2027-03-04T18:00:00.000Z" }),
      taskRow(3, { scheduledDate: "2025-01-02" }),
      taskRow(4, { dueDate: "2026-10-02", overdue: true }),
    ]) {
      expect(phrase(row)?.text).not.toMatch(/\//);
    }
  });

  it("gives nothing for a task with no dates", () => {
    expect(phrase(taskRow(1))).toBeNull();
  });

  it("falls back to UTC for a zone the runtime does not know rather than throwing", () => {
    expect(phrase(taskRow(1, { dueDate: "2026-10-12" }), TASK_NOW_MS, "Not/AZone")?.text).toBe(
      "Due Oct 12",
    );
  });
});
