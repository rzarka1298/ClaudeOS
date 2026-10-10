/**
 * The pure agent-launch validator (D-08): the TypeScript half of the one hostile-input
 * contract. `scripts/codex/antigravity-extension/bridge-core.js` (`validateAgentShape`,
 * `flagRuleViolation`, `directoryArguments`, `validateAgentRequest`) is the other half and the
 * installed helper re-runs it on every claimed request; the two are kept identical by
 * `scripts/codex/hostile-corpus.json` and the parity test in `@ccc/test-fixtures`.
 *
 * The service runs this BEFORE it writes a bridge request, on the FINAL argv: the exact array
 * that will be written and later executed, never a template. A launch this refuses writes
 * nothing to the queue.
 *
 * What the rules are, in check order (the first fault decides the reason, so a case with
 * several faults gets the same reason from both languages):
 *   1. agent is `claude` or `codex`; argv is an array of 1 to 32 elements;
 *   2. every element is a non-empty string of at most 4096 characters, free of C0 controls
 *      (TAB included), DEL, C1 controls, U+2028 and U+2029;
 *   3. argv[0] is absolute, has no empty, `.` or `..` segment and its basename is exactly the
 *      agent;
 *   4. every element, argv[0] included, normalised by NFKC, lower-casing and removal of every
 *      non-alphanumeric, contains none of the ban tokens;
 *   5. deny-by-default rules for the flags the real CLIs will parse: subcommands are an allowlist
 *      (codex `resume <uuid>` only; no bare operand or prompt, aliases included); config-carrying flags
 *      (`--config`, `--profile`, `--settings`, `-c` and `-p` for codex ...) are refused in every
 *      spelling because their values are TOML or JSON that the CLI decodes AFTER a text match
 *      would have passed; `--permission-mode`, `--sandbox` and `--ask-for-approval` accept only
 *      an allow-list of values; resume and session-id flags need a UUID;
 *   6. env is a plain object of at most 16 `CCC_` keys with bounded, control-free string values.
 *
 * Total: never throws, and a reason never contains the offending value. Pure: no filesystem,
 * process or network. {@link validateAgentLaunchChecked} adds the filesystem questions through
 * injected functions and still reads nothing itself.
 */
import {
  FORBIDDEN_CODEX_TOKENS,
  FORBIDDEN_PERMISSION_TOKENS,
  normaliseForFlagMatch,
} from "./command-template.js";

export const AGENT_NAMES = ["claude", "codex"] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

export const AGENT_ARGV_MAX = 32;
export const AGENT_ELEMENT_MAX = 4096;
export const AGENT_ENV_MAX = 16;
export const AGENT_ENV_VALUE_MAX = 1024;
export const AGENT_ENV_KEY_RE = /^CCC_[A-Z0-9_]+$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Phase 4 pair plus the Codex set, in the order bridge-core.js lists them. */
export const AGENT_BANNED_TOKENS: readonly string[] = [
  ...FORBIDDEN_PERMISSION_TOKENS,
  ...FORBIDDEN_CODEX_TOKENS,
];

/** The fixed reason vocabulary shared with bridge-core.js `AGENT_REASONS`. */
export const AGENT_REASONS = [
  "bad-agent",
  "bad-argv",
  "argv-length",
  "argv-element",
  "argv-control",
  "argv0-not-absolute",
  "argv0-basename",
  "banned-flag",
  "bad-env",
  "env-key",
  "env-value",
] as const;
export type AgentReason = (typeof AGENT_REASONS)[number];

/** The extra reasons only the checked variant can give (they need the filesystem). */
export const AGENT_CHECKED_REASONS = [
  "project-root",
  "cwd-not-directory",
  "cwd-outside",
  "dir-argument-outside",
  "argv0-not-executable",
] as const;
export type AgentCheckedReason = (typeof AGENT_CHECKED_REASONS)[number];

export interface AgentLaunchInput {
  readonly agent: unknown;
  readonly argv: unknown;
  readonly env: unknown;
}

export type AgentLaunchVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: AgentReason };

// C0 (TAB included), DEL, C1, U+2028 and U+2029.
// biome-ignore lint/suspicious/noControlCharactersInRegex: this IS the control-character refusal.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

