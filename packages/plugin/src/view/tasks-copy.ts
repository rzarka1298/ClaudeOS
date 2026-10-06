import { TASK_FILTER_LABELS, TASK_STATUS_DISPLAY, type TaskFilter } from "@ccc/domain/tasks.js";

/**
 * Every locked and fixed string, vocabulary and message builder for the Tasks
 * surfaces (UI-SPEC "Copywriting Contract", S3, S4). One module, so the wording
 * lives in one reviewable place and the source scan has one file to read for
 * it. Sentence case throughout; counts and plurals through `Intl`.
 *
 * Nothing here knows about a path, a payload or an error message: a string that
 * names task text takes it as an argument and the caller renders it as a text
 * node.
 */

// ---------------------------------------------------------------------------
// Locked labels

export const TASKS_HEADING = "Tasks";
export const CREATE_TASK_LABEL = "Create a task";
export const ATTENTION_HEADING = "Notes need attention";
export const TASK_FILTERS_LABEL = "Task filters";

export const MARK_DONE_LABEL = "Mark done";
export const ACCEPT_LABEL = "Accept";
export const DISMISS_LABEL = "Dismiss";

/** The one reason every service-backed control gives while the service is away (UI-SPEC E10). */
export const DISCONNECTED_REASON = "The companion service isn't running.";

// ---------------------------------------------------------------------------
// Counts

const NUMBER = new Intl.NumberFormat("en");
const PLURAL = new Intl.PluralRules("en");

/** `1,234` — grouped, never `1234`. */
export function formatCount(count: number): string {
  return NUMBER.format(count);
}

/** `1 task`, `3 tasks`, `0 tasks` (never `1 tasks`). */
export function taskCount(count: number): string {
  const noun = PLURAL.select(count) === "one" ? "task" : "tasks";
  return `${formatCount(count)} ${noun}`;
}

// ---------------------------------------------------------------------------
// Chips

/** The visible chip text: the label, then the count in parentheses once known. */
export function chipText(filter: TaskFilter, count: number | null): string {
  const label = TASK_FILTER_LABELS[filter];
  return count === null ? label : `${label} (${formatCount(count)})`;
}

/** The accessible name states the number in words: `Today, 3 tasks`. */
export function chipName(filter: TaskFilter, count: number | null): string {
  const label = TASK_FILTER_LABELS[filter];
  return count === null ? label : `${label}, ${taskCount(count)}`;
}

// ---------------------------------------------------------------------------
// Row actions

/** The accessible names are clamped so a long title cannot swamp a screen reader. */
const NAME_CLAMP = 120;

function clamp(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max).join("")}…`;
}

export function markDoneName(title: string): string {
  return `${MARK_DONE_LABEL}: ${clamp(title, NAME_CLAMP)}`;
}

export function acceptName(title: string): string {
  return `Accept task: ${clamp(title, NAME_CLAMP)}`;
}

export function dismissName(title: string): string {
  return `Dismiss task: ${clamp(title, NAME_CLAMP)}`;
}

// ---------------------------------------------------------------------------
// Volume

/** The muted line above the list (UI-SPEC "Volume"). */
export function showingLine(shown: number, total: number): string {
  return `Showing ${formatCount(shown)} of ${formatCount(total)}`;
}

// ---------------------------------------------------------------------------
// Row meta

/** `Blocked — waiting on 2 unfinished tasks`: the words after the glyph. */
export function blockedWords(unmet: number): string {
  const noun = PLURAL.select(unmet) === "one" ? "task" : "tasks";
  return `Blocked — waiting on ${formatCount(unmet)} unfinished ${noun}`;
}

/** `‖ Blocked — waiting on 2 unfinished tasks` (the status label itself is never rewritten). */
export function blockedLine(unmet: number): string {
  return `${TASK_STATUS_DISPLAY.blocked.glyph} ${blockedWords(unmet)}`;
}

/** `+2 more`, for the tags past the three a row shows. */
export function tagOverflow(hidden: number): string {
  return `+${formatCount(hidden)} more`;
}

// ---------------------------------------------------------------------------
// Pagination

export function showMoreLabel(remaining: number): string {
  return `Show ${formatCount(remaining)} more`;
}

/** The polite status line after a page arrives: `25 more tasks loaded.` */
export function moreLoadedStatus(count: number): string {
  const noun = PLURAL.select(count) === "one" ? "task" : "tasks";
  return `${formatCount(count)} more ${noun} loaded.`;
}

// ---------------------------------------------------------------------------
// Destination states

export const LOADING_LABEL = "Loading tasks";
export const ERROR_HEADING = "Couldn't load tasks.";
export const ERROR_HINT = "Check the service in Settings → Diagnostics, then refresh.";
export const REBUILDING_LINE = "Rebuilding the task index…";
export const DISCONNECTED_HEADING = "Service disconnected";
export const NOTES_EDITABLE_LINE =
  "Task notes are still editable in Obsidian; the lists catch up when the service is back.";
export const CHOOSE_PROJECT_HEADING = "Choose a project to see its tasks.";

export const EMPTY_ALL_HEADING = "Nothing here yet";
export const EMPTY_ALL_BODY = "Tasks has no items right now. New items appear as they arrive.";
export const EMPTY_ALL_PROMPT = "Create your first task to start your list.";

export interface EmptyLines {
  readonly heading: string;
  readonly next: string;
}

/** The per-filter empty lines (UI-SPEC "Per-filter empty lines"). Each ends with a next step. */
export const FILTER_EMPTY: Readonly<Record<TaskFilter, EmptyLines>> = {
  all: { heading: EMPTY_ALL_HEADING, next: EMPTY_ALL_BODY },
  today: {
    heading: "Nothing due today.",
    next: "Tasks with a due or scheduled date of today appear here.",
  },
  upcoming: { heading: "Nothing coming up.", next: "Tasks dated after today appear here." },
  overdue: { heading: "Nothing is overdue.", next: "Open tasks past their due date appear here." },
  project: { heading: CHOOSE_PROJECT_HEADING, next: "Pick one from the Project list." },
  proposed: {
    heading: "No suggested tasks.",
    next: "Tasks suggested by skills or automations appear here for you to accept or dismiss.",
  },
  blocked: {
    heading: "Nothing is blocked.",
    next: "Tasks marked blocked, or waiting on unfinished tasks, appear here.",
  },
  completed: { heading: "Nothing completed yet.", next: "Tasks you mark done appear here." },
};

/** The Project filter with a project chosen and nothing in it. `project` is untrusted text. */
export function projectEmpty(project: string): EmptyLines {
  return {
    heading: `No tasks for ${project} yet.`,
    next: "Create a task and it appears here.",
  };
}

/** The disconnected sentence; `received` is a relative time such as `3 minutes ago`, when known. */
export function lastValuesLine(received: string | null): string {
  const when = received === null ? "" : ` ${received}`;
  return `Showing the last values received${when}. They may be out of date.`;
}
