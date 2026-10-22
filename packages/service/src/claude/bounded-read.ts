import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

/**
 * A read-only, bounded read of one small file (FIX1A MINOR 6). The service
 * reads files it does not own (Claude's `settings.json`, the installer's
 * record), so a path that is not what it looks like must not stall or exhaust
 * it: a FIFO would block a plain `readFileSync` forever and a symlink to
 * `/dev/zero` would never end.
 *
 *   - The file is opened `O_RDONLY | O_NONBLOCK`, so opening a FIFO returns at
 *     once.
 *   - `fstat` on the open descriptor (which follows a symlink) must say
 *     *regular file*; anything else (a FIFO, a device, a directory, a socket)
 *     is refused before a single byte is read.
 *   - At most `maxBytes` are read; a file that is, or grows, larger is refused.
 *
 * Returns the UTF-8 text, or `null` for anything unreadable. Never throws.
 * This module opens for reading only; it is kept apart from
 * `integration-status.ts`, whose source scan allows no `open*` import.
 */
export function readBoundedRegularFile(path: string, maxBytes: number): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const chunks: Buffer[] = [];
    let total = 0;
    const chunk = Buffer.allocUnsafe(Math.min(maxBytes + 1, 64 * 1024));
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      total += read;
      if (total > maxBytes) return null;
      chunks.push(Buffer.from(chunk.subarray(0, read)));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Nothing to recover: the descriptor was only read.
      }
    }
  }
}
