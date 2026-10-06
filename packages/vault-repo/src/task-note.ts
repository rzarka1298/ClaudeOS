import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type ClaimType,
  type ConfidenceState,
  GENERATED_BY_KEY_ORDER,
  type GeneratedBy,
  type NoteId,
  type NoteScope,
  newNoteId,
  TASK_DECISION_KEY_ORDER,
  TASK_FILE_MAX_BYTES,
  TASK_FRONTMATTER_KEY_ORDER,
  TASK_FRONTMATTER_MAX_BYTES,
  TASKS_FOLDER_NAME,
  type TaskFrontmatter,
  TaskFrontmatterSchema,
  type TaskPriority,
  taskFileName,
  workspaceIdFromScope,
} from "@ccc/domain";
import yaml from "js-yaml";
import { atomicWriteFileSync } from "./atomic-write.js";
import { assertPlainYamlDelimiter, parseWithYamlEngine } from "./frontmatter.js";
import { assertScopedWrite, WorkspaceScopeViolationError } from "./workspace-scope.js";

/** Why a task note was refused. Each code is fixed so an attention list can show it. */
export type TaskNoteReason =
  | "too-large"
  | "frontmatter-too-large"
  | "refused-delimiter"
  | "invalid-yaml"
  | "missing-id"
  | "invalid-frontmatter";

/** Base class of every refusal this module raises while reading a task note. */
export class TaskNoteError extends Error {
  readonly reason: TaskNoteReason;
  readonly issues: readonly unknown[];

  constructor(reason: TaskNoteReason, message: string, issues: readonly unknown[] = []) {
    super(message);
    this.name = "TaskNoteError";
    this.reason = reason;
    this.issues = issues;
  }
}

/** The file, or its frontmatter block, is over the size limit. */
export class TaskNoteTooLargeError extends TaskNoteError {
  constructor(reason: "too-large" | "frontmatter-too-large") {
    super(reason, "task note is over the size limit");
    this.name = "TaskNoteTooLargeError";
  }
}

/** The opening delimiter names a language other than plain YAML. */
export class TaskNoteRefusedDelimiterError extends TaskNoteError {
  constructor() {
    super("refused-delimiter", "task note frontmatter delimiter is not plain YAML");
    this.name = "TaskNoteRefusedDelimiterError";
  }
}

/** The frontmatter could not be loaded, carries no id, or does not match the task schema. */
export class TaskNoteInvalidError extends TaskNoteError {
  constructor(
    reason: "invalid-yaml" | "missing-id" | "invalid-frontmatter",
    message: string,
    issues: readonly unknown[] = [],
  ) {
    super(reason, message, issues);
    this.name = "TaskNoteInvalidError";
  }
}

/** A task note as it exists on disk. */
export interface ParsedTaskNote {
  readonly frontmatter: TaskFrontmatter;
  /** Everything after the closing delimiter, byte for byte. */
  readonly body: string;
  /** Keys the task schema does not own, in read order, so a rewrite keeps them. */
  readonly passthrough: Record<string, unknown>;
}

/**
 * The most nodes a loaded frontmatter value may expand to when every alias is
 * followed. js-yaml 3 has no alias limit: a few kilobytes of nested aliases
 * load in a fraction of a millisecond and then expand to hundreds of megabytes
 * the first time anything walks them. A real task note has a few dozen nodes;
 * the bound sits above what 64 KiB of flat YAML can hold (T-06-26).
 */
const MAX_EXPANDED_NODES = 50_000;

/**
 * The task YAML engine: js-yaml's CORE schema. It is narrower than the default
 * safe schema (no timestamp, merge or binary types), so an unquoted date such
 * as the one Obsidian's Properties editor writes stays a string. Tags that
 * would build objects (`!!js/function`, `!!python/object`) are not in the
 * schema and make the load throw.
 */
const TASK_YAML_ENGINE = {
  parse: (input: string): object =>
    (yaml.safeLoad(input, { schema: yaml.CORE_SCHEMA }) ?? {}) as object,
  stringify: (data: object): string => yaml.safeDump(data),
};

const OWNED_KEYS: ReadonlySet<string> = new Set(TASK_FRONTMATTER_KEY_ORDER);

/**
 * Bytes of the frontmatter block, measured WITHOUT parsing it. The closing
 * delimiter is found no later than gray-matter finds it, so this can only
 * over-measure, never let an oversized block through.
 */
function frontmatterBlockBytes(raw: string): number {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (!text.startsWith("---")) return 0;
  const firstLineEnd = text.indexOf("\n");
  if (firstLineEnd === -1) return 0;
  const rest = text.slice(firstLineEnd + 1);
  const close = /(^|\n)---/.exec(rest);
  const block = close === null ? rest : rest.slice(0, close.index);
  return Buffer.byteLength(block, "utf8");
}

/** True when `value`, with every alias followed, has at most {@link MAX_EXPANDED_NODES} nodes. */
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

