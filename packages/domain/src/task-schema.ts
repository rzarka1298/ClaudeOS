import { z } from "zod";
import {
  NOTE_FRONTMATTER_KEY_ORDER,
  NOTE_ID_PATTERN,
  NoteFrontmatterSchema,
} from "./note-schema.js";
import { ProjectIdSchema } from "./projects.js";

/**
 * The canonical task contract (plan 06-05; ADR-0004, ADR-0020, D-29, D-30,
 * D-36, research Pattern 11 and spike S1).
 *
 * A task is one Markdown note whose frontmatter is the twelve provenance keys
 * every managed note carries (`NoteFrontmatterSchema`, not forked) plus the
 * task keys below. Three things are fixed here so every reader and writer
 * agrees on them:
 *
 * - the SCHEMA, which every parse validates against and never repairs;
 * - the KEY ORDER, which is the only thing that makes a rewrite byte-identical
 *   (a serializer walks {@link TASK_FRONTMATTER_KEY_ORDER}; it never delegates
 *   order to a YAML library option), with the twelve provenance keys as a
 *   literal prefix so the ADR-0020 managed block reads the same in every note;
 * - the LIMITS, exported for parsers to enforce BEFORE parsing (alias and
 *   size amplification, threat T-06-26).
 *
 * The schema, the order array and the tests in `task-schema.test.ts` move
 * together (ADR-0020): a key added to one and not the others fails a test.
 *
 * This file is Node-free: it is reachable from the plugin's browser bundle.
 */

/** The folder, directly under a managed scope root, that holds one scope's tasks (D-31). */
export const TASKS_FOLDER_NAME = "tasks";

/**
 * A frontmatter block above this many bytes is refused before parsing. YAML
 * aliases can expand a few kilobytes into megabytes when traversed, and the
 * parser has no alias limit of its own (T-06-26).
 */
export const TASK_FRONTMATTER_MAX_BYTES = 64 * 1024;

/** A whole task file above this many bytes is refused before it is read into a parser (T-06-26). */
export const TASK_FILE_MAX_BYTES = 256 * 1024;

/**
 * The seven task statuses (PRD 7.5, D-30). `proposed` is a task an automation
 * suggested; it is not an approval request (D-36). A task with no priority has
 * the key absent, never a sentinel value.
 */
export const TASK_STATUSES = [
  "inbox",
  "proposed",
  "ready",
  "in-progress",
  "blocked",
  "done",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ["urgent", "high", "medium", "low"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/**
 * True for an actionable status: not finished (`done`, `cancelled`) and not a
 * suggestion waiting for a decision (`proposed`). Proposed tasks appear only
 * under the Proposed and All views, so they never reach Today, Overdue,
 * Upcoming, Project or Blocked (research Pattern 12, D-33).
 */
export function isOpenTaskStatus(status: TaskStatus): boolean {
  return status !== "done" && status !== "cancelled" && status !== "proposed";
}

/** Control (Cc), format (Cf), line-separator (Zl) and paragraph-separator (Zp) code points. */
const DISALLOWED_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * True when `value` carries a control, format, line-separator or
 * paragraph-separator character. Format characters are the bidi overrides,
 * zero-width characters, soft hyphen, byte-order mark and tag characters: a
 * title is shown as a row label, so a character that reorders or hides text
 * is refused rather than displayed (spike S12). A newline would let one value
 * become two frontmatter lines.
 */
export function hasDisallowedTextCharacter(value: string): boolean {
  return DISALLOWED_TEXT.test(value);
}

function singleLineText(max: number) {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !hasDisallowedTextCharacter(value), {
      message: "must be one line with no control or invisible format characters",
    });
}

/**
 * A task title: one line, 1 to 200 characters, not blank, with no control,
 * format or separator character. Stored exactly as authored; never trimmed or
 * coerced on read (a hand-edited unquoted `12:30:45` loads as a number, fails
 * here, and lands in the attention list).
 */
export const TaskTitleSchema = singleLineText(200).refine((value) => value.trim().length > 0, {
  message: "must not be blank",
});

/**
 * A calendar date (`2026-10-09`, all-day) or an offset instant
 * (`2026-10-09T15:00:00-04:00` or `...Z`). The authored string is preserved in
 * the note; the index derives two mutually exclusive columns from it so a
 * later time-zone change cannot move an all-day task. An offset-less datetime
 * is refused because it names no instant.
 */
export const TaskDateSchema = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);

