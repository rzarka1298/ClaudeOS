/**
 * Fixed strings for the task create form, the detail and edit pane and the
 * notes-need-attention list (plan 06-19, UI-SPEC S3 "Create form", "Detail and
 * edit pane", "Proposed tasks", "Notes need attention"). One module, so the
 * wording lives in one reviewable place. Sentence case; nothing here names a
 * path, a payload or an error message. A string that names task text takes it
 * as an argument and the caller renders it as a text node.
 */

// ---------------------------------------------------------------------------
// Create form: buttons, fields, status

export const ADD_TO_INBOX_LABEL = "Add to inbox";
export const ADD_AS_READY_LABEL = "Add as ready";
export const CLOSE_FORM_LABEL = "Close form";
export const ADDING_STATUS = "Adding the task…";
export const TAGS_HELP = "Separate tags with commas.";

export const FIELD_LABELS = {
  title: "Title",
  description: "Description",
  priority: "Priority",
  due: "Due",
  dueTime: "Due time",
  scheduled: "Scheduled",
  project: "Project",
  scope: "Scope",
  tags: "Tags",
} as const;

export const NO_PROJECT_LABEL = "No project";
export const GLOBAL_SCOPE_LABEL = "Global";

/** The success line, used for both the polite status line and the Notice. `title` is task text. */
export function addedMessage(title: string, intent: "inbox" | "ready"): string {
  const where = intent === "inbox" ? "to the inbox" : "as ready";
  return `Added "${title}" ${where}. Find it under All.`;
}

// ---------------------------------------------------------------------------
// Create form: validation and failure (skeleton until the validation pass)

export const TITLE_REQUIRED_MESSAGE = "";
export const TITLE_TOO_LONG_MESSAGE = "";
export const INVALID_DATE_MESSAGE = "";
export const TOO_MANY_TAGS_MESSAGE = "";
export const TAG_TOO_LONG_MESSAGE = "";
export const TAG_INVALID_MESSAGE = "";
export const DISCONNECTED_REASON = "";

/** `Couldn't add the task: {reason}.` for an error with an optional closed `code`. */
export function createFailedMessage(_error: unknown): string {
  return "";
}