function isPlainMap(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses one task note, refusing rather than repairing.
 *
 * Order matters: the whole-file and frontmatter size limits are checked before
 * any YAML is loaded, then the delimiter (a `---js` opening is gray-matter's
 * `eval` engine), then the load itself with the core schema, then a bound on
 * what aliases can expand to, then the task schema. A note with no id is
 * reported as such; no id is ever minted here (D-37).
 *
 * Every refusal carries a fixed reason code and a constant message. None
 * quotes the file, so an attention list built from them never echoes note text.
 *
 * @throws {TaskNoteError} for every refusal; the subclass and `reason` say why.
 */
export function parseTaskNote(raw: string): ParsedTaskNote {
  if (Buffer.byteLength(raw, "utf8") > TASK_FILE_MAX_BYTES) {
    throw new TaskNoteTooLargeError("too-large");
  }
  try {
    assertPlainYamlDelimiter(raw);
  } catch {
    throw new TaskNoteRefusedDelimiterError();
  }
  if (frontmatterBlockBytes(raw) > TASK_FRONTMATTER_MAX_BYTES) {
    throw new TaskNoteTooLargeError("frontmatter-too-large");
  }

  let data: unknown;
  let body: string;
  try {
    const parsed = parseWithYamlEngine(raw, TASK_YAML_ENGINE);
    data = parsed.data;
    body = parsed.content;
  } catch {
    throw new TaskNoteInvalidError("invalid-yaml", "task note frontmatter is not valid YAML");
  }

  if (!isPlainMap(data)) {
    throw new TaskNoteInvalidError(
      "invalid-frontmatter",
      "task note frontmatter is not a map of keys",
    );
  }
  if (!withinExpansionBound(data)) {
    throw new TaskNoteTooLargeError("frontmatter-too-large");
  }
  if (data.id === undefined || data.id === null || data.id === "") {
    throw new TaskNoteInvalidError("missing-id", "task note has no id");
  }

  const result = TaskFrontmatterSchema.safeParse(data);
  if (!result.success) {
    throw new TaskNoteInvalidError(
      "invalid-frontmatter",
      "task note frontmatter does not match the task schema",
      result.error.issues,
    );
  }

  // Everything the schema does not own is the user's (or another tool's) and
  // is handed back so a rewrite can put it back. defineProperty rather than
  // assignment, so a key spelled `__proto__` is data, not a prototype swap.
  const passthrough: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (OWNED_KEYS.has(key)) continue;
    Object.defineProperty(passthrough, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return { frontmatter: result.data, body, passthrough };
}

/** Rebuilds a nested map with its keys in a fixed order, dropping absent ones (YAML cannot dump `undefined`). */
function orderedMap(value: object, order: readonly string[]): Record<string, unknown> {
  const source = value as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of order) {
    const sub = source[key];
    if (sub !== undefined) ordered[key] = sub;
  }
  return ordered;
}

/** One `key: value` entry dumped on its own, so key order belongs to the loops below and not to a YAML option. */
function dumpEntry(key: string, value: unknown): string {
  return yaml.safeDump({ [key]: value });
}

/**
 * Serialises a task note: the frontmatter keys in `TASK_FRONTMATTER_KEY_ORDER`
 * (the twelve provenance keys first), `generatedBy` and `decision` in their own
 * fixed orders, then the passthrough keys in the order they were read.
 *
 * Each key is dumped on its own and the results concatenated, which is exactly
 * how the plugin's writer builds its block, so a note written by either
 * process has the same bytes. The body follows the closing delimiter verbatim;
 * it is concatenated, never handed to a parser, so a body that starts with a
 * delimiter or a language tag is only ever text (task descriptions come from
 * typing and from automation: ADR-0014).
 *
 * A passthrough key can never override a schema-owned key.
 */
export function stringifyTaskNote(
  frontmatter: TaskFrontmatter,
  body: string,
  passthrough: Readonly<Record<string, unknown>> = {},
): string {
  const source = frontmatter as unknown as Record<string, unknown>;
  let block = "";
  for (const key of TASK_FRONTMATTER_KEY_ORDER) {
    const value = source[key];
    if (value === undefined) continue;
    if (key === "generatedBy") {
      block += dumpEntry(key, orderedMap(value as GeneratedBy, GENERATED_BY_KEY_ORDER));
    } else if (key === "decision") {
      block += dumpEntry(key, orderedMap(value as object, TASK_DECISION_KEY_ORDER));
    } else {
      block += dumpEntry(key, value);
    }
  }
  for (const [key, value] of Object.entries(passthrough)) {
    if (value === undefined || OWNED_KEYS.has(key)) continue;
    block += dumpEntry(key, value);
  }
  return `---\n${block}---\n${body}`;
}

/** Everything a caller supplies to create one task note. */
export interface WriteTaskNoteOptions {
  readonly vaultRoot: string;
  readonly scope: NoteScope;
  readonly title: string;
  readonly body?: string;
  readonly intent?: "inbox" | "ready" | "proposed";
  readonly priority?: TaskPriority;
  readonly due?: string;
  readonly scheduled?: string;
  readonly projectId?: string;
  readonly assignee?: "user" | "automation";
  readonly sourceType?: string;
  readonly sourceLink?: string;
  readonly parent?: string;
  readonly dependencies?: readonly string[];
  readonly tags?: readonly string[];
  readonly generatedBy?: GeneratedBy;
  readonly aiGenerated?: boolean;
  readonly claimType?: ClaimType;
  readonly sources?: readonly string[];
  readonly confidence?: ConfidenceState;
  readonly now?: Date;
}

/** What one task write produced. */
export interface WrittenTaskNote {
  readonly id: NoteId;
  /** Vault-relative, POSIX-separated. */
  readonly path: string;
  readonly absolutePath: string;
  readonly frontmatter: TaskFrontmatter;
  /** SHA-256 of the complete file bytes. */
  readonly contentHash: string;
}

/** How many times a freshly minted id is re-minted if its file name is already taken. */
const MAX_NAME_ATTEMPTS = 5;

/** SHA-256 of a note's complete bytes: the one content hash the task index, the scan and the changed route share. */
export function hashTaskNoteBytes(bytes: Buffer | string): string {
  return createHash("sha256")
    .update(typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes)
    .digest("hex");
}

/** The vault-relative folder that holds a scope's tasks, or `null` for a scope string that is not one. */
export function tasksFolderFor(scope: NoteScope): string | null {
  if (scope === "global") return `global/${TASKS_FOLDER_NAME}`;
  const workspaceId = workspaceIdFromScope(scope);
  return workspaceId === null ? null : `workspaces/${workspaceId}/${TASKS_FOLDER_NAME}`;
}

/**
 * Creates one new task note, end to end: mint the id, derive the file name
 * once from the title and the id suffix (it is never derived again, so a later
 * title edit cannot rename the file), validate the frontmatter with the task
 * schema, verify scope and containment, and write atomically.
 *
 * Scope and containment are checked BEFORE any directory is created, so a
 * refused write leaves nothing behind. This function only ever creates a new
 * file: it never replaces, deletes or moves one, and it never regenerates a
 * per-note index (at 10,000 tasks that cost 212 ms a write). Edits to existing
 * notes belong to the plugin, which holds the editor buffer.
 *
 * @throws {WorkspaceScopeViolationError} when the scope is malformed, names a
 *   workspace that is not on disk, or the target resolves outside its scope.
 * @throws {ZodError} when the supplied fields do not satisfy the task schema.
 */
export function writeTaskNote(options: WriteTaskNoteOptions): WrittenTaskNote {
  const folder = tasksFolderFor(options.scope);
  if (folder === null) throw new WorkspaceScopeViolationError(options.scope);

  const now = (options.now ?? new Date()).toISOString();
  const intent = options.intent ?? "inbox";

  let id: NoteId = newNoteId();
  let relativePath = `${folder}/${taskFileName(options.title, id)}`;
  let target = assertScopedWrite(
    join(options.vaultRoot, ...relativePath.split("/")),
    options.scope,
    options.vaultRoot,
  );
  for (let attempt = 1; existsSync(target); attempt++) {
    if (attempt >= MAX_NAME_ATTEMPTS) throw new WorkspaceScopeViolationError(relativePath);
    id = newNoteId();
    relativePath = `${folder}/${taskFileName(options.title, id)}`;
    target = assertScopedWrite(
      join(options.vaultRoot, ...relativePath.split("/")),
      options.scope,
      options.vaultRoot,
    );
  }

  const optional = <T>(key: string, value: T | undefined): Record<string, T> =>
    value === undefined ? {} : { [key]: value };

  // Validated rather than asserted: a caller cannot write a note the reader
  // would then refuse.
  const frontmatter = TaskFrontmatterSchema.parse({
    id,
    scope: options.scope,
    stage: "capture",
    created: now,
    updated: now,
    generatedBy: options.generatedBy ?? {},
    aiGenerated: options.aiGenerated ?? false,
    ...optional("claimType", options.claimType),
    sources: options.sources === undefined ? [] : [...options.sources],
    confidence: options.confidence ?? "unverified",
    lastReviewed: null,
    type: "task",
    title: options.title,
    status: intent,
    ...optional("priority", options.priority),
    ...optional("due", options.due),
    ...optional("scheduled", options.scheduled),
    ...optional("projectId", options.projectId),
    ...optional("assignee", options.assignee),
    ...optional("sourceType", options.sourceType),
    ...optional("sourceLink", options.sourceLink),
    ...optional("parent", options.parent),
    dependencies: options.dependencies === undefined ? [] : [...options.dependencies],
    tags: options.tags === undefined ? [] : [...options.tags],
  });

  const text = stringifyTaskNote(frontmatter, options.body ?? "");
  mkdirSync(join(options.vaultRoot, ...folder.split("/")), { recursive: true });
  atomicWriteFileSync(target, text);

  return {
    id,
    path: relativePath,
    absolutePath: target,
    frontmatter,
    contentHash: hashTaskNoteBytes(text),
  };
}
