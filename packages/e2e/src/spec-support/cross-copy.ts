/**
 * Literal mirror for the cross-cutting specs (05.2-08). The specs may not import from the
 * plugin (e2e leaf element), so every string they match is copied here with its owner named;
 * cross-copy.test.ts reads the owning source file and fails when a literal drifts.
 */
export interface OwnedLiteral {
  readonly name: string;
  readonly value: string;
  /** Repository-relative file that owns the literal. */
  readonly file: string;
  /** True when the product only uses the value as the start of a longer quoted string. */
  readonly prefix?: boolean;
}

const APPROVALS_COPY = "packages/plugin/src/view/approvals-copy.ts";
const SETTINGS_TAB = "packages/plugin/src/view/settings-tab.ts";
const TASKS_COPY = "packages/plugin/src/view/tasks-copy.ts";

/** The plugin's id, as the command-id prefix. Owner: packages/plugin/manifest.json. */
export const PLUGIN_ID = "claude-command-center";

export const DESTINATION_IDS = [
  "overview",
  "projects",
  "research",
  "tasks",
  "agent-runs",
  "skills",
  "knowledge",
  "settings",
] as const;

export const OWNED_LITERALS: readonly OwnedLiteral[] = [
  // Notification (APPR-09): fixed title, never built from a request.
  {
    name: "NOTIFICATION_TITLE",
    value: "Approval needed",
    file: "packages/plugin/src/approvals/notify.ts",
  },
  // The decision group (UI-SPEC S2).
  { name: "DENY_LABEL", value: "Deny", file: APPROVALS_COPY },
  { name: "APPROVE_LABEL", value: "Approve once", file: APPROVALS_COPY },
  { name: "DECISION_GROUP_LABEL", value: "Decision", file: APPROVALS_COPY },
  { name: "FILTER_GROUP_LABEL", value: "Approval filter", file: APPROVALS_COPY },
  {
    name: "AWAITING_EXIT_SENTENCE",
    value: "Carried out. The session is still shutting down.",
    file: APPROVALS_COPY,
  },
  {
    name: "FAILED_REASON_ENDED",
    value: "the session's process had already ended",
    file: APPROVALS_COPY,
  },
  {
    name: "FAILED_REASON_UNLISTED",
    value: "that session is no longer listed",
    file: APPROVALS_COPY,
  },
  {
    name: "FAILED_REASON_MISMATCH",
    value: "the process no longer matches the one you approved",
    file: APPROVALS_COPY,
  },
  {
    name: "FAILED_REASON_OTHER",
    value: "the command center couldn't run it",
    file: APPROVALS_COPY,
  },
  // Settings groups (UI-SPEC S5).
  { name: "SEND_TEST_APPROVAL_NAME", value: "Send a test approval", file: SETTINGS_TAB },
  { name: "APPROVALS_GROUP_HEADING", value: "Approvals", file: SETTINGS_TAB },
  { name: "TASKS_GROUP_HEADING", value: "Tasks", file: SETTINGS_TAB },
  // Tasks.
  { name: "MARK_DONE_LABEL", value: "Mark done", file: TASKS_COPY },
  { name: "TASK_FILTERS_LABEL", value: "Task filters", file: TASKS_COPY },
  // Commands, by id without the plugin prefix.
  {
    name: "COMMAND_OPEN_APPROVAL_INBOX",
    value: "open-approval-inbox",
    file: "packages/plugin/src/approvals/commands.ts",
  },
  {
    name: "COMMAND_SET_UP_MANAGED_VAULT",
    value: "set-up-managed-vault",
    file: "packages/plugin/src/setup-command.ts",
  },
  {
    name: "COMMAND_CREATE_TASK",
    value: "create-task",
    file: "packages/plugin/src/tasks/commands.ts",
  },
  { name: "COMMAND_OPEN_OVERVIEW", value: "open-overview", file: "packages/plugin/src/main.ts" },
  // The vault setup confirmation and the two markers the privacy check greps for.
  { name: "SETUP_CONFIRM_LABEL", value: "Confirm", file: "packages/plugin/src/setup-command.ts" },
  {
    name: "MARKER_TEST_APPROVAL",
    value: "Test approval",
    file: "packages/service/src/executors/diagnostic-test-operation.ts",
  },
  {
    name: "MARKER_LIVE_CHECK",
    value: "Live check",
    file: "packages/test-fixtures/src/task-fixtures.ts",
    prefix: true,
  },
  ...DESTINATION_IDS.map((id) => ({
    name: `DESTINATION_ID_${id.replace("-", "_").toUpperCase()}`,
    value: id,
    file: "packages/plugin/src/view/destinations.ts",
  })),
];

/** Constants the spec itself owns (not read from a product file); listed so the test can name them. */
export const SPEC_OWNED_NAMES: readonly string[] = [
  "SYNTHETIC_MARKERS", // the two grep targets of 06-UAT test 25
  "ALWAYS_ALLOW_PHRASES", // the five phrases of 06-UAT test 12
  "PLUGIN_ID",
  "DESTINATION_IDS",
];

/** 06-UAT test 25: neither may appear in the service log. */
export const SYNTHETIC_MARKERS: readonly string[] = ["Test approval", "Live check"];

export const NOTIFICATION_TITLE = "Approval needed";
export const DENY_LABEL = "Deny";
export const APPROVE_LABEL = "Approve once";

/** 06-UAT test 12: wording that would offer to remember, always allow, allow all, trust or skip. */
export const ALWAYS_ALLOW_PHRASES: readonly string[] = [
  "remember",
  "always",
  "allow all",
  "trust",
  "skip",
];

// Plain exports of the OWNED_LITERALS values the specs use by name; the test pins each to its
// table entry, so a drift in either place fails.
export const DECISION_GROUP_LABEL = "Decision";
export const FILTER_GROUP_LABEL = "Approval filter";
export const AWAITING_EXIT_SENTENCE = "Carried out. The session is still shutting down.";
export const FAILED_REASON_LABELS: readonly string[] = [
  "the session's process had already ended",
  "that session is no longer listed",
  "the process no longer matches the one you approved",
  "the command center couldn't run it",
];
export const SEND_TEST_APPROVAL_NAME = "Send a test approval";
export const APPROVALS_GROUP_HEADING = "Approvals";
export const TASKS_GROUP_HEADING = "Tasks";
export const MARK_DONE_LABEL = "Mark done";
export const TASK_FILTERS_LABEL = "Task filters";
export const SETUP_CONFIRM_LABEL = "Confirm";

/** `claude-command-center:<id>`, the id wdio's command runner takes. */
export const commandId = (id: string): string => `${PLUGIN_ID}:${id}`;
