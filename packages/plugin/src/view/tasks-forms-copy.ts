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
// Create form: validation and failure

export const TITLE_REQUIRED_MESSAGE = "Enter a title.";
export const TITLE_TOO_LONG_MESSAGE = "Use 200 characters or fewer.";
export const INVALID_DATE_MESSAGE = "Choose a valid date.";
export const TOO_MANY_TAGS_MESSAGE = "Use 20 tags or fewer.";
/** Not fixed by the UI-SPEC (it states the 40-character bound without wording); flagged for the checker. */
export const TAG_TOO_LONG_MESSAGE = "Use 40 characters or fewer for each tag.";
/** Not fixed by the UI-SPEC (it says only that tags follow Obsidian's rules); flagged for the checker. */
export const TAG_INVALID_MESSAGE = "Use letters, numbers, _, - or / in tags, and not only digits.";

/** The one reason every service-backed control gives while the service is away (UI-SPEC E10). */
export { DISCONNECTED_REASON } from "./tasks-copy.js";

/** The three failure reasons the create form may name (UI-SPEC "Create form", Feedback). */
export const CREATE_FAILURE_REASONS = {
  timeout: "the companion service didn't respond within 5 seconds",
  disconnected: "the service isn't running",
  vault: "the vault couldn't be written to",
} as const;

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = error.code;
  return typeof code === "string" ? code : null;
}

/**
 * `Couldn't add the task: {reason}.` The reason is chosen from the error's
 * closed `code` only; no other text of the error is ever shown (it could carry a
 * path or a payload).
 */
export function createFailedMessage(error: unknown): string {
  const code = errorCode(error);
  const reason =
    code === "timeout"
      ? CREATE_FAILURE_REASONS.timeout
      : code === "service-disconnected" || code === "unrecognised-response"
        ? CREATE_FAILURE_REASONS.disconnected
        : CREATE_FAILURE_REASONS.vault;
  return `Couldn't add the task: ${reason}.`;
}
