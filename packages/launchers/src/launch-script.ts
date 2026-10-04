/**
 * Renders the generated launch script — the only shell-parsed artifact in
 * the product (ADR-0011 as corrected by ADR-0024, D-17, D-20).
 *
 * Every dynamic value (the working directory, each argv element, each env
 * value) passes through {@link shQuote}; env keys are restricted to the
 * `CCC_` namespace ({@link LAUNCH_ENV_KEY_PATTERN}). The only other text in
 * the script is constant.
 *
 * Layout, one line each:
 *   1. `#!/bin/sh` — run by the kernel shebang, exactly as Terminal does.
 *   2. `rm -f -- "$0"` — the script deletes itself before anything else
 *      runs, so a hand-off that fails later never leaves a runnable file
 *      behind and a second run (Ghostty re-types the command once) finds
 *      nothing.
 *   3. `export KEY='value'` per env entry.
 *   4. `cd -- '<cwd>' || { printf …; exit 1; }` — a fixed message, never the
 *      path, when the folder is gone or macOS blocks access.
 *   5. the argv as single-quoted words.
 *   6. `exec "${SHELL:-/bin/zsh}" -l` — replaces the script with the owner's
 *      login shell after the command exits, so the Terminal window stays
 *      useful instead of closing on the first `claude` exit (D-20).
 */
import { shQuote, UnsafeScriptArgumentError } from "./sh-quote.js";

/** What a launch script runs: a working directory, an argv, and an optional exported env. */
export interface LaunchScriptInput {
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

/** Printed when `cd` fails. A constant: it never contains the project path. */
export const CD_FAILED_MESSAGE =
  "Claude command center could not open the project folder. It may have moved, or macOS may be blocking access.";

/**
 * Env keys a launch script may export: `CCC_` followed by upper-case
 * letters, digits and underscores. The env option exists so Phase 5 can pass
 * `CCC_RUN_ID` and `CCC_LAUNCH_SOURCE` (plan 04-09, PR-07); nothing needs a
 * key outside the namespace, and a well-formed name such as `PATH`, `IFS`,
 * `BASH_ENV`, `DYLD_INSERT_LIBRARIES` or `NODE_OPTIONS` would change how the
 * shell, the loader or the launched program behaves.
 */
export const LAUNCH_ENV_KEY_PATTERN = /^CCC_[A-Z0-9_]+$/;
const SELF_DELETE_LINE = 'rm -f -- "$0"';
// biome-ignore lint/suspicious/noTemplateCurlyInString: this is literal shell text; the shell expands SHELL, not JavaScript.
const LOGIN_SHELL_LINE = 'exec "${SHELL:-/bin/zsh}" -l';

/** Renders the launch script text. Throws {@link UnsafeScriptArgumentError} on an unsafe value or a non-`CCC_` env key, and on an empty argv. */
export function renderLaunchScript(input: LaunchScriptInput): string {
  if (input.argv.length === 0) {
    throw new RangeError("a launch script needs at least one argv element");
  }
  const lines = ["#!/bin/sh", SELF_DELETE_LINE];
  for (const [key, value] of Object.entries(input.env ?? {})) {
    if (!LAUNCH_ENV_KEY_PATTERN.test(key)) throw new UnsafeScriptArgumentError("env-key");
    lines.push(`export ${key}=${shQuote(value)}`);
  }
  lines.push(
    `cd -- ${shQuote(input.cwd)} || { printf '%s\\n' ${shQuote(CD_FAILED_MESSAGE)}; exit 1; }`,
  );
  lines.push(input.argv.map((arg) => shQuote(arg)).join(" "));
  lines.push(LOGIN_SHELL_LINE);
  return `${lines.join("\n")}\n`;
}
