import { describe, expect, it } from "vitest";
import {
  ADD_AS_READY_LABEL,
  ADD_TO_INBOX_LABEL,
  ADDING_STATUS,
  addedMessage,
  CLOSE_FORM_LABEL,
  createFailedMessage,
  DESCRIPTION_INVALID_MESSAGE,
  DESCRIPTION_TOO_LONG_MESSAGE,
  DISCONNECTED_REASON,
  FIELD_LABELS,
  GLOBAL_SCOPE_LABEL,
  INVALID_DATE_MESSAGE,
  NO_PROJECT_LABEL,
  RELOAD_REPLACE_PROMPT,
  REPLACE_MY_EDITS_LABEL,
  TAG_INVALID_MESSAGE,
  TAG_TOO_LONG_MESSAGE,
  TAGS_HELP,
  TITLE_REQUIRED_MESSAGE,
  TITLE_TOO_LONG_MESSAGE,
  TOO_MANY_TAGS_MESSAGE,
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

describe("Test 2.5: validation and failure strings", () => {
  it("holds the four locked validation messages verbatim", () => {
    expect(TITLE_REQUIRED_MESSAGE).toBe("Enter a title.");
    expect(TITLE_TOO_LONG_MESSAGE).toBe("Use 200 characters or fewer.");
    expect(INVALID_DATE_MESSAGE).toBe("Choose a valid date.");
    expect(TOO_MANY_TAGS_MESSAGE).toBe("Use 20 tags or fewer.");
  });

  it("holds the two tag messages the spec does not fix and the standard disconnected reason", () => {
    expect(TAG_TOO_LONG_MESSAGE).toBe("Use 40 characters or fewer for each tag.");
    expect(TAG_INVALID_MESSAGE).toBe(
      "Use letters, numbers, _, - or / in tags, and not only digits.",
    );
    expect(DISCONNECTED_REASON).toBe("The companion service isn't running.");
  });

  it("names one of three fixed reasons by error code and never echoes the error", () => {
    expect(createFailedMessage({ code: "timeout" })).toBe(
      "Couldn't add the task: the companion service didn't respond within 5 seconds.",
    );
    expect(createFailedMessage({ code: "service-disconnected" })).toBe(
      "Couldn't add the task: the service isn't running.",
    );
    expect(createFailedMessage(new Error("/Users/USERNAME/secret"))).toBe(
      "Couldn't add the task: the vault couldn't be written to.",
    );
  });
});

describe("wave-5 review strings", () => {
  it("holds the description messages and the reload confirmation verbatim", () => {
    expect(DESCRIPTION_TOO_LONG_MESSAGE).toBe("Use 10,000 characters or fewer.");
    expect(DESCRIPTION_INVALID_MESSAGE).toBe("Remove null characters from the description.");
    expect(RELOAD_REPLACE_PROMPT).toBe("Replace your unsaved changes with the latest saved task?");
    expect(REPLACE_MY_EDITS_LABEL).toBe("Replace my edits");
  });
});
