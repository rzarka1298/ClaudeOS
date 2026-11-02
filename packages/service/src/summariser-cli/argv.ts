import type { SummariserModel } from "@ccc/domain";

/**
 * The exact command line and environment of one `claude` summariser call (plan 10-02, D-01, D-02).
 *
 * Pure: no process module, no file system, no clock and no read of `process.env` (the caller passes
 * the parent environment). The transport (10-04) runs the argv with `shell: false`; the delimited
 * untrusted input goes to the child on stdin, never into the argv, so `ps` shows only the fixed
 * instructions (T-10-10). The flag set is the one 10-RESEARCH.md ran on CLI 2.1.316.
 */

/** The readiness probe's argv (no model call; 10-05 parses only `loggedIn` and `authMethod`). */
export const CLAUDE_AUTH_STATUS_ARGV: readonly string[] = Object.freeze(["auth", "status"]);

/** Every variable the child may ever see. Anything else in the parent environment is dropped. */
export const CLAUDE_CHILD_ENV_KEYS = Object.freeze([
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "LANG",
  "PATH",
] as const);

export interface ClaudeArgvInput {
  /** One of the owner's allowed summariser models. */
  readonly model: SummariserModel;
  /** The fixed summariser instructions; they replace Claude Code's agentic system prompt. */
  readonly instructions: string;
}

/**
 * Builds the argv (after the absolute binary path), in this order:
 *
 * - `-p`: headless print mode, one answer, no interactive session.
 * - `--model <model>`: the owner's allowlisted model; the stream parser refuses any other in init.
 * - `--tools ""`: every built-in tool off. The option is variadic, so it stays ahead of the other
 *   flags and no positional prompt follows it.
 * - `--strict-mcp-config` with no `--mcp-config`: no MCP server can load.
 * - `--disable-slash-commands`: no slash command or skill (init lists 55 and 19 without it).
 * - `--setting-sources ""`: the flag that blocks the owner's hooks, plugins, agents and permission
 *   mode (`--safe-mode` alone left the owner's plugins and `auto` mode in place).
 * - `--safe-mode`: defence in depth beside the empty setting sources.
 * - `--no-session-persistence`: nothing written under the owner's session store.
 * - `--max-turns 1`: one assistant turn.
 * - `--permission-prompts none`: nothing can wait on an approval (CLI 2.1.259 or later).
 * - `--system-prompt <instructions>`: replaces the system prompt, never appends.
 * - `--output-format stream-json --verbose`: the only output format with an init event the parser
 *   can verify; stream-json needs `--verbose`.
 *
 * Deliberately absent: `--bare` (refuses subscription auth), `--mcp-config`, `--add-dir`,
 * `--allowedTools`, `--plugin-dir`, `--settings`, `--agents`, a permission mode, and any
 * permission-bypass flag.
 */
export function buildClaudeArgv(input: ClaudeArgvInput): readonly string[] {
  const { model, instructions } = input;
  // The value after `--system-prompt` must not read as a flag, and an argv element cannot hold a
  // NUL. The message never carries the instructions text.
  if (instructions.length === 0 || instructions.includes("\0") || instructions.startsWith("-")) {
    throw new RangeError("summariser instructions are not a safe argv value");
  }
  return [
    "-p",
    "--model",
    model,
    "--tools",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--setting-sources",
    "",
    "--safe-mode",
    "--no-session-persistence",
    "--max-turns",
    "1",
    "--permission-prompts",
    "none",
    "--system-prompt",
    instructions,
    "--output-format",
    "stream-json",
    "--verbose",
  ];
}

const PLAIN_NAME = /^[A-Za-z0-9._-]{1,128}$/;

/** An absolute path with no NUL, no newline and no carriage return. */
function isPlainAbsolutePath(value: string | undefined): value is string {
  return (
    value !== undefined &&
    value.length > 1 &&
    value.length <= 4096 &&
    value.startsWith("/") &&
    !/[\0\r\n]/.test(value)
  );
}

function isPlainName(value: string | undefined): value is string {
  return value !== undefined && PLAIN_NAME.test(value);
}

/**
 * Builds the child environment from scratch (D-02, OD-1, T-10-03). Only five values ever come from
 * the service's own environment (`HOME`, `USER`, `LOGNAME` when plain, `TMPDIR`) plus two fixed
 * ones (`LANG`, `PATH`), so no `ANTHROPIC_*`, `CLAUDE_*`, proxy, TLS or `NODE_*` variable can
 * reach the child: `apiKeySource` in init cannot reveal a bearer-token variable, so this
 * allowlist is the real guard. `HOME` and `USER` are both required (without them the CLI reports
 * it is not logged in). Returns null when `HOME`, `USER` or `TMPDIR` is missing or not plain; the
 * caller reports `summariser-unconfigured` or `summariser-failed` without spawning anything.
 */
export function buildClaudeChildEnv(
  parent: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> | null {
  const { HOME, USER, LOGNAME, TMPDIR } = parent;
  if (!isPlainAbsolutePath(HOME) || !isPlainName(USER) || !isPlainAbsolutePath(TMPDIR)) {
    return null;
  }
  return {
    HOME,
    USER,
    ...(isPlainName(LOGNAME) ? { LOGNAME } : {}),
    TMPDIR,
    LANG: "en_US.UTF-8",
    PATH: "/usr/bin:/bin",
  };
}
