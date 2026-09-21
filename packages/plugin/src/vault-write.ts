import type { NoteFrontmatter } from "@ccc/domain";
import type { TFile, Vault } from "obsidian";

/**
 * The ONLY plugin-side write path for managed notes (VAULT-06).
 *
 * A note that may be open in an editor pane cannot be written by the
 * companion service's raw filesystem path: only this process knows whether
 * a buffer is open and dirty. Obsidian's `Vault.process()` closes the
 * read-modify-write window *inside* the call -- its documentation
 * guarantees "the file doesn't change between reading the current content
 * and writing the updated content" -- but it says nothing about the much
 * wider window between the CALLER's last read and the write it is now
 * proposing. That outer window is where a user's in-editor edit lives, and
 * closing it is this module's whole job: every entry point takes the
 * content the caller believes is on disk and refuses to write when the real
 * content no longer matches.
 *
 * Caller contract: on `"conflict"`, re-fetch the note, rebuild the proposed
 * change against the content you just read, and call again. This module
 * will never resolve a conflict on its own -- silently re-applying a
 * transform on top of someone's edit is precisely the data loss the
 * conflict result exists to prevent, so there is deliberately no retry,
 * no merge, and no force flag anywhere in this file.
 *
 * ## Write-class routing policy (formalised in ADR-0022, plan 02-06)
 *
 * `@ccc/vault-repo`'s `writeNote()` owns service-generated artifacts --
 * everything under `raw/`, `wiki/`, `output/`, `automation-runs/` and every
 * generated `index.md` -- because the service must be able to write
 * knowledge whether or not Obsidian is running. Any note that may be open
 * in an editor is written ONLY through this module. Today the split is a
 * policy plus this module's existence; its enforcing consumer arrives with
 * Phase 6's task store, the first code path that proposes a cross-process
 * write to a note a user may have open.
 *
 * ## Index eventual-consistency bound (also ADR-0022, plan 02-06)
 *
 * This module never regenerates a folder's `index.md`, and structurally
 * cannot: index generation lives in the service-side `@ccc/vault-repo`,
 * which the import-boundary gate (`ci:boundaries`) forbids this package
 * from importing. A provenance update can therefore leave a folder index's
 * displayed `updated` value stale until the next service-side write into
 * that folder or the next repair run. That is the entire staleness
 * surface: `id`, the row's link target and `stage` cannot change through
 * this path, so no index reference can ever break -- only one displayed
 * timestamp can lag.
 *
 * ## No write-backs from change-event handlers
 *
 * Nothing in this module subscribes to Vault or metadata-cache change
 * events, and nothing in it may. A write performed from inside a change
 * handler re-fires the same handler through the write it just made -- the
 * re-entrant index-update loop the roadmap's blocking note forbids. Every
 * export here is a plain function that runs only when a caller explicitly
 * calls it, which makes that loop unreachable rather than merely
 * discouraged (the negative grep in this plan's verification is the
 * machine check). A future event-driven writer must queue the work and
 * debounce it (250-500ms) OUTSIDE the handler's call stack, and must live
 * in its own module rather than re-opening this one.
 */

/**
 * The single property this module reads off a note handle. Narrowing to a
 * structural type (rather than taking Obsidian's `TFile` directly) keeps
 * the fake host in `test-support/` an ordinary object instead of a cast of
 * a class whose runtime the `obsidian` types-only package does not ship --
 * `TFile` satisfies this shape, which {@link processableFile} checks at
 * compile time.
 */
export interface ManagedNoteFile {
  readonly path: string;
}

/**
 * The one Obsidian `Vault` method this module uses, wrapped behind a typed
 * local surface exactly as `host-registry.ts` wraps the registration
 * methods: production passes the real vault through {@link processableVault},
 * tests pass `FakeVault`, and neither needs a cast.
 */
export interface ProcessableVault {
  /**
   * Atomically read, modify and save a plaintext file. The callback is
   * SYNCHRONOUS by contract -- Obsidian's own documentation calls it "a
   * callback function which returns the new content of the note
   * synchronously", and an async callback would return a `Promise` that
   * Obsidian would stringify into the file.
   */
  process(file: ManagedNoteFile, fn: (data: string) => string): Promise<string>;
}

/**
 * Narrows a real Obsidian `Vault` to {@link ProcessableVault}. The body is
 * an identity, but the signature is a compile-time proof that Obsidian's
 * `Vault.process` still satisfies the surface this module depends on: if
 * that signature ever changes, this function stops compiling instead of
 * this module silently drifting from the API it claims to wrap.
 */
