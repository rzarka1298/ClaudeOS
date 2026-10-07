import type { ConfidenceState } from "@ccc/domain/note-schema.js";
import type { TaskPriority, TaskStatus } from "@ccc/domain/task-schema.js";
import type { TaskBlockedByEntry } from "@ccc/domain/tasks.js";
import type { Ref, VNode } from "preact";
import type { TaskFormOption } from "./task-form.js";

/**
 * The task detail and edit pane (plan 06-19, UI-SPEC S3 "Detail and edit pane",
 * TASK-01, TASK-04, TASK-05). Props-driven: the saved task, the project list,
 * the connection fact and every function arrive as props. Skeleton: the
 * behaviour arrives with the implementation.
 */

/** The saved task as the pane shows it: the note's own values plus the service's read-only facts. */
export interface TaskDetailTask {
  readonly id: string;
  readonly title: string;
  /** The note body, verbatim. */
  readonly description: string;
  readonly status: TaskStatus;
  readonly priority: TaskPriority | null;
  /** Local wall-clock values; `time` is an empty string for an all-day due date. */
  readonly due: { readonly date: string; readonly time: string } | null;
  readonly scheduled: string | null;
  readonly projectId: string | null;
  readonly tags: readonly string[];
  /** `Global` or a workspace name. */
  readonly scopeLabel: string;
  readonly parent: { readonly id: string; readonly title: string | null } | null;
  readonly blockedBy: readonly TaskBlockedByEntry[];
  readonly sourceType: string;
  readonly sourceLink: string | null;
  readonly assignee: "user" | "claude" | "automation" | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  /** Vault-relative path of the note. Never absolute. */
  readonly path: string;
  readonly aiGenerated: boolean;
  /** The label of whatever generated the task (a skill, an automation or a model), untrusted text. */
  readonly generatedByLabel: string | null;
  readonly confidence: ConfidenceState;
  /** The note's full content when it was read; the base every save is checked against. */
  readonly content: string;
}

/** What the form changed. A key is present only when its field differs from the saved note. */
export interface TaskDetailEdit {
  readonly title?: string;
  readonly description?: string;
  readonly status?: TaskStatus;
  readonly priority?: TaskPriority | null;
  readonly due?: { readonly date: string; readonly time: string | null } | null;
  readonly scheduled?: { readonly date: string } | null;
  readonly projectId?: string | null;
  readonly tags?: readonly string[];
}

export type TaskDetailAction = "mark-done" | "reopen" | "accept" | "dismiss";

export type TaskDetailResult =
  | { readonly kind: "applied" }
  | { readonly kind: "conflict" }
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "invalid"; readonly fields: Readonly<Record<string, string>> };

export interface TaskDetailProps {
  readonly task: TaskDetailTask | null;
  readonly projects: readonly TaskFormOption[];
  readonly connected: boolean;
  readonly zone: string;
  readonly nowMs: number;
  readonly onSave: (
    edit: TaskDetailEdit,
    expectedPriorContent: string,
  ) => Promise<TaskDetailResult>;
  readonly onAction: (action: TaskDetailAction) => Promise<TaskDetailResult>;
  readonly onReload: () => Promise<void>;
  readonly onOpenNote: (path: string) => void;
  readonly onSelectTask: (id: string) => void;
  readonly onStatus: (text: string) => void;
  readonly onNotice: (text: string) => void;
  readonly onDirtyChange?: (dirty: boolean) => void;
  /** Set by the container when the owner tries to leave while the pane is dirty. */
  readonly leaveRequest?: boolean;
  readonly onLeaveDecision?: (decision: "discard" | "keep") => void;
  readonly headingRef?: Ref<HTMLHeadingElement>;
}

/** Skeleton: delivers nothing until the implementation lands. */
export function TaskDetail(_props: TaskDetailProps): VNode | null {
  return null;
}
