import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
 * The dot prefix matters for a vault specifically: Obsidian ignores
 * dot-prefixed files, so a temp file that outlives a crash never appears
 * as a phantom note in the user's vault.
 *
 * On any failure the temp file is removed and {@link AtomicWriteError} is
 * thrown; the target is left exactly as it was.
 */
export function atomicWriteFileSync(targetPath: string, content: string): void {
  const tmpPath = join(dirname(targetPath), `.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmpPath, content, "utf8");
    const fd = openSync(tmpPath, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, targetPath);
  } catch (cause) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // The temp file may never have been created, or may already have
      // been renamed away. Either way there is nothing left to clean up,
      // and the original failure below is the one worth reporting.
    }
    throw new AtomicWriteError(targetPath, cause);
  }
}
