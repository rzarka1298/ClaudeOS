import type { TaskDetailTask } from "../view/task-detail.js";
import { projectIdFor, taskId } from "./task-view-fixtures.js";

/**
 * A saved task for the detail pane tests (plan 06-19). Synthetic; every value
 * is fixed so nothing depends on the clock or the machine. Overrides replace
 * keys wholesale.
 */
export function detailTask(overrides: Partial<TaskDetailTask> = {}): TaskDetailTask {
  return {
    id: taskId(1),
    title: "Write the report",
    description: "Two pages.",
    status: "ready",
    priority: "high",
    due: { date: "2026-10-09", time: "" },
    scheduled: "2026-10-08",
    projectId: projectIdFor(1),
    tags: ["work", "deep"],
    scopeLabel: "Global",
    parent: null,
    blockedBy: [],
    sourceType: "manual",
    sourceLink: null,
    assignee: "user",
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-04T10:00:00.000Z",
    completedAt: null,
    path: "tasks/write-the-report.md",
    aiGenerated: false,
    generatedByLabel: null,
    confidence: "verified",
    content: "---\nid: x\n---\nTwo pages.\n",
    ...overrides,
  };
}

/** A task a skill suggested: proposed, automation-assigned and AI-generated. */
export function suggestedTask(overrides: Partial<TaskDetailTask> = {}): TaskDetailTask {
  return detailTask({
    status: "proposed",
    assignee: "automation",
    aiGenerated: true,
    generatedByLabel: "weekly-digest",
    confidence: "unverified",
    sourceType: "email",
    sourceLink: "mail-thread-0001",
    ...overrides,
  });
}
