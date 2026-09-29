import {
  closeSync,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Logger } from "pino";
import type { ClaudePipeline } from "./pipeline.js";

/**
 * The hook spool poller (D-08, PR-12, ADR-0010). The hook appends one
 * NDJSON line per undelivered record to `spool/hooks.ndjson`; the
 * status-line wrapper replaces `spool/statusline.latest.json` whole. The
 * service drains both at startup (before the socket opens, D-22) and then
 * every `intervalMs` while running.
 *
 * Rename-then-read (RESEARCH Pattern 2): the old startup drain read the
 * file and then truncated it, so a line appended between the read and the
 * truncate was lost; harmless once at startup, not on a 2 s poll. Here a
 * tick first reads every file an EARLIER tick renamed aside, then renames
 * the live spool aside for the NEXT tick. The hook opens the spool with
 * `O_APPEND|O_CREAT` per write, so after the rename a new write creates a
 * fresh file, and a writer still holding the old inode finishes its single
 * `write()` long before the next tick reads it. Because the renamed file
 * has no writer left, its trailing fragment is final: it is discarded and
 * counted, never written back.
 *
 * Every line is untrusted input from a process the service does not
 * control (T-05-28): it goes through the same `pipeline.ingest` validation
 * and eventId idempotency as a socket record. A drained file is deleted
 * only once every one of its lines has been ingested, so a crash, a
 * shutdown or a failed store write mid-file leaves it for the next pass
 * (write-ahead SessionEnd must survive); the replayed lines that were
 * already applied are no-ops under the pipeline's eventId guard. Drained
 * files are then deleted, so the spool stays a transient queue, never an
 * accumulated record of session activity (ADR-0007, ADR-0010).
 *
 * The startup drain has no earlier tick to lean on: it renames the live
 * spool and must read it in the same pass. A hook that opened the file
 * just before the rename may still be about to `write()`, so after
 * renaming a live file the drain waits a short settle before reading.
 */

export interface SpoolPollerOptions {
  readonly spoolPath: string;
  readonly statusLinePath: string;
  readonly dropPath: string;
  readonly pipeline: Pick<ClaudePipeline, "ingest">;
  readonly logger: Logger;
  /** The poll interval; the composition reads `CCC_SPOOL_POLL_MS`, default 2000. */
  readonly intervalMs: number;
  readonly onStatusLine?: (snapshot: unknown) => void;
  /**
   * Awaited between the startup drain's rename of a live spool file and its
   * read, so a writer still holding the old inode finishes its append.
   * Defaults to a {@link STARTUP_SETTLE_MS} timer.
   */
  readonly settle?: () => Promise<void>;
}

export interface SpoolPollerStats {
  /** Final trailing fragments (no newline) found in renamed files and discarded. */
  readonly fragmentsDiscarded: number;
  readonly unparsableLines: number;
  /** Status-line snapshots that arrived while no sink was registered. */
  readonly statusLineDropped: number;
}

export interface SpoolPoller {
  /** Startup: renames and reads at once (both phases), hook spool then status line. */
  drainNow(): Promise<number>;
  /** One poll cycle: read what earlier ticks renamed, then rename the live spool aside. */
  tick(): Promise<number>;
  /** Records the hook dropped at the spool cap: the byte size of `hooks.dropped`. */
  dropCount(): number;
  stats(): SpoolPollerStats;
  setStatusLineSink(sink: (snapshot: unknown) => void): void;
  /** Clears the interval and resolves once any in-flight drain or tick has finished. */
  stop(): Promise<void>;
}

const DRAINING_MARK = ".draining-";
/** The hook caps the spool at 1 MiB; a renamed file is read no further than this. */
const MAX_DRAIN_READ_BYTES = 2 * 1024 * 1024;
/** One status-line snapshot is a few hundred bytes. */
const MAX_STATUSLINE_READ_BYTES = 64 * 1024;
/**
 * The startup drain's settle after renaming a live spool: the hook opens,
 * writes one line and closes within milliseconds, so this comfortably
 * covers a writer that opened the file just before the rename.
 */
const STARTUP_SETTLE_MS = 100;

function defaultSettle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, STARTUP_SETTLE_MS);
  });
}

function errorCode(err: unknown): unknown {
  return (err as { code?: unknown }).code;
}

