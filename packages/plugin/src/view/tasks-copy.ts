import type { TaskFilter } from "@ccc/domain/tasks.js";

/** Skeleton: the real wording lands with the implementation commit (plan 06-16). */
export const TASKS_HEADING = "";
export const CREATE_TASK_LABEL = "";
export const ATTENTION_HEADING = "";
export const TASK_FILTERS_LABEL = "";
export const MARK_DONE_LABEL = "";
export const ACCEPT_LABEL = "";
export const DISMISS_LABEL = "";
export const DISCONNECTED_REASON = "";

export function chipText(_filter: TaskFilter, _count: number | null): string {
  return "";
}

export function chipName(_filter: TaskFilter, _count: number | null): string {
  return "";
}

export function markDoneName(_title: string): string {
  return "";
}

export function acceptName(_title: string): string {
  return "";
}

export function dismissName(_title: string): string {
  return "";
}

export function showingLine(_shown: number, _total: number): string {
  return "";
}