/** An instant with an explicit offset or `Z`. */
export const TaskInstantSchema = z.iso.datetime({ offset: true });

/**
 * One Obsidian tag without its leading `#`: letters, digits, underscore,
 * hyphen and slash, at most 64 characters, never all digits (Obsidian's own
 * rule). No space, comma or `#` can occur, so a tag cannot break a flow
 * sequence or a Markdown line.
 */
export const TaskTagSchema = z
  .string()
  .max(64)
  .regex(/^(?=.*\D)[\p{L}\p{N}_/-]+$/u, { message: "must be a valid Obsidian tag" });

/** A task id, parent or dependency: a note id, never a path or a title (D-29). */
export const TaskIdSchema = z.string().regex(NOTE_ID_PATTERN, { message: "must be a note id" });

/**
 * The owner's decision on a proposed task (D-36, research Open Question 1): a
 * top-level optional key, not part of the producer map, because a decision is
 * made by the owner after the fact. Strict so a hand-edit cannot smuggle
 * another key into it.
 */
export const TaskDecisionSchema = z.strictObject({
  outcome: z.enum(["accepted", "dismissed"]),
  at: z.iso.datetime(),
});
export type TaskDecision = z.infer<typeof TaskDecisionSchema>;

/**
 * The full frontmatter of a task note: the twelve provenance keys, validated
 * by the note schema this extends, then the task keys. Unknown keys are
 * stripped on parse (the note schema is a plain object); a task writer keeps
 * them separately as passthrough keys so another tool's keys survive a rewrite.
 *
 * - `stage` is fixed to `capture`: a task's lifecycle is its `status`, so every
 *   task note sits at the capture stage of the knowledge lifecycle.
 * - `sourceType` is a short open string defaulting to `manual` (assumption
 *   A10); `sourceLink` is plain text up to 2048 characters and is never
 *   rendered as a link.
 * - `projectId` uses the Phase 4 project id shape.
 */
export const TaskFrontmatterSchema = NoteFrontmatterSchema.extend({
  type: z.literal("task"),
  stage: z.literal("capture"),
  title: TaskTitleSchema,
  status: z.enum(TASK_STATUSES),
  priority: z.enum(TASK_PRIORITIES).optional(),
  due: TaskDateSchema.optional(),
  scheduled: TaskDateSchema.optional(),
  completed: TaskInstantSchema.optional(),
  projectId: ProjectIdSchema.optional(),
  assignee: z.enum(["user", "automation"]).optional(),
  sourceType: singleLineText(32).default("manual"),
  sourceLink: singleLineText(2048).optional(),
  parent: TaskIdSchema.optional(),
  dependencies: z.array(TaskIdSchema).max(50).default([]),
  tags: z.array(TaskTagSchema).max(20).default([]),
  decision: TaskDecisionSchema.optional(),
});
export type TaskFrontmatter = z.infer<typeof TaskFrontmatterSchema>;

/**
 * The single source of on-disk key order for a task note, for every writer
 * (service and plugin). The twelve provenance keys come first, spread from the
 * note schema's own array so the prefix cannot drift; `decision` is last.
 */
export const TASK_FRONTMATTER_KEY_ORDER = [
  ...NOTE_FRONTMATTER_KEY_ORDER,
  "type",
  "title",
  "status",
  "priority",
  "due",
  "scheduled",
  "completed",
  "projectId",
  "assignee",
  "sourceType",
  "sourceLink",
  "parent",
  "dependencies",
  "tags",
  "decision",
] as const satisfies readonly (keyof TaskFrontmatter)[];

/** The fixed order of the nested `decision` map, so the outer order alone is not the only thing pinned. */
export const TASK_DECISION_KEY_ORDER = [
  "outcome",
  "at",
] as const satisfies readonly (keyof TaskDecision)[];