// Deny-by-default flag rules for the final argv (wave 2 review F-01/F-02). The ban-token match
// compares text; these rules compare what the CLI parsers will decide.
const DENIED_LONG_FLAGS: readonly string[] = [
  "--config",
  "--profile",
  "--settings",
  "--mcp-config",
  "--plugin-dir",
  "--agents",
  "--allowedtools",
  "--allowed-tools",
];
/** codex `-c key=value` overrides and `-p` profile (claude's `-c` is `--continue`). */
const DENIED_CODEX_SHORT: readonly string[] = ["c", "p"];
// Subcommands are ALLOWLISTED, never denylisted: the CLIs have aliases (codex `e` is exec, `a` is
// apply) and a bare positional prompt is dispatched as a subcommand when it matches one. The
// product launches `claude` with no subcommand and `codex` with no subcommand or `resume <uuid>`;
// every other bare operand is refused.
const ALLOWED_SUBCOMMANDS: Readonly<Record<AgentName, readonly string[]>> = {
  claude: [],
  codex: ["resume"],
};
// Flags known to take one value (that value is not an operand). --add-dir is variadic for claude.
const VALUE_FLAGS: Readonly<Record<AgentName, readonly string[]>> = {
  claude: [
    "--model",
    "--permission-mode",
    "--resume",
    "-r",
    "--session-id",
    "--append-system-prompt",
    "--add-dir",
  ],
  codex: [
    "--model",
    "-m",
    "--cd",
    "-C",
    "--add-dir",
    "--ask-for-approval",
    "-a",
    "--sandbox",
    "-s",
  ],
};
const PERMISSION_MODES: readonly string[] = ["default", "plan", "acceptEdits"];
const CODEX_APPROVALS: readonly string[] = ["untrusted", "on-failure", "on-request"];
const CODEX_SANDBOXES: readonly string[] = ["read-only", "workspace-write"];

/** Flags whose value is a directory; containment is checked by the checked variant. */
const DIR_FLAGS: Readonly<
  Record<
    AgentName,
    {
      readonly long: readonly string[];
      readonly short: readonly string[];
      readonly variadic: readonly string[];
    }
  >
> = {
  claude: { long: ["--add-dir"], short: [], variadic: ["--add-dir"] },
  codex: { long: ["--cd", "--add-dir"], short: ["C"], variadic: [] },
};

interface ParsedFlag {
  readonly flag: string;
  readonly inline: string | undefined;
}

/**
 * One argv element as { flag, inline }: flag is the normalised name (`--long` lower-cased with
 * `_` as `-`, or `-x`) and inline the attached value (`--flag=value`, `-xvalue`). Not a flag: null.
 */
function parseFlag(element: string): ParsedFlag | null {
  if (element.startsWith("--")) {
    if (element === "--") return null;
    const eq = element.indexOf("=");
    const name = (eq === -1 ? element : element.slice(0, eq)).toLowerCase().replace(/_/g, "-");
    return { flag: name, inline: eq === -1 ? undefined : element.slice(eq + 1) };
  }
  if (/^-[A-Za-z]/.test(element)) {
    const rest = element.slice(2);
    return { flag: element.slice(0, 2), inline: rest === "" ? undefined : rest.replace(/^=/, "") };
  }
  return null;
}

/** The reason argv[1..] breaks the flag rules, or null. argv is already shape-checked. */
function flagRuleViolation(agent: AgentName, argv: readonly string[]): AgentReason | null {
  const valueFlags = VALUE_FLAGS[agent];
  const variadic = DIR_FLAGS[agent].variadic;
  let consumedUpTo = 0; // argv indexes <= this are values of an earlier flag, not operands
  let operands = 0;
  for (let i = 1; i < argv.length; i++) {
    const element = argv[i] as string;
    const parsed = parseFlag(element);
    if (!parsed) {
      if (i <= consumedUpTo) continue;
      // A bare operand (or `--`): only codex's `resume` as the first operand is allowed.
      if (element === "--" || operands > 0 || !ALLOWED_SUBCOMMANDS[agent].includes(element)) {
        return "banned-flag";
      }
      operands++;
      consumedUpTo = i + 1; // the session id, validated below
      continue;
    }
    const { flag, inline } = parsed;
    if (inline === undefined && valueFlags.includes(flag)) {
      consumedUpTo = i + 1;
      if (variadic.includes(flag)) {
        while (
          consumedUpTo + 1 < argv.length &&
          !(argv[consumedUpTo + 1] as string).startsWith("-")
        ) {
          consumedUpTo++;
        }
      }
    }
    const value = inline !== undefined ? inline : argv[i + 1];
    if (DENIED_LONG_FLAGS.includes(flag)) return "banned-flag";
    if (agent === "codex" && flag.length === 2 && DENIED_CODEX_SHORT.includes(flag.slice(1))) {
      return "banned-flag";
    }
    if (
      flag === "--permission-mode" &&
      !(value !== undefined && PERMISSION_MODES.includes(value))
    ) {
      return "banned-flag";
    }
    if (agent === "codex") {
      if (
        (flag === "-a" || flag === "--ask-for-approval") &&
        !(value !== undefined && CODEX_APPROVALS.includes(value))
      ) {
        return "banned-flag";
      }
      if (
        (flag === "-s" || flag === "--sandbox") &&
        !(value !== undefined && CODEX_SANDBOXES.includes(value))
      ) {
        return "banned-flag";
      }
    }
    if (agent === "claude" && ["--resume", "-r", "--session-id"].includes(flag)) {
      if (value === undefined || !UUID_RE.test(value)) return "bad-argv";
    }
  }
  if (agent === "codex") {
    const at = argv.indexOf("resume", 1);
    if (at !== -1) {
      const next = argv[at + 1];
      if (!(typeof next === "string" && UUID_RE.test(next))) return "bad-argv";
    }
  }
  return null;
}