export function processableVault(vault: Vault): ProcessableVault {
  return vault;
}

/**
 * Narrows a real Obsidian `TFile` to {@link ManagedNoteFile} -- the same
 * compile-checked adapter as {@link processableVault}, and the reason no
 * `as TFile` cast appears anywhere in this module or its tests.
 */
export function processableFile(file: TFile): ManagedNoteFile {
  return file;
}

/**
 * `"applied"` -- the file matched `expectedPriorContent` and the transform's
 * output was written. `"conflict"` -- the file had changed since the caller
 * read it, and the current content was left exactly as it was found.
 */
export type ConflictSafeUpdateResult = "applied" | "conflict";

/**
 * Writes `transform(current)` to `file`, but only while the file still
 * holds exactly `expectedPriorContent`.
 *
 * Exactly one `process()` call happens per invocation. A conflict is
 * reported, never retried: see the module contract above.
 *
 * @param transform - synchronous by type, mirroring `Vault.process`'s own
 *   requirement. An async transform is a compile error, not a runtime
 *   surprise.
 */
export async function applyConflictSafeUpdate(
  vault: ProcessableVault,
  file: ManagedNoteFile,
  expectedPriorContent: string,
  transform: (current: string) => string,
): Promise<ConflictSafeUpdateResult> {
  let conflict = false;
  await vault.process(file, (current) => {
    // Strict string equality, not a normalised or trimmed comparison: a
    // trailing newline the user added IS an edit, and a comparison lenient
    // enough to ignore it is lenient enough to overwrite it.
    if (current !== expectedPriorContent) {
      conflict = true;
      // Returning `current` unchanged is what makes the user's edit win
      // byte-for-byte. `process()` still writes -- it always does -- but it
      // writes back exactly the bytes it just read.
      return current;
    }
    return transform(current);
  });
  return conflict ? "conflict" : "applied";
}

/**
 * Thrown when the note this module was asked to update does not hold a
 * well-formed managed-note frontmatter block -- no delimiters, unparseable
 * YAML, or a shape that fails `NoteFrontmatterSchema`.
 *
 * On-disk frontmatter is untrusted input: a note may have been hand-edited
 * in the editor or synced in by another tool. Refusing is the safe
 * direction. Writing a "repaired" block over content this module could not
 * understand would destroy whatever the user actually typed, which is the
 * same loss the conflict result exists to prevent -- so a malformed note is
 * reported, never rewritten.
 */
export class InvalidManagedNoteError extends Error {
  readonly notePath: string;
  readonly issues: readonly unknown[];

  constructor(notePath: string, detail: string, issues: readonly unknown[] = []) {
    super(`cannot update provenance for ${notePath}: ${detail}`);
    this.name = "InvalidManagedNoteError";
    this.notePath = notePath;
    this.issues = issues;
  }
}

/**
 * A pure transformation of a note's validated provenance frontmatter --
 * bump `updated`, set `lastReviewed`, and so on. Receives a value that has
 * already passed `NoteFrontmatterSchema`, and must return one too.
 */
export type ProvenanceMutation = (current: NoteFrontmatter) => NoteFrontmatter;

/**
 * Applies `mutate` to a managed note's provenance frontmatter and writes
 * the result through {@link applyConflictSafeUpdate}, leaving the note body
 * byte-for-byte untouched.
 *
 * The rebuilt block is serialized by walking `NOTE_FRONTMATTER_KEY_ORDER`
 * (and `GENERATED_BY_KEY_ORDER` for the nested map), emitting one key at a
 * time -- never by dumping an object and trusting a YAML library's own
 * ordering. That is what makes a plugin-side update and a service-side
 * `writeNote()` of the same note produce the same bytes: both walk the same
 * exported key arrays, so the output is a function of the note's content
 * alone.
 *
 * Writes exactly one file -- the note itself. See the module's
 * eventual-consistency note above for what that means for folder indexes.
 *
 * @throws {InvalidManagedNoteError} when the current content is not a
 *   well-formed managed note. Nothing is written in that case.
 */
export function updateNoteProvenance(
  _vault: ProcessableVault,
  _file: ManagedNoteFile,
  _expectedPriorContent: string,
  _mutate: ProvenanceMutation,
): Promise<ConflictSafeUpdateResult> {
  throw new Error(
    "updateNoteProvenance is not implemented yet (packages/plugin/src/vault-write.ts)",
  );
}
