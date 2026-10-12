/**
 * The frozen mirror of the plugin copy and class names the tasks specs assert (05.2-07,
 * T-05.2-37). The e2e package must not import the plugin, so each value is copied here with the
 * plugin file that owns it, and tasks-copy.test.ts reads those files as text and fails when a
 * mirrored value is no longer in its owner. A reworded label therefore fails in CI, not in a
 * live run. Specs read values from TASKS_TEXT and TASKS_CLASSES, never from a literal.
 */

import { VALID_HOSTILE_TASK_TITLES } from "@ccc/domain";

/** `literal`: the double-quoted form appears in the owner. `fragment`: the text appears anywhere. */
export type CopyKind = "literal" | "fragment";
/** value, owner file (relative to the repository root), kind. */
export type CopyTable = Readonly<Record<string, readonly [string, string, CopyKind]>>;

const VIEW = "packages/plugin/src/view/";
const TASKS_COPY = `${VIEW}tasks-copy.ts`;
const FORMS_COPY = `${VIEW}tasks-forms-copy.ts`;
const DOMAIN_TASKS = "packages/domain/src/tasks.ts";
const DOMAIN_SCHEMA = "packages/domain/src/task-schema.ts";
const SETUP = "packages/plugin/src/setup-command.ts";

export const TASKS_TEXT_TABLE = {
  // Destinations and commands.
  tasksHeading: ["Tasks", TASKS_COPY, "literal"],
  tabTasks: ["Tasks", `${VIEW}destinations.ts`, "literal"],
  tabTasksId: ["tasks", `${VIEW}destinations.ts`, "literal"],
  createTaskCommand: ["create-task", "packages/plugin/src/tasks/commands.ts", "literal"],
  openOverviewCommand: ["open-overview", "packages/plugin/src/main.ts", "literal"],
  setupCommand: ["set-up-managed-vault", SETUP, "literal"],
  setupConfirm: ["Confirm", SETUP, "literal"],
  setupReadyNotice: ["Managed vault ready", SETUP, "fragment"],
  // Labels and names.
  createTask: ["Create a task", TASKS_COPY, "literal"],
  addToInbox: ["Add to inbox", FORMS_COPY, "literal"],
  addAsReady: ["Add as ready", FORMS_COPY, "literal"],
  fieldTitle: ["Title", FORMS_COPY, "literal"],
  markDone: ["Mark done", TASKS_COPY, "literal"],
  accept: ["Accept", TASKS_COPY, "literal"],
  dismiss: ["Dismiss", TASKS_COPY, "literal"],
  disconnectedReason: ["The companion service isn't running.", TASKS_COPY, "literal"],
  attentionHeading: ["Notes need attention", TASKS_COPY, "literal"],
  taskFiltersLabel: ["Task filters", TASKS_COPY, "literal"],
  // The five chip words and statuses the create and status-change items read.
  chipAll: ["All", DOMAIN_TASKS, "literal"],
  chipToday: ["Today", DOMAIN_TASKS, "literal"],
  statusInbox: ["inbox", DOMAIN_SCHEMA, "literal"],
  statusReady: ["ready", DOMAIN_SCHEMA, "literal"],
  // Status change, duplicate and proposed items.
  chipProposed: ["Proposed", DOMAIN_TASKS, "literal"],
  statusDone: ["done", DOMAIN_SCHEMA, "literal"],
  statusCancelled: ["cancelled", DOMAIN_SCHEMA, "literal"],
  acceptNamePrefix: ["Accept task: ", TASKS_COPY, "fragment"],
  dismissNamePrefix: ["Dismiss task: ", TASKS_COPY, "fragment"],
  duplicateAttention: ["Shares its ID with", FORMS_COPY, "fragment"],
  taskActionsLabel: ["Task actions", FORMS_COPY, "literal"],
  decisionAccepted: ["accepted", DOMAIN_SCHEMA, "literal"],
  decisionDismissed: ["dismissed", DOMAIN_SCHEMA, "literal"],
  rowActionAccept: ["accept", `${VIEW}task-list.tsx`, "literal"],
  rowActionDismiss: ["dismiss", `${VIEW}task-list.tsx`, "literal"],
  dueToday: ["Due today", `${VIEW}tasks-format.ts`, "literal"],
  // Typed skeleton (RED): the views and project panel entries carry no value yet.
  chipUpcoming: ["", DOMAIN_TASKS, "literal"],
  chipOverdue: ["", DOMAIN_TASKS, "literal"],
  chipProject: ["", DOMAIN_TASKS, "literal"],
  chipBlocked: ["", DOMAIN_TASKS, "literal"],
  chipCompleted: ["", DOMAIN_TASKS, "literal"],
  showTasksFor: ["", `${VIEW}project-card.tsx`, "fragment"],
  closeProjectTasks: ["", `${VIEW}project-tasks.tsx`, "fragment"],
  emptyAllHeading: ["", TASKS_COPY, "literal"],
  showingPrefix: ["", TASKS_COPY, "fragment"],
  tabProjects: ["", `${VIEW}destinations.ts`, "literal"],
  tabProjectsId: ["", `${VIEW}destinations.ts`, "literal"],
} as const satisfies CopyTable;

