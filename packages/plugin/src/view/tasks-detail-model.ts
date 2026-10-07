import type { TaskDetail } from "@ccc/domain/tasks.js";
import type { TaskActionResult } from "../tasks/actions.js";
import type { ParsedTask } from "../tasks/task-update.js";
import type { TaskDetailResult, TaskDetailTask } from "./task-detail.js";
import type { TaskFormOption } from "./task-form.js";
import { SAVE_REASONS } from "./tasks-forms-copy.js";

/**
 * Pure helpers that turn what the service and the note say into the detail
 * pane's props and results (plan 06-22; UI-SPEC "Detail and edit pane"). No
 * state, no clock, no I/O.
 */

/** Shown when a selected task's note cannot be read or the service has no such task (invented; flagged). */
export function detailLoadFailedLine(): string {
  return `▲ Couldn't load the task: ${SAVE_REASONS.missing}.`;
}

/** A stored due value as the owner's local wall clock: `time` is empty for an all-day date. */
export function localWallClock(value: string, zone: string): { date: string; time: string } {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { date: value, time: "" };
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return { date: "", time: "" };
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const pick = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  return {
    date: `${pick("year")}-${pick("month")}-${pick("day")}`,
    time: `${pick("hour")}:${pick("minute")}`,
  };
}

export interface DetailModelInput {
  readonly detail: TaskDetail;
  readonly content: string;
  readonly note: ParsedTask;
  readonly zone: string;
  readonly workspaces: readonly TaskFormOption[];
}

/** The pane's task: the service's facts, with the editable values read from the note itself. */
export function buildDetailTask(input: DetailModelInput): TaskDetailTask {
  const { detail, note, zone } = input;
  const fm = note.frontmatter;
  const scope = detail.row.scope;
  const workspace = input.workspaces.find((option) => option.id === scope);
  const generator = fm.generatedBy;
  return {
    id: detail.row.id,
    title: fm.title,
    description: note.body,
    status: fm.status,
    priority: fm.priority ?? null,
    due: fm.due === undefined ? null : localWallClock(fm.due, zone),
    scheduled: fm.scheduled === undefined ? null : localWallClock(fm.scheduled, zone).date,
    projectId: fm.projectId ?? null,
    tags: fm.tags,
    scopeLabel: scope === "global" ? "Global" : (workspace?.name ?? scope),
    parent: detail.parent ?? null,
    blockedBy: detail.blockedBy,
    sourceType: fm.sourceType,
    sourceLink: fm.sourceLink ?? detail.sourceLink ?? null,
    assignee: fm.assignee ?? detail.assignee ?? null,
    createdAt: detail.createdAt,
    updatedAt: detail.row.updatedAt,
    completedAt: detail.row.completedAt ?? null,
    path: detail.path,
    aiGenerated: detail.aiGenerated,
    generatedByLabel: generator?.skill ?? generator?.automation ?? generator?.model ?? null,
    confidence: detail.confidence,
    content: input.content,
  };
}

/** The pane's four result kinds, from an action's outcome. */
export function toDetailResult(result: TaskActionResult): TaskDetailResult {
  switch (result.kind) {
    case "applied":
      return { kind: "applied" };
    case "conflict":
      return { kind: "conflict" };
    case "invalid":
      return { kind: "invalid", fields: result.fields };
    case "unreadable":
      return { kind: result.reason === "read-failed" ? "missing" : "unreadable" };
  }
}

/** The fixed failure reason for a row action that did not apply. */
export function failureReason(result: TaskDetailResult): string {
  switch (result.kind) {
    case "applied":
    case "conflict":
    case "invalid":
      return SAVE_REASONS.changed;
    case "missing":
      return SAVE_REASONS.missing;
    case "unreadable":
      return SAVE_REASONS.unreadable;
  }
}
