/**
 * The single POSIX shell-quoting implementation for the whole repository
 * (D-17, PROJ-13). Nothing else may build shell text from a dynamic value.
 *
 * Rule: POSIX.1-2024 XCU §2.2.2 "Single-Quotes" — "Enclosing characters in
 * single-quotes shall preserve the literal value of each character within
 * the single-quotes. A single-quote cannot occur within single-quotes."
 * So every value is wrapped in `'…'` and each embedded `'` becomes the
 * close-quote / backslash-escaped quote / reopen-quote sequence `'\''`.
 *
 * Rejected alternatives:
 *   - Double quotes: `$`, backtick and `\` stay live inside `"…"`, so
 *     `$(…)`, `` `…` `` and parameter expansion still run.
 *   - `$'…'` (ANSI-C quoting): only standardised in POSIX.1-2024, its escape
 *     language is a second interpreter to get right, and older `/bin/sh`
 *     builds treat it differently.
 *   - An escaping blacklist: it has to enumerate every metacharacter of
 *     every shell; single quotes need to handle exactly one.
 *
 * NUL cannot be represented in a C argv or environment at all, and a line
 * break would make the script's one-command-per-line layout ambiguous to a
 * reader, so both are refused rather than quoted.
 */

/** Why a value was refused by {@link shQuote} or the launch-script renderer. */
export type UnsafeScriptArgumentReason = "nul" | "line-break" | "env-key";

const REFUSAL_MESSAGE = "value cannot be placed in a launch script";

/**
 * Thrown when a value cannot be placed in a launch script. The message is a
 * constant and never echoes the value (a project path or argument may be
 * private); the reason is a field.
 */
export class UnsafeScriptArgumentError extends Error {
  readonly reason: UnsafeScriptArgumentReason;

  constructor(reason: UnsafeScriptArgumentReason) {
    super(REFUSAL_MESSAGE);
    this.name = "UnsafeScriptArgumentError";
    this.reason = reason;
  }
}

const NUL = String.fromCharCode(0);
const LINE_BREAK = /[\n\r]/;

/** Returns `value` as one POSIX single-quoted shell word. Throws {@link UnsafeScriptArgumentError} on NUL, CR or LF. */
export function shQuote(value: string): string {
  if (value.includes(NUL)) throw new UnsafeScriptArgumentError("nul");
  if (LINE_BREAK.test(value)) throw new UnsafeScriptArgumentError("line-break");
  return `'${value.replaceAll("'", "'\\''")}'`;
}
