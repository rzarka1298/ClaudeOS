/**
 * The conflict-safe write primitive, split out of `vault-write.ts` (plan 06-18)
 * so the task update path can use it without importing a module that reaches
 * the Obsidian runtime. Nothing here imports `obsidian`, even as a type.
 * `vault-write.ts` re-exports every name, so existing imports keep working.
 *
 * Contract (unchanged from its original home): every entry point takes the
 * content the caller believes is on disk and refuses to write when the real
 * content no longer matches. A conflict is reported, never retried, merged or
 * forced; there is deliberately no retry, no merge and no force flag here. No
 * event subscription may ever be added to this file (a write from a change
 * handler re-fires the handler).
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
