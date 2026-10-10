import { join } from "node:path";
import type { Logger } from "pino";
import { type SpoolPoller, startSpoolPoller } from "../claude/spool-poller.js";
import type { CodexHookPipeline } from "./hook-pipeline.js";

/**
 * The Codex hook spool drain (plan 05.1-32, D-19, T-05.1-35).
 *
 * The hook appends one NDJSON line per undelivered record to its own file next
 * to Claude's, and a SessionEnd is written ahead of the socket attempt. This
 * module drains that file with the Phase 5 rename-then-read poller UNCHANGED
 * (`startSpoolPoller`, through its factory): same startup drain with the settle
 * wait, same tick, same trailing-fragment rule, same keep-the-file-until-every-
 * line-was-ingested rule. Because the pipeline is idempotent on the event id, a
 * record delivered by the socket and still present in the spool, or a file
 * replayed after a crash, applies once.
 *
 * Only the file names differ. Every path is built here from the runtime
 * directory; nothing from a record can reach a path. The poller's status-line
 * path is a name that never exists (the Codex hook writes no status line), and
 * differs from Claude's so the two pollers can never touch each other's files:
 * the draining prefix of each file name is distinct.
 */

/** The Codex spool file; plan 05.1-16 `CODEX_SPOOL_FILE_NAME` (a test asserts equality). */
export const CODEX_HOOK_SPOOL_FILE_NAME = "codex-hooks.ndjson";
/** One byte is appended per record the hook dropped at its cap (`CODEX_SPOOL_DROP_FILE_NAME`). */
export const CODEX_HOOK_DROP_FILE_NAME = "codex-hooks.dropped";
/** A status-line snapshot name the Codex side never writes; the poller tolerates its absence. */
const UNUSED_STATUS_LINE_FILE_NAME = "codex-hooks.statusline.unused";

export interface CodexHookSpoolOptions {
  /** The service's own runtime directory; the spool lives in its `spool` folder. */
  readonly runtimeDir: string;
  readonly pipeline: Pick<CodexHookPipeline, "ingest" | "attachDropCount">;
  readonly logger: Logger;
  /** The poll interval; the composition passes the same value Claude's poller uses. */
  readonly intervalMs: number;
  /** Awaited between the startup drain's rename and read; defaults to the Phase 5 timer. */
  readonly settle?: () => Promise<void>;
}

/** The Phase 5 poller handle (`drainNow`, `tick`, `dropCount`, `stats`, `stop`). */
export type CodexHookSpool = SpoolPoller;

export function startCodexHookSpool(options: CodexHookSpoolOptions): CodexHookSpool {
  const spoolDir = join(options.runtimeDir, "spool");
  const poller = startSpoolPoller({
    spoolPath: join(spoolDir, CODEX_HOOK_SPOOL_FILE_NAME),
    statusLinePath: join(spoolDir, UNUSED_STATUS_LINE_FILE_NAME),
    dropPath: join(spoolDir, CODEX_HOOK_DROP_FILE_NAME),
    pipeline: options.pipeline,
    logger: options.logger,
    intervalMs: options.intervalMs,
    ...(options.settle === undefined ? {} : { settle: options.settle }),
  });
  options.pipeline.attachDropCount(() => poller.dropCount());
  return poller;
}
