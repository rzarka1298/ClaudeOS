import type { TaskFrontmatter } from "@ccc/domain/task-schema.js";
import { TaskFrontmatterSchema } from "@ccc/domain/task-schema.js";
import type { TaskEditVault } from "../tasks/task-update.js";
import type { FakeVault } from "./fake-obsidian-host.js";

/**
 * Task note fixtures for the plugin's write-path tests (plan 06-18). Everything
 * is synthetic. The golden strings below were produced by `@ccc/vault-repo`'s
 * `stringifyTaskNote` (the service writer) when this plan was authored and are
 * committed verbatim: the plugin cannot import that package (the boundary map
 * forbids it), so byte parity is a pair of goldens, and 06-25's cross-package
 * test reuses these exact strings unchanged.
 */

export const TASK_ID = "a0123456789abcdefghijklmn";
export const TASK_PATH = "global/tasks/draft-the-weekly-review-ghijklmn.md";
export const NOW = "2026-10-06T10:30:00.000Z";

/** The task the golden below was serialised from. */
export const GOLDEN_TASK_FRONTMATTER: TaskFrontmatter = TaskFrontmatterSchema.parse({
  id: TASK_ID,
  scope: "global",
  stage: "capture",
  created: "2026-10-01T09:00:00.000Z",
  updated: "2026-10-05T12:00:00.000Z",
  generatedBy: { automation: "daily-brief", runId: "run-7" },
  aiGenerated: true,
  claimType: "summary",
  sources: ["note:abc"],
  confidence: "inferred",
  lastReviewed: null,
  type: "task",
  title: 'Review: the "Q4" plan # now',
  status: "done",
  priority: "high",
  due: "2026-10-09",
  scheduled: "2026-10-07T15:00:00-04:00",
  completed: "2026-10-05T12:00:00.000Z",
  projectId: "mfz0a1b2c0123456789abcdef",
  assignee: "user",
  sourceType: "manual",
  sourceLink: "https://example.test/a?b=1",
  parent: "b0123456789abcdefghijklmn",
  dependencies: ["c0123456789abcdefghijklmn"],
  tags: ["work", "q4/plan"],
  decision: { outcome: "accepted", at: "2026-10-02T08:00:00.000Z" },
});

export const GOLDEN_PASSTHROUGH: readonly (readonly [string, unknown])[] = [
  ["aliases", ["Q4"]],
  ["cssclasses", ["wide"]],
  ["obs-key", "2026-10-04"],
];

export const GOLDEN_BODY = "Line one.\n\n---\nnot a delimiter\n";

/** The service writer's bytes for {@link GOLDEN_TASK_FRONTMATTER}, {@link GOLDEN_PASSTHROUGH} and {@link GOLDEN_BODY}. */
export const GOLDEN_TASK_NOTE = [
  "---",
  `id: ${TASK_ID}`,
  "scope: global",
  "stage: capture",
  "created: '2026-10-01T09:00:00.000Z'",
  "updated: '2026-10-05T12:00:00.000Z'",
  "generatedBy:",
  "  automation: daily-brief",
  "  runId: run-7",
  "aiGenerated: true",
  "claimType: summary",
  "sources:",
  "  - 'note:abc'",
  "confidence: inferred",
  "lastReviewed: null",
  "type: task",
  "title: 'Review: the \"Q4\" plan # now'",
  "status: done",
  "priority: high",
  "due: '2026-10-09'",
  "scheduled: '2026-10-07T15:00:00-04:00'",
  "completed: '2026-10-05T12:00:00.000Z'",
  "projectId: mfz0a1b2c0123456789abcdef",
  "assignee: user",
  "sourceType: manual",
  "sourceLink: 'https://example.test/a?b=1'",
  "parent: b0123456789abcdefghijklmn",
  "dependencies:",
  "  - c0123456789abcdefghijklmn",
  "tags:",
  "  - work",
  "  - q4/plan",
  "decision:",
  "  outcome: accepted",
  "  at: '2026-10-02T08:00:00.000Z'",
  "aliases:",
  "  - Q4",
  "cssclasses:",
  "  - wide",
  "obs-key: '2026-10-04'",
  "---",
  "Line one.",
  "",
  "---",
  "not a delimiter",
  "",
].join("\n");

/** The body of {@link OPEN_NOTE}: markdown the owner wrote, which no edit may disturb. */
export const OPEN_BODY =
  "Body with **markdown** and a table.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [ ] item\n";

/**
 * A ready task as the Obsidian Properties editor leaves it: an UNQUOTED date,
 * a flow-style key and keys this system does not own, in the owner's order.
 */
export const OPEN_NOTE = [
  "---",
  `id: ${TASK_ID}`,
  "scope: global",
  "stage: capture",
  "created: '2026-10-01T09:00:00.000Z'",
  "updated: '2026-10-01T09:00:00.000Z'",
  "generatedBy: {}",
  "aiGenerated: false",
  "sources: []",
  "confidence: unverified",
  "lastReviewed: null",
  "type: task",
  "title: Draft the weekly review",
  "status: ready",
  "priority: high",
  "due: 2026-10-09",
  "sourceType: manual",
  "dependencies: []",
  "tags: [work]",
  "zeta: 1",
  "aliases: [Weekly]",
  "cssclasses: wide",
  "---",
  OPEN_BODY,
].join("\n");

/** {@link OPEN_NOTE} after completing it at {@link NOW}: only status, completed and updated move; owned keys are re-dumped canonically; passthrough keys follow in read order. */
export const COMPLETED_NOTE = [
  "---",
  `id: ${TASK_ID}`,
  "scope: global",
  "stage: capture",
  "created: '2026-10-01T09:00:00.000Z'",
  `updated: '${NOW}'`,
  "generatedBy: {}",
  "aiGenerated: false",
  "sources: []",
  "confidence: unverified",
  "lastReviewed: null",
  "type: task",
  "title: Draft the weekly review",
  "status: done",
  "priority: high",
  "due: '2026-10-09'",
  `completed: '${NOW}'`,
  "sourceType: manual",
  "dependencies: []",
  "tags:",
  "  - work",
  "zeta: 1",
  "aliases:",
  "  - Weekly",
  "cssclasses: wide",
  "---",
  OPEN_BODY,
].join("\n");

/**
 * Wraps a {@link FakeVault} as the structural vault the task update path takes:
 * the fake's own `process` plus an async `read`, the shape Obsidian's
 * `Vault.read` has. No cast of a real class is involved.
 */
export function taskEditVault(vault: FakeVault): TaskEditVault {
  return {
    process: (file, fn) => vault.process(file, fn),
    read: (file) => Promise.resolve(vault.read(file.path)),
  };
}
