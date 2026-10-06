import type {
  ClaimType,
  ConfidenceState,
  GeneratedBy,
  NoteId,
  NoteScope,
  TaskFrontmatter,
  TaskPriority,
} from "@ccc/domain";

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

export function parseTaskNote(_raw: string): ParsedTaskNote {
  return { frontmatter: {} as TaskFrontmatter, body: "", passthrough: {} };
}

export function stringifyTaskNote(
  _frontmatter: TaskFrontmatter,
  _body: string,
  _passthrough: Readonly<Record<string, unknown>> = {},
): string {
  return "";
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

export function writeTaskNote(_options: WriteTaskNoteOptions): WrittenTaskNote {
  return {
    id: "" as NoteId,
    path: "",
    absolutePath: "",
    frontmatter: {} as TaskFrontmatter,
    contentHash: "",
  };
}
