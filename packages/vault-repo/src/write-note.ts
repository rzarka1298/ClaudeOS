import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type ClaimType,
  type ConfidenceState,
  type GeneratedBy,
  type LifecycleStage,
  type NoteFrontmatter,
  NoteFrontmatterSchema,
  type NoteId,
  type NoteScope,
  newNoteId,
} from "@ccc/domain";
import { atomicWriteFileSync } from "./atomic-write.js";
import { stringifyNote } from "./frontmatter.js";
import { assertScopedWrite } from "./workspace-scope.js";

/**
 * Everything a caller supplies to write one managed note. Deliberately
 * NOT a `NoteFrontmatter` plus a path: the fields this package derives
 * (`id` when new, `updated`, `contentHash`) are absent here so a caller
 * cannot forge them, and `relativePath` is vault-relative so no caller
 * hands an absolute path straight to the filesystem.
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
 * The parent directory is created only AFTER the scope check passes —
 * ordering it the other way would let a rejected write leave directories
 * behind at a path it was never allowed to touch.
 *
 * This function NEVER deletes or moves a file. The only mutations the
 * Phase 2 write surface performs are "create a new file" and "atomically
 * replace a generated one"; destructive operations (note deletion,
 * cross-scope promotion) are deliberately outside it.
 */
export function writeNote(options: WriteNoteOptions): WrittenNote {
  const noteId = options.id ?? newNoteId();
  const now = new Date().toISOString();
  const target = assertScopedWrite(
    join(options.vaultRoot, options.relativePath),
    options.scope,
    options.vaultRoot,
  );

  // Validated rather than asserted: the same schema that guards untrusted
  // on-disk YAML also guards what this package is about to put there, so a
  // caller cannot write a note that would fail to parse back.
  const frontmatter = NoteFrontmatterSchema.parse({
    id: noteId,
    scope: options.scope,
    stage: options.stage,
    created: options.created ?? now,
    updated: now,
    generatedBy: options.generatedBy,
    aiGenerated: options.aiGenerated,
    ...(options.claimType === undefined ? {} : { claimType: options.claimType }),
    sources: options.sources === undefined ? [] : [...options.sources],
    confidence: options.confidence,
    lastReviewed: options.lastReviewed ?? null,
    // SHA-256 of the body only, not the serialized file: the hash answers
    // "has the content changed", and must not flip merely because a
    // provenance field was updated.
    contentHash: createHash("sha256").update(options.body, "utf8").digest("hex"),
  });

  mkdirSync(dirname(target), { recursive: true });
  atomicWriteFileSync(target, stringifyNote(frontmatter, options.body));

  return { noteId, path: target, frontmatter };
}