export interface AgentDirectoryEntry {
  /** The normalised flag name (`--add-dir`, `--cd`, `-C`). */
  readonly flag: string;
  /** The raw value (the caller resolves it); null = the flag has no value. */
  readonly value: string | null;
}

/** Every directory argument of argv[1..] in order, one entry per value. */
export function agentDirectoryEntries(
  agent: AgentName,
  argv: readonly string[],
): readonly AgentDirectoryEntry[] {
  const rules = DIR_FLAGS[agent];
  const found: AgentDirectoryEntry[] = [];
  for (let i = 1; i < argv.length; i++) {
    const parsed = parseFlag(argv[i] as string);
    if (!parsed) continue;
    const { flag, inline } = parsed;
    const isDir =
      rules.long.includes(flag) || (flag.length === 2 && rules.short.includes(flag.slice(1)));
    if (!isDir) continue;
    if (inline !== undefined) {
      found.push({ flag, value: inline });
      continue;
    }
    const values: string[] = [];
    for (
      let j = i + 1;
      j < argv.length && (values.length === 0 || rules.variadic.includes(flag));
      j++
    ) {
      const candidate = argv[j] as string;
      if (candidate.startsWith("-")) break;
      values.push(candidate);
    }
    if (values.length === 0) found.push({ flag, value: null });
    else for (const value of values) found.push({ flag, value });
  }
  return found;
}

/** True for the codex working-directory flags (`--cd`, `-C`): the base every other path resolves against. */
function isWorkingDirFlag(agent: AgentName, flag: string): boolean {
  return agent === "codex" && (flag === "--cd" || flag === "-C");
}

function shapeVerdict(input: AgentLaunchInput): AgentLaunchVerdict {
  const no = (reason: AgentReason): AgentLaunchVerdict => ({ ok: false, reason });
  if (!input || typeof input !== "object") return no("bad-agent");
  const { agent, argv, env } = input;
  if (typeof agent !== "string" || !(AGENT_NAMES as readonly string[]).includes(agent)) {
    return no("bad-agent");
  }
  const agentName = agent as AgentName;
  if (!Array.isArray(argv)) return no("bad-argv");
  if (argv.length < 1 || argv.length > AGENT_ARGV_MAX) return no("argv-length");
  const elements: unknown[] = argv;
  for (let i = 0; i < elements.length; i++) {
    const element = elements[i];
    if (typeof element !== "string" || element.length < 1 || element.length > AGENT_ELEMENT_MAX) {
      return no("argv-element");
    }
    if (CONTROL_RE.test(element)) return no("argv-control");
  }
  const strings = elements as string[];
  const exe = strings[0] as string;
  if (!exe.startsWith("/")) return no("argv0-not-absolute");
  const segments = exe.split("/").slice(1);
  if (segments.some((seg) => seg === "" || seg === "." || seg === "..")) {
    return no("argv0-not-absolute");
  }
  if (segments[segments.length - 1] !== agentName) return no("argv0-basename");
  for (const element of strings) {
    const normalised = normaliseForFlagMatch(element);
    if (AGENT_BANNED_TOKENS.some((token) => normalised.includes(token))) return no("banned-flag");
  }
  const violation = flagRuleViolation(agentName, strings);
  if (violation) return no(violation);
  if (
    !env ||
    typeof env !== "object" ||
    Array.isArray(env) ||
    (Object.getPrototypeOf(env) !== Object.prototype && Object.getPrototypeOf(env) !== null)
  ) {
    return no("bad-env");
  }
  const record = env as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length > AGENT_ENV_MAX) return no("bad-env");
  for (const key of keys) if (!AGENT_ENV_KEY_RE.test(key)) return no("env-key");
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "string" || value.length > AGENT_ENV_VALUE_MAX || CONTROL_RE.test(value)) {
      return no("env-value");
    }
  }
  return { ok: true };
}

