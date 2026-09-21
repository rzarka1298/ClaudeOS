import type {
  ClaimType,
  ConfidenceState,
  GeneratedBy,
  LifecycleStage,
  NoteFrontmatter,
  NoteId,
  NoteScope,
} from "@ccc/domain";

/**
 * Everything a caller supplies to write one managed note. Deliberately
 * NOT a `NoteFrontmatter` plus a path: the fields this package derives
 * (`id` when new, `created`/`updated`, `contentHash`) are absent here so a
 * caller cannot forge them, and `relativePath` is vault-relative so no
 * caller hands an absolute path straight to the filesystem.
 */
export interface WriteNoteOptions {
  /** The managed vault's root directory. Must already exist. */
  readonly vaultRoot: string;
  /** Target path relative to `vaultRoot`, e.g. `workspaces/<id>/wiki/x.md`. */
  readonly relativePath: string;
  /** The note's Markdown body, written verbatim beneath the frontmatter. */
  readonly body: string;
  /** The scope this write claims; checked against `relativePath` (VAULT-10). */
  readonly scope: NoteScope;
  readonly stage: LifecycleStage;
  readonly generatedBy: GeneratedBy;
  readonly aiGenerated: boolean;
  readonly claimType?: ClaimType;
  readonly sources?: readonly string[];
  readonly confidence: ConfidenceState;
  /** Supply to update an existing note; omit to mint a fresh NoteId. */
  readonly id?: NoteId;
  /** ISO 8601 creation stamp for an update; omit and it equals `updated`. */
  readonly created?: string;
  /** `null` records "never reviewed"; omit and it defaults to `null`. */
  readonly lastReviewed?: string | null;
}

/**
 * The state a note was actually written in. Returned so the callers that
 * follow this write — the note-metadata cache upsert (plan 02-04) and
 * index regeneration (plan 02-02) — never have to re-read the file they
 * just caused to be written.
 */
export interface WrittenNote {
  readonly noteId: NoteId;
  /** The resolved absolute path the note was written to. */
  readonly path: string;
  readonly frontmatter: NoteFrontmatter;
}

/**
 * Writes one provenance-carrying managed note, end to end: mint the ID if
 * this is a new note, stamp the timestamps, hash the body, verify the
 * target against both vault containment and the declared scope, serialize
 * the frontmatter in fixed key order, and replace the target atomically.
 *
 * This function NEVER deletes or moves a file. The only mutations the
 * Phase 2 write surface performs are "create a new file" and "atomically
 * replace a generated one"; destructive operations (note deletion,
 * cross-scope promotion) are deliberately outside it.
 *
 * NOT YET IMPLEMENTED — RED phase (plan 02-01).
 */
export function writeNote(options: WriteNoteOptions): WrittenNote {
  void options;
  throw new Error("writeNote is not implemented yet");
}
