/**
 * Wraps any failure of the temp-write / fsync / rename sequence in
 * {@link atomicWriteFileSync}. One named class for one condition: the
 * target file was NOT replaced, and whatever content was there before is
 * still there. Callers may surface this as "the write did not happen"
 * without inspecting which step failed.
 */
export class AtomicWriteError extends Error {
  readonly targetPath: string;

  constructor(targetPath: string, cause: unknown) {
    super("atomic write failed");
    this.name = "AtomicWriteError";
    this.targetPath = targetPath;
    this.cause = cause;
  }
}

/**
 * Writes `content` to `targetPath` atomically (VAULT-05): a dot-prefixed
 * temp file in the SAME directory, flushed with `fsync`, then `rename`d
 * over the target. Same-directory placement is what guarantees the rename
 * stays within one filesystem, where POSIX makes it atomic — a reader can
 * only ever observe the old file or the whole new one, never a partial
 * write. The `fsync` before the rename is what stops a crash from leaving
 * a temp file whose contents were still in the page cache.
 *
 * NOT YET IMPLEMENTED — RED phase (plan 02-01).
 */
export function atomicWriteFileSync(targetPath: string, content: string): void {
  void targetPath;
  void content;
  throw new Error("atomicWriteFileSync is not implemented yet");
}
