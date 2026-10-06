// The hook's fixed budgets and wire names. Several duplicate a literal the
// service owns (socket and spool file names, route paths). That duplication
// is deliberate: the hook may import nothing but node: builtins and ./ files
// (D-10, PR-08), so it cannot import @ccc/service or a value from
// @ccc/domain. The equality tests live in this package's tests (against
// @ccc/domain's route constants) and in 05-08 (against the service's paths).

/** The whole hook's time budget from process start: Claude Code must never wait on it (D-08). */
export const HOOK_DEADLINE_MS = 300;

/**
 * The hard exit, from process start: an unref'd timer ends the process here
 * whatever it is waiting on (stdin that never reaches EOF, a callback that
 * never fires). It sits past {@link HOOK_DEADLINE_MS} so a delivery that
 * timed out at the budget still gets to spool its record (wave 2 review).
 */
export const HOOK_EXIT_DEADLINE_MS = HOOK_DEADLINE_MS + 40;

/** Stdin bytes kept for parsing; everything past this is drained and discarded (RESEARCH Q9). */
export const STDIN_RETAIN_BYTES = 262_144;

/** The serialized record's byte cap; the service's 64 KiB body cap stays the outer bound (D-09). */
export const MAX_RECORD_BYTES = 4096;

/** The spool file's byte cap; past it a record is dropped and counted instead (D-08, T-05-10). */
export const SPOOL_MAX_BYTES = 1_048_576;

/** The service's Unix socket, inside the runtime dir (ADR-0001, service paths.ts). */
export const SOCKET_FILE_NAME = "svc.sock";

/** The spool directory inside the runtime dir (service paths.ts `resolveSpoolPath`). */
export const SPOOL_DIR_NAME = "spool";

/** The NDJSON spool file the service drains (ADR-0010). */
export const SPOOL_FILE_NAME = "hooks.ndjson";

/**
 * The status-line wrapper's own spool file, next to the hook spool: ONE
 * snapshot, replaced whole on every undelivered status-line run (temp file
 * then rename, 0600). Status-line snapshots never go into
 * {@link SPOOL_FILE_NAME}: they refresh every few hundred milliseconds, so
 * sharing the hook spool's byte cap would let a service outage fill it with
 * snapshots and drop write-ahead SessionEnd records (wave 2 review). Latest
 * wins at the service anyway, so keeping only the newest loses nothing. The
 * 05-08 spool poller reads it (rename-then-read, like the hook spool) and
 * hands it to the status-line sink.
 */
export const STATUSLINE_SPOOL_FILE_NAME = "statusline.latest.json";

/** One byte is appended here per record dropped at the spool cap; the size is the drop count. */
export const SPOOL_DROP_FILE_NAME = "hooks.dropped";

/** The hook-event ingest route (D-06). */
export const HOOK_EVENTS_PATH = "/api/v1/claude/hook-events";

/** The status-line snapshot ingest route (PR-14). */
export const STATUSLINE_PATH = "/api/v1/claude/statusline";

/** The token handshake route; the only route that needs no bearer token (ADR-0016). */
export const HANDSHAKE_PATH = "/api/v1/handshake";
