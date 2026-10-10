import { createHash } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
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
import { regenerateIndex } from "./index-generation.js";
import { isInsideTasksFolder } from "./managed-folders.js";
import { assertScopedWrite, WorkspaceScopeViolationError } from "./workspace-scope.js";

/** Thrown when the generic writer is pointed at a tasks folder; only the task writer may write there. */
export class TasksFolderWriteRefusedError extends Error {
  constructor() {
    super("task notes are written with writeTaskNote, not writeNote");
    this.name = "TasksFolderWriteRefusedError";
  }
}

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
 * behind at a path it was never allowed to touch. A target whose parent IS
 * the vault root is refused for a related reason: see the check inline.
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

  // A task note carries keys this writer does not know, and a generic rewrite
  // would strip them (D-30). Refused before any directory or file exists.
  if (isInsideTasksFolder(relative(realpathSync.native(options.vaultRoot), target).split(sep))) {
    throw new TasksFolderWriteRefusedError();
  }

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

  const folder = dirname(target);
  // A note directly at the vault root is refused. `assertScopedWrite` only
  // requires strict descendancy of the vault plus "not under workspaces/",
  // so `relativePath: "x.md"` passed it — and then `regenerateIndex` took
  // its `is-root` branch and wrote `<vaultRoot>/index.md`. That file is in
  // no plan: `MANAGED_FOLDERS` has no root entry, so `computeSetupEntries`
  // never lists it (breaking VAULT-01's "setup writes only what it
  // displayed") and `repairVault`'s managed-root set never contains it, so
  // it is never regenerated again and goes stale as soon as a second root
  // note appears. A managed note belongs in a managed folder.
  if (folder === realpathSync.native(options.vaultRoot)) {
    throw new WorkspaceScopeViolationError(options.relativePath);
  }
  mkdirSync(folder, { recursive: true });
  atomicWriteFileSync(target, stringifyNote(frontmatter, options.body));

  // The write is not finished until the folder's index reflects it. Doing
  // this synchronously — and as a full recompute rather than a patch — is
  // what makes "the index is stale" an unreachable state for every
  // SERVICE-side write, rather than a race the repair command has to clean
  // up later. Plugin-side provenance updates remain eventually consistent
  // within the bound ADR-0022 records (plans 02-03 and 02-06).
  regenerateIndex(folder, { vaultRoot: options.vaultRoot });

  return { noteId, path: target, frontmatter };
}
