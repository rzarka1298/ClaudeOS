// The Codex hook's wire names. They duplicate literals the domain package and
// the service own (the route path, the spool file names, the event names)
// because the hook may import nothing but node: builtins and relative files:
// it cannot import a value from @ccc/domain. limits.test.ts asserts every one
// equal to the domain constant. The shared budgets (the 300 ms deadline, the
// exit deadline, the stdin cap, the record cap, the spool cap) are NOT
// redefined here: entry.ts and minimize.ts import them from ../hook/limits.js.

/** The Codex hook-event ingest route (plan 05.1-06 `CODEX_HOOK_EVENTS_PATH`). */
export const CODEX_HOOK_EVENTS_PATH = "/api/v1/codex/hook-events";

/**
 * The Codex NDJSON spool file, next to Claude's `hooks.ndjson` in the same
 * spool directory. A separate file keeps its 1 MiB cap and drop counter
 * independent: a Codex outage can never fill Claude's spool (T-05.1-35).
 */
export const CODEX_SPOOL_FILE_NAME = "codex-hooks.ndjson";

/** One byte is appended here per Codex record dropped at the spool cap. */
export const CODEX_SPOOL_DROP_FILE_NAME = "codex-hooks.dropped";