/**
 * The shape check for `{ agent, argv, env }`. Pure and total. A throwing getter or a hostile
 * proxy is answered with `bad-argv`; the JavaScript helper only ever sees parsed JSON.
 */
export function validateAgentLaunch(input: AgentLaunchInput): AgentLaunchVerdict {
  try {
    return shapeVerdict(input);
  } catch {
    return { ok: false, reason: "bad-argv" };
  }
}

export interface AgentLaunchChecks {
  /** The service passes a stat that follows symlinks: an existing regular file with an execute bit. */
  readonly isExecutable: (path: string) => boolean | Promise<boolean>;
  /**
   * The service passes `realpath(resolve(base, path))` when that is an existing directory, else
   * null. `path` may be relative; `base` is the directory it is relative to.
   */
  readonly realDir: (path: string, base: string) => string | null | Promise<string | null>;
}

export interface CheckedAgentLaunchInput extends AgentLaunchInput {
  /** Absolute path of the registered project. */
  readonly projectRoot: string;
  /** Where the agent starts; defaults to the project root. */
  readonly cwd?: string | null;
}

export type CheckedAgentLaunchVerdict =
  | { readonly ok: true; readonly projectRoot: string; readonly cwd: string }
  | { readonly ok: false; readonly reason: AgentReason | AgentCheckedReason };

function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

/**
 * The full pre-write validation: the shape rules pass, the project root and cwd are real
 * directories with the cwd inside the project, every `--add-dir`, `-C` and `--cd` argument resolves (real
 * path, relative to the cwd) to a directory inside the project, and argv[0] is an executable file.
 * The pure shape runs first, so a refused shape asks the filesystem nothing; the rest follows the
 * helper's `validateAgentRequest` order. Reads nothing itself; a check that throws is a refusal.
 */
export async function validateAgentLaunchChecked(
  input: CheckedAgentLaunchInput,
  checks: AgentLaunchChecks,
): Promise<CheckedAgentLaunchVerdict> {
  const no = (reason: AgentReason | AgentCheckedReason): CheckedAgentLaunchVerdict => ({
    ok: false,
    reason,
  });
  const safeDir = async (path: string, base: string): Promise<string | null> => {
    try {
      const real = await checks.realDir(path, base);
      return typeof real === "string" && real.startsWith("/") ? real : null;
    } catch {
      return null;
    }
  };
  try {
    // The pure shape first: a hostile launch is refused before any filesystem question is asked.
    const shape = validateAgentLaunch(input);
    if (!shape.ok) return no(shape.reason);
    const rootArg = input.projectRoot;
    const projectRoot =
      typeof rootArg === "string" && rootArg.startsWith("/") ? await safeDir(rootArg, "/") : null;
    if (projectRoot === null) return no("project-root");
    const cwdArg = input.cwd;
    let cwd = projectRoot;
    if (cwdArg !== undefined && cwdArg !== null) {
      const real =
        typeof cwdArg === "string" && cwdArg.startsWith("/") ? await safeDir(cwdArg, "/") : null;
      if (real === null) return no("cwd-not-directory");
      cwd = real;
    }
    if (!isInside(cwd, projectRoot)) return no("cwd-outside");
    const agent = input.agent as AgentName;
    const argv = input.argv as readonly string[];
    // Codex resolves --add-dir (and every other path) against its --cd/-C directory, so that
    // effective directory is computed first (relative to the request cwd; the last --cd wins, as
    // in the CLI) and every other directory argument is realpath-checked against it.
    const entries = agentDirectoryEntries(agent, argv);
    let effectiveCwd = cwd;
    for (const entry of entries) {
      if (!isWorkingDirFlag(agent, entry.flag)) continue;
      const resolved = entry.value === null ? null : await safeDir(entry.value, cwd);
      if (resolved === null || !isInside(resolved, projectRoot)) return no("dir-argument-outside");
      effectiveCwd = resolved;
    }
    for (const entry of entries) {
      if (isWorkingDirFlag(agent, entry.flag)) continue;
      const resolved = entry.value === null ? null : await safeDir(entry.value, effectiveCwd);
      if (resolved === null || !isInside(resolved, projectRoot)) return no("dir-argument-outside");
    }
    let executable = false;
    try {
      executable = (await checks.isExecutable(argv[0] as string)) === true;
    } catch {
      executable = false;
    }
    if (!executable) return no("argv0-not-executable");
    return { ok: true, projectRoot, cwd };
  } catch {
    return no("bad-argv");
  }
}
