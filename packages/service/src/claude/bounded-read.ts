import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";

/**
 * A read-only, bounded read of one small file (FIX1A MINOR 6). The service reads files it does not
 * own (Claude's `settings.json`, the installer's record), so a path that is not what it looks like
 * must not stall or exhaust it: a FIFO would block a plain `readFileSync` forever and a symlink to
 * `/dev/zero` would never end.
 *
 *   - The file is opened `O_RDONLY | O_NONBLOCK`, so opening a FIFO returns at once.
 *   - `fstat` on the open descriptor (which follows a symlink) must say *regular file*; anything
 *     else (a FIFO, a device, a directory, a socket) is refused before a single byte is read.
 *   - At most `maxBytes` are read; a file that is, or grows, larger is refused.
 *
 * Never throws. This module opens for reading only; it is kept apart from `integration-status.ts`,
 * whose source scan allows no `open*` import.
 */

/**
 * What a bounded read found (FIX2A F5). `missing` is a fact the caller may act on (the file does not
 * exist: nothing is installed); `unreadable` is not (a permission error, a FIFO or device, a
 * directory, a file over the cap, an aborted read), so the caller must say "unknown", never guess.
 */
export type BoundedRead =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable" };

const UNREADABLE: BoundedRead = Object.freeze({ kind: "unreadable" });
const MISSING: BoundedRead = Object.freeze({ kind: "missing" });

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * The synchronous bounded read, with `missing` told apart from `unreadable`. For startup and the
 * background refresh only: it is a synchronous file-system call, so nothing on a request path (the
 * health check) may use it. See {@link readBoundedRegularFileAsync}.
 */
export function readBoundedRegularFileDetailed(path: string, maxBytes: number): BoundedRead {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return UNREADABLE;
    const chunks: Buffer[] = [];
    let total = 0;
    const chunk = Buffer.allocUnsafe(Math.min(maxBytes + 1, 64 * 1024));
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      total += read;
      if (total > maxBytes) return UNREADABLE;
      chunks.push(Buffer.from(chunk.subarray(0, read)));
    }
    return { kind: "text", text: Buffer.concat(chunks, total).toString("utf8") };
  } catch (error: unknown) {
    return isMissing(error) ? MISSING : UNREADABLE;
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

/** The same read as text or null (anything unreadable, missing included). Never throws. */
export function readBoundedRegularFile(path: string, maxBytes: number): string | null {
  const read = readBoundedRegularFileDetailed(path, maxBytes);
  return read.kind === "text" ? read.text : null;
}

/**
 * The asynchronous bounded read for the request path (FIX2A F1). Every call goes through the libuv
 * thread pool, so a path on a stalled mount holds a pool thread and not the event loop: timers
 * (the probe caps) still fire, and the caller, which races this against its abort signal, reads
 * `probe-timeout`. The descriptor is opened `O_NONBLOCK` and must be a regular file, exactly as
 * the synchronous read; a signal that has fired by the time a step finishes ends the read and the
 * handle is closed either way, so a call that completes late leaks nothing.
 */
export async function readBoundedRegularFileAsync(
  path: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<BoundedRead> {
  let handle: FileHandle | undefined;
  try {
    if (signal?.aborted === true) return UNREADABLE;
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    if (signal?.aborted === true) return UNREADABLE;
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) return UNREADABLE;
    const chunks: Buffer[] = [];
    let total = 0;
    const chunk = Buffer.allocUnsafe(Math.min(maxBytes + 1, 64 * 1024));
    for (;;) {
      if (signal?.aborted === true) return UNREADABLE;
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) return UNREADABLE;
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
    }
    return { kind: "text", text: Buffer.concat(chunks, total).toString("utf8") };
  } catch (error: unknown) {
    return isMissing(error) ? MISSING : UNREADABLE;
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
  }
}