export const TASKS_CLASSES_TABLE = {
  tasksSection: ["ccc-tasks", `${VIEW}tasks.tsx`, "fragment"],
  taskRow: ["ccc-task-row", `${VIEW}task-list.tsx`, "fragment"],
  taskTitle: ["ccc-task-title", `${VIEW}task-list.tsx`, "fragment"],
  taskAction: ["ccc-task-action", `${VIEW}task-list.tsx`, "fragment"],
  taskListHeading: ["ccc-task-list-heading", `${VIEW}task-list.tsx`, "fragment"],
  taskMore: ["ccc-task-more", `${VIEW}task-list.tsx`, "fragment"],
  taskForm: ["ccc-task-form", `${VIEW}task-form.tsx`, "fragment"],
  filterChip: ["ccc-filter-chip", `${VIEW}task-chips.tsx`, "fragment"],
  tasksStatus: ["ccc-tasks-status", `${VIEW}tasks-workspace.tsx`, "fragment"],
  taskDetail: ["ccc-task-detail", `${VIEW}task-detail.tsx`, "fragment"],
  taskDate: ["ccc-task-date", `${VIEW}task-list.tsx`, "fragment"],
  taskListEmpty: ["ccc-task-list-empty", `${VIEW}task-list.tsx`, "fragment"],
  stateHeading: ["ccc-state-heading", `${VIEW}task-list.tsx`, "fragment"],
  attentionSection: ["ccc-attention", `${VIEW}attention-list.tsx`, "fragment"],
  attentionRow: ["ccc-attention-row", `${VIEW}attention-list.tsx`, "fragment"],
  attentionTitle: ["ccc-attention-title", `${VIEW}attention-list.tsx`, "fragment"],
  attentionPath: ["ccc-attention-path", `${VIEW}attention-list.tsx`, "fragment"],
  fieldHelp: ["ccc-field-help", `${VIEW}attention-list.tsx`, "fragment"],
  projectPanel: ["ccc-project-tasks", `${VIEW}project-tasks.tsx`, "fragment"],
  tabPrefix: ["ccc-tab-", `${VIEW}destination-tabs.tsx`, "fragment"],
} as const satisfies CopyTable;

/**
 * The synthetic live-check notes the generated live vault carries (`--live-check`). The e2e
 * package must not import the fixtures, so the titles are mirrored and read back from the file
 * that writes them. The hostile proposed title is the first valid entry of the shared hostile
 * corpus, exactly as the fixture picks it.
 */
const FIXTURES = "packages/test-fixtures/src/task-fixtures.ts";
export const LIVE_CHECK_TABLE = {
  propertiesDate: ["Live check properties style date", FIXTURES, "literal"],
  proposedPlain: ["Live check proposed plain", FIXTURES, "literal"],
  proposedWithSource: ["Live check proposed with source", FIXTURES, "literal"],
  sourceLink: ["https://example.invalid/synthetic-source", FIXTURES, "literal"],
} as const satisfies CopyTable;

/** The synthetic host of the source link; a rendered anchor to it would be a failure. */
export const SYNTHETIC_LINK_HOST = "example.invalid";

type Values<T extends CopyTable> = { readonly [K in keyof T]: T[K][0] };

function values<T extends CopyTable>(table: T): Values<T> {
  return Object.fromEntries(
    Object.entries(table).map(([key, entry]) => [key, entry[0]]),
  ) as Values<T>;
}

export const TASKS_TEXT: Values<typeof TASKS_TEXT_TABLE> = Object.freeze(values(TASKS_TEXT_TABLE));
export const TASKS_CLASSES: Values<typeof TASKS_CLASSES_TABLE> = Object.freeze(
  values(TASKS_CLASSES_TABLE),
);
export const LIVE_CHECK_TITLES: Values<typeof LIVE_CHECK_TABLE> & { readonly hostile: string } =
  Object.freeze({
    ...values(LIVE_CHECK_TABLE),
    hostile: VALID_HOSTILE_TASK_TITLES[0] ?? "",
  });

/**
 * The keys of a table whose value is no longer in its owner file. `read` returns the owner's
 * text and may throw; a file that cannot be read counts as drift, never as a pass.
 */
export function findCopyDrift(table: CopyTable, read: (path: string) => string): string[] {
  const drifted: string[] = [];
  for (const [key, [value, owner, kind]] of Object.entries(table)) {
    let source: string;
    try {
      source = read(owner);
    } catch {
      drifted.push(key);
      continue;
    }
    const needle = kind === "literal" ? JSON.stringify(value) : value;
    if (!source.includes(needle)) drifted.push(key);
  }
  return drifted;
}
