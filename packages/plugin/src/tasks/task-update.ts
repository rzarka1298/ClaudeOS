import {
  TASK_FILE_MAX_BYTES,
  TASK_FRONTMATTER_KEY_ORDER,
  TASK_FRONTMATTER_MAX_BYTES,
  type TaskDecision,
  type TaskFrontmatter,
  TaskFrontmatterSchema,
  type TaskPriority,
  type TaskStatus,
} from "@ccc/domain/task-schema.js";
import yaml from "js-yaml";
import type { Vault } from "obsidian";
import {
  applyConflictSafeUpdate,
  type ManagedNoteFile,
  type ProcessableVault,
} from "../conflict-safe.js";
import { serializeTaskFrontmatter } from "../frontmatter-serializer.js";

/**
 * The plugin's one writer of task notes (plan 06-18; D-35, D-37, ADR-0022
 * write-class (a); threats T-06-19, T-06-22, T-06-26).
 *
 * An edit to an existing task note goes through the conflict-safe atomic
 * primitive: the caller hands in the content it read, this module parses and
 * validates THAT content, applies the change, serialises with the same
 * per-key dump the service writer uses, and commits only if the note still
 * equals what was read. A conflict is reported, never merged or forced. A note
 * that cannot be understood is reported as unreadable and never rewritten:
 * nothing here repairs, coerces or invents an id.
 *
 * The parse and the serialisation both happen BEFORE the write, so an
 * unreadable or invalid note costs no `process` call at all. No Obsidian
 * runtime value is imported; the one `obsidian` import is type-only, a
 * compile-time proof that a real `Vault` satisfies {@link TaskEditVault}.
 */

/** Why a task note cannot be edited. Fixed codes so a list can show them; none quotes the note. */
export type TaskUnreadableReason =
  | "too-large"
  | "frontmatter-too-large"
  | "no-frontmatter"
  | "refused-delimiter"
  | "invalid-yaml"
  | "missing-id"
  | "invalid-frontmatter"
  | "read-failed";

/** The fields an edit may change. `null` clears an optional key; absent leaves it alone. */
export interface TaskChanges {
  readonly title?: string;
  /** Replaces the note body verbatim. The only way this module touches the body. */
  readonly description?: string;
  readonly status?: TaskStatus;
  readonly priority?: TaskPriority | null;
  readonly due?: string | null;
  readonly scheduled?: string | null;
  readonly completed?: string | null;
  readonly projectId?: string | null;
  readonly tags?: readonly string[];
  readonly decision?: TaskDecision | null;
}

/** One edit: the changes and the instant `updated` advances to. Nothing here reads the clock. */
export interface TaskEdit {
  readonly now: string;
  readonly changes: TaskChanges;
}

/** A task note as it exists on disk. */
export interface ParsedTask {
  readonly frontmatter: TaskFrontmatter;
  /** Everything after the closing delimiter, byte for byte. */
  readonly body: string;
  /** Keys the task schema does not own, in read order, so a rewrite keeps them. */
  readonly passthrough: readonly (readonly [string, unknown])[];
}

/** What an edit needs from a vault: the atomic modify and an uncached read. */
export type TaskEditVault = ProcessableVault & {
  read(file: ManagedNoteFile): Promise<string>;
};

/** Compile-time proof that Obsidian's real `Vault` still satisfies {@link TaskEditVault}. */
export function taskEditVault(vault: Vault): TaskEditVault {
  return vault;
}

export type ReadTaskResult =
  | { readonly kind: "ok"; readonly content: string; readonly task: ParsedTask }
  | { readonly kind: "unreadable"; readonly reason: TaskUnreadableReason };

export type UpdateTaskResult =
  | { readonly kind: "applied"; readonly content: string; readonly task: TaskFrontmatter }
  | { readonly kind: "conflict" }
  | { readonly kind: "unreadable"; readonly reason: TaskUnreadableReason }
  | { readonly kind: "invalid"; readonly fields: Readonly<Record<string, string>> };

/**
 * The most nodes a loaded frontmatter value may expand to when every alias is
 * followed (the service reader's bound; js-yaml 3 has no alias limit of its own).
 */
const MAX_EXPANDED_NODES = 50_000;

const OWNED_KEYS: ReadonlySet<string> = new Set(TASK_FRONTMATTER_KEY_ORDER);
const FRONTMATTER_OPEN = "---\n";
const FRONTMATTER_TERMINATOR = "\n---\n";
const encoder = new TextEncoder();

function utf8Bytes(text: string): number {
  // UTF-16 code units never exceed UTF-8 bytes / 1 and never fall below bytes / 3.
  if (text.length > 3 * 1024 * 1024) return Number.POSITIVE_INFINITY;
  return encoder.encode(text).length;
}

function isPlainMap(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withinExpansionBound(value: unknown): boolean {
  const stack: unknown[] = [value];
  let visited = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    visited += 1;
    if (visited > MAX_EXPANDED_NODES) return false;
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
    } else if (typeof current === "object" && current !== null) {
      for (const item of Object.values(current)) stack.push(item);
    }
  }
  return true;
}