export function startSpoolPoller(options: SpoolPollerOptions): SpoolPoller {
  const { spoolPath, statusLinePath, dropPath, pipeline, logger } = options;
  let statusLineSink = options.onStatusLine;
  const settle = options.settle ?? defaultSettle;
  let fragmentsDiscarded = 0;
  let unparsableLines = 0;
  let statusLineDropped = 0;
  let renameCounter = 0;
  let busy = false;

  // Startup drains and interval ticks never overlap.
  let chain: Promise<unknown> = Promise.resolve();
  function serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = chain.then(work);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** Renames `path` aside for a later read; an absent file is not an error. True when renamed. */
  function renameAside(path: string): boolean {
    try {
      renameSync(path, `${path}${DRAINING_MARK}${Date.now()}-${renameCounter}`);
      renameCounter += 1;
      return true;
    } catch (err: unknown) {
      if (errorCode(err) !== "ENOENT") {
        logger.warn({ file: basename(path), code: errorCode(err) }, "spool rename failed");
      }
      return false;
    }
  }

  /** Every file renamed aside from `path`, oldest first. */
  function drainingFiles(path: string): string[] {
    const dir = dirname(path);
    const prefix = `${basename(path)}${DRAINING_MARK}`;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    const order = (name: string): number[] =>
      name
        .slice(prefix.length)
        .split("-")
        .map((part) => Number(part));
    return names
      .filter((name) => name.startsWith(prefix))
      .sort((a, b) => {
        const [aTime = 0, aSeq = 0] = order(a);
        const [bTime = 0, bSeq = 0] = order(b);
        return aTime - bTime || aSeq - bSeq;
      })
      .map((name) => join(dir, name));
  }

  /** Reads at most `cap` bytes of `path` as UTF-8. Null when unreadable. */
  function readFile(path: string, cap: number): string | null {
    let text: string | null = null;
    try {
      const fd = openSync(path, "r");
      try {
        const size = fstatSync(fd).size;
        if (size > cap) {
          logger.warn(
            { file: basename(path), size, cap },
            "spool file over its read cap; truncated",
          );
        }
        const buffer = Buffer.alloc(Math.min(size, cap));
        const read = readSync(fd, buffer, 0, buffer.length, 0);
        text = buffer.subarray(0, read).toString("utf8");
      } finally {
        closeSync(fd);
      }
    } catch (err: unknown) {
      logger.warn({ file: basename(path), code: errorCode(err) }, "spool file unreadable");
    }
    return text;
  }

  function deleteFile(path: string): void {
    try {
      unlinkSync(path);
    } catch (err: unknown) {
      if (errorCode(err) !== "ENOENT") {
        logger.warn({ file: basename(path), code: errorCode(err) }, "spool file not deleted");
      }
    }
  }

  interface FileResult {
    readonly ingested: number;
    /** False when an ingest failed: the file is kept and replayed on the next pass. */
    readonly complete: boolean;
  }

  /**
   * Ingests every complete line of one renamed hook-spool file, then deletes
   * it. If an ingest throws (the store failed), the file is kept whole for
   * the next pass and the rest of it is not attempted, preserving order.
   */
  async function ingestFile(path: string): Promise<FileResult> {
    const text = readFile(path, MAX_DRAIN_READ_BYTES);
    if (text === null) {
      // Unreadable now means unreadable next time too: drop it, never spin on it.
      deleteFile(path);
      return { ingested: 0, complete: true };
    }
    const lines = text.split("\n");
    // A file ending in "\n" leaves "" here; anything else is a final fragment.
    const trailing = lines.pop() ?? "";
    if (trailing.trim().length > 0) {
      fragmentsDiscarded += 1;
      logger.warn(
        { bytes: Buffer.byteLength(trailing) },
        "spool trailing fragment discarded; the renamed file has no writer left",
      );
    }
    let ingested = 0;
    for (const [index, line] of lines.entries()) {
      if (line.trim().length === 0) continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        unparsableLines += 1;
        logger.warn({ line: index + 1 }, "spool record failed to parse; skipped");
        continue;
      }
      try {
        await pipeline.ingest(record, "spool");
        ingested += 1;
      } catch (err: unknown) {
        logger.error({ line: index + 1, err }, "spool record ingest failed; file kept for replay");
        return { ingested, complete: false };
      }
    }
    deleteFile(path);
    return { ingested, complete: true };
  }

  /**
   * Status-line snapshots are latest-only and written temp-then-rename, so
   * no writer ever holds the file open: renaming and reading in the same
   * tick is safe.
   */
  function drainStatusLine(): void {
    renameAside(statusLinePath);
    for (const file of drainingFiles(statusLinePath)) {
      const text = readFile(file, MAX_STATUSLINE_READ_BYTES);
      deleteFile(file);
      if (text === null) continue;
      let snapshot: unknown;
      try {
        snapshot = JSON.parse(text);
      } catch {
        logger.warn({}, "status-line spool failed to parse; skipped");
        continue;
      }
      if (statusLineSink === undefined) {
        statusLineDropped += 1;
        continue;
      }
      try {
        statusLineSink(snapshot);
      } catch (err: unknown) {
        logger.warn({ err }, "status-line sink failed");
      }
    }
  }

  async function readRenamed(): Promise<number> {
    let ingested = 0;
    for (const file of drainingFiles(spoolPath)) {
      const result = await ingestFile(file);
      ingested += result.ingested;
      if (!result.complete) break;
    }
    return ingested;
  }

  const tick = (): Promise<number> =>
    serialize(async () => {
      const ingested = await readRenamed();
      renameAside(spoolPath);
      drainStatusLine();
      return ingested;
    });

  const drainNow = (): Promise<number> =>
    serialize(async () => {
      if (renameAside(spoolPath)) await settle();
      const ingested = await readRenamed();
      drainStatusLine();
      return ingested;
    });

  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    tick()
      .catch((err: unknown) => logger.error({ err }, "spool poll failed"))
      .finally(() => {
        busy = false;
      });
  }, options.intervalMs);
  timer.unref();

  return {
    drainNow,
    tick,
    dropCount() {
      try {
        return statSync(dropPath).size;
      } catch {
        return 0;
      }
    },
    stats: () => ({ fragmentsDiscarded, unparsableLines, statusLineDropped }),
    setStatusLineSink(sink) {
      statusLineSink = sink;
    },
    async stop() {
      clearInterval(timer);
      // The chain's tail settles once the in-flight drain or tick finishes.
      await chain;
    },
  };
}
