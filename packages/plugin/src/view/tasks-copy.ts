import { TASK_FILTER_LABELS, type TaskFilter } from "@ccc/domain/tasks.js";

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