/**
 * Parses one task note, refusing rather than repairing. The limits are checked
 * before any YAML is loaded; the load uses the CORE schema (no timestamp type,
 * so an unquoted date stays a string); the expansion bound and the task schema
 * follow. Exported so the form can compare its fields against the parsed task.
 */
export function parseTaskContent(content: string): ReadTaskResult {
  if (utf8Bytes(content) > TASK_FILE_MAX_BYTES) return { kind: "unreadable", reason: "too-large" };
  if (!content.startsWith(FRONTMATTER_OPEN)) {
    return {
      kind: "unreadable",
      reason: content.startsWith("---") ? "refused-delimiter" : "no-frontmatter",
    };
  }
  const terminator = content.indexOf(FRONTMATTER_TERMINATOR, FRONTMATTER_OPEN.length - 1);
  if (terminator === -1) return { kind: "unreadable", reason: "no-frontmatter" };
  const block = content.slice(FRONTMATTER_OPEN.length, terminator + 1);
  const body = content.slice(terminator + FRONTMATTER_TERMINATOR.length);
  if (utf8Bytes(block) > TASK_FRONTMATTER_MAX_BYTES) {
    return { kind: "unreadable", reason: "frontmatter-too-large" };
  }

  let data: unknown;
  try {
    data = yaml.safeLoad(block, { schema: yaml.CORE_SCHEMA }) ?? {};
  } catch {
    return { kind: "unreadable", reason: "invalid-yaml" };
  }
  if (!isPlainMap(data)) return { kind: "unreadable", reason: "invalid-frontmatter" };
  if (!withinExpansionBound(data)) return { kind: "unreadable", reason: "frontmatter-too-large" };
  if (data.id === undefined || data.id === null || data.id === "") {
    return { kind: "unreadable", reason: "missing-id" };
  }
  const result = TaskFrontmatterSchema.safeParse(data);
  if (!result.success) return { kind: "unreadable", reason: "invalid-frontmatter" };

  // Everything the schema does not own is the owner's (or another tool's) and is
  // handed back so a rewrite can put it after the owned keys in read order.
  const passthrough: (readonly [string, unknown])[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (!OWNED_KEYS.has(key)) passthrough.push([key, value]);
  }
  return { kind: "ok", content, task: { frontmatter: result.data, body, passthrough } };
}

/**
 * Reads a task note with the uncached read and parses it. The returned
 * `content` is what to hand back as `expectedPriorContent`; the parsed task is
 * what a dirty form compares its field values against.
 */
export async function readTaskForEdit(
  vault: Pick<TaskEditVault, "read">,
  file: ManagedNoteFile,
): Promise<ReadTaskResult> {
  let content: string;
  try {
    content = await vault.read(file);
  } catch {
    return { kind: "unreadable", reason: "read-failed" };
  }
  return parseTaskContent(content);
}

function applyChanges(
  frontmatter: TaskFrontmatter,
  now: string,
  changes: TaskChanges,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...frontmatter, updated: now };
  const keys = [
    "title",
    "status",
    "priority",
    "due",
    "scheduled",
    "completed",
    "projectId",
    "tags",
    "decision",
  ] as const;
  for (const key of keys) {
    const value = changes[key];
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

/**
 * Applies one edit to a task note and commits it only if the note still equals
 * `expectedPriorContent`. Results: `applied` (with the written content),
 * `conflict` (the note changed; nothing written), `unreadable` (the note is not
 * a readable task; nothing written), `invalid` (the edit would break the task
 * schema; nothing written, keyed by the offending field).
 */
export async function updateTaskNote(
  vault: ProcessableVault,
  file: ManagedNoteFile,
  expectedPriorContent: string,
  edit: TaskEdit,
): Promise<UpdateTaskResult> {
  const read = parseTaskContent(expectedPriorContent);
  if (read.kind === "unreadable") return read;

  const merged = applyChanges(read.task.frontmatter, edit.now, edit.changes);
  const validated = TaskFrontmatterSchema.safeParse(merged);
  if (!validated.success) {
    const fields: Record<string, string> = {};
    for (const issue of validated.error.issues) {
      fields[String(issue.path[0] ?? "note")] = "invalid";
    }
    return { kind: "invalid", fields };
  }

  const body = edit.changes.description ?? read.task.body;
  const next = `---\n${serializeTaskFrontmatter(validated.data, read.task.passthrough)}---\n${body}`;
  // Never write what the readers (service parseTaskNote, this module's parse) would
  // refuse: the whole-file and frontmatter limits, the alias-expansion bound and the
  // schema are all re-checked on the exact bytes about to be written.
  const reread = parseTaskContent(next);
  if (reread.kind === "unreadable") {
    return { kind: "invalid", fields: { note: reread.reason } };
  }
  const outcome = await applyConflictSafeUpdate(vault, file, expectedPriorContent, () => next);
  return outcome === "conflict"
    ? { kind: "conflict" }
    : { kind: "applied", content: next, task: validated.data };
}
