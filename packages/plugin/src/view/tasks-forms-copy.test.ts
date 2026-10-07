import { describe, expect, it } from "vitest";
import {
  ADD_AS_READY_LABEL,
  ADD_TO_INBOX_LABEL,
  ADDING_STATUS,
  addedMessage,
  CLOSE_FORM_LABEL,
  FIELD_LABELS,
  GLOBAL_SCOPE_LABEL,
  NO_PROJECT_LABEL,
  TAGS_HELP,
} from "./tasks-forms-copy.js";

describe("Test 5: the create-form strings are the locked ones (UI-SPEC S3 Create form)", () => {
  it("holds the three button labels verbatim", () => {
    expect(ADD_TO_INBOX_LABEL).toBe("Add to inbox");
    expect(ADD_AS_READY_LABEL).toBe("Add as ready");
    expect(CLOSE_FORM_LABEL).toBe("Close form");
  });

  it("holds the field labels, help and defaults verbatim", () => {
    expect(FIELD_LABELS).toEqual({
      title: "Title",
      description: "Description",
      priority: "Priority",
      due: "Due",
      dueTime: "Due time",
      scheduled: "Scheduled",
      project: "Project",
      scope: "Scope",
      tags: "Tags",
    });
    expect(TAGS_HELP).toBe("Separate tags with commas.");
    expect(NO_PROJECT_LABEL).toBe("No project");
    expect(GLOBAL_SCOPE_LABEL).toBe("Global");
  });

  it("holds the progress and success lines verbatim", () => {
    expect(ADDING_STATUS).toBe("Adding the task…");
    expect(addedMessage("Pay rent", "inbox")).toBe(
      'Added "Pay rent" to the inbox. Find it under All.',
    );
    expect(addedMessage("Pay rent", "ready")).toBe('Added "Pay rent" as ready. Find it under All.');
  });
});
