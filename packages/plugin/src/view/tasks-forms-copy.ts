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

// ---------------------------------------------------------------------------
// Detail and edit pane

export const DETAIL_EMPTY_PROMPT = "Select a task to see its details and edit it.";
export const TASK_ACTIONS_LABEL = "Task actions";
export const STATUS_FIELD_LABEL = "Status";
export const SAVE_CHANGES_LABEL = "Save changes";
export const REVERT_CHANGES_LABEL = "Revert changes";
export const REOPEN_TASK_LABEL = "Reopen task";
export const ACCEPT_TASK_LABEL = "Accept task";
export const DISMISS_TASK_LABEL = "Dismiss task";
export const OPEN_NOTE_LABEL = "Open note";
export const RELOAD_TASK_LABEL = "Reload task";
export const DISCARD_CHANGES_LABEL = "Discard changes";
export const KEEP_EDITING_LABEL = "Keep editing";

export const UNSAVED_CHANGES_LABEL = "Unsaved changes";
export const SAVING_STATUS = "Saving…";
export const SAVED_STATUS = "Saved.";
export const CONFLICT_LINE =
  "▲ This task changed in its note while you were editing. Reload it to see the latest, then make your change again.";
export const CHANGED_OUTSIDE_LINE =
  "The note changed outside this form. Saving will ask you to reload first.";

/** The three save and action failure reasons (UI-SPEC "Saving"). */
export const SAVE_REASONS = {
  changed: "the note changed while you were editing",
  missing: "the note is no longer in the vault",
  unreadable: "the note's metadata couldn't be read",
} as const;

export function saveFailedLine(reason: string): string {
  return `▲ Couldn't save the task: ${reason}.`;
}

/** The inline confirmation that replaces the actions while changes are unsaved. `title` is task text. */
export function discardPrompt(title: string): string {
  return `Discard changes to "${title}"?`;
}

export const FACT_LABELS = {
  scope: "Scope",
  parent: "Parent",
  blockedBy: "Blocked by",
  source: "Source",
  assignee: "Assignee",
  created: "Created",
  updated: "Updated",
  completed: "Completed",
  taskId: "Task ID",
  note: "Note",
} as const;

export const NONE_LABEL = "None";
export const NOT_PROVIDED_LABEL = "Not provided";
export const ASSIGNEE_LABELS = { user: "You", claude: "Claude", automation: "Automation" } as const;
export const DETAIL_HINT =
  "Parents and dependencies are edited in the note. Scope can't be changed here.";
export const BLOCKED_NO_DEPENDENCIES = "Marked blocked with no dependencies listed.";
export const SOURCE_UNTOUCHED_NOTE =
  "Marking this done changes only this note. The source isn't touched.";
export const SUGGESTIONS_NOTE =
  "Suggestions are not approval requests. Accepting or dismissing only changes this note.";
export const AI_GENERATED_BADGE = "AI-generated";
/** Not fixed by the UI-SPEC: a suggested task with no generator label. Flagged for the checker. */
export const SUGGESTED_BY_UNNAMED = "Suggested by an unnamed source";
/** Not fixed by the UI-SPEC: a task whose project is no longer registered. Flagged for the checker. */
export const PROJECT_NOT_REGISTERED_LABEL = "Project not registered";

/** The longest generated-by label shown (UI-SPEC E10 long-text). */
const LABEL_CAP = 64;

/** Caps task-supplied label text at 64 characters, with an ellipsis when it was cut. */
export function capLabel(label: string): string {
  const chars = Array.from(label);
  return chars.length <= LABEL_CAP ? label : `${chars.slice(0, LABEL_CAP).join("")}…`;
}

export function suggestedBy(label: string): string {
  return `Suggested by ${capLabel(label)}`;
}

export function providedBy(label: string): string {
  return `Provided by ${capLabel(label)}`;
}

export function confidenceBadge(confidence: string): string {
  return `Confidence: ${confidence}`;
}

/** `A task this depends on can't be found (000007)`, in monospace, naming the last six characters of the id. */
export function dependencyMissing(id: string): string {
  return `A task this depends on can't be found (${id.slice(-6)})`;
}

/** Not fixed by the UI-SPEC: the parent link of a task whose parent is gone. Flagged for the checker. */
export function parentMissing(id: string): string {
  return `The parent task can't be found (${id.slice(-6)})`;
}

export function acceptedNotice(title: string): string {
  return `Accepted "${title}". It's now ready.`;
}

export function dismissedNotice(title: string): string {
  return `Dismissed "${title}". It's kept under All as cancelled.`;
}

/** Not fixed by the UI-SPEC (only Accept and Dismiss have notices); flagged for the checker. */
export function doneNotice(title: string): string {
  return `Marked "${title}" done.`;
}

/** Not fixed by the UI-SPEC; flagged for the checker. */
export function reopenedNotice(title: string): string {
  return `Reopened "${title}".`;
}

export type DetailActionKind = "mark-done" | "reopen" | "accept" | "dismiss";

const ACTION_PHRASES: Readonly<Record<DetailActionKind, string>> = {
  "mark-done": "mark the task done",
  reopen: "reopen the task",
  accept: "accept the task",
  dismiss: "dismiss the task",
};

/** `Couldn't accept the task: {reason}.` */
export function actionFailedLine(action: DetailActionKind, reason: string): string {
  return `Couldn't ${ACTION_PHRASES[action]}: ${reason}.`;
}

/** The success notice for an action; `title` is task text. */
export function actionNotice(action: DetailActionKind, title: string): string {
  switch (action) {
    case "accept":
      return acceptedNotice(title);
    case "dismiss":
      return dismissedNotice(title);
    case "mark-done":
      return doneNotice(title);
    case "reopen":
      return reopenedNotice(title);
  }
}

// ---------------------------------------------------------------------------
// Notes need attention

export const ATTENTION_INTRO =
  "These task notes share an ID, are missing one, or can't be read, so they're left out of the lists above. Nothing was changed for you.";
export const ATTENTION_MISSING_ID = "Missing its ID";
export const ATTENTION_UNREADABLE = "Its metadata couldn't be read";

const ATTENTION_PLURAL = new Intl.PluralRules("en");

/** `Shares its ID with 2 other notes: b.md, c.md`. `names` are file names, untrusted text. */
export function attentionDuplicate(names: readonly string[]): string {
  if (names.length === 0) return "Shares its ID with another note";
  const noun = ATTENTION_PLURAL.select(names.length) === "one" ? "note" : "notes";
  return `Shares its ID with ${names.length} other ${noun}: ${names.join(", ")}`;
}
