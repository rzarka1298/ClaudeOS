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
export function applyConflictSafeUpdate(
  _vault: ProcessableVault,
  _file: ManagedNoteFile,
  _expectedPriorContent: string,
  _transform: (current: string) => string,
): Promise<ConflictSafeUpdateResult> {
  throw new Error(
    "applyConflictSafeUpdate is not implemented yet (packages/plugin/src/vault-write.ts)",
  );
}
