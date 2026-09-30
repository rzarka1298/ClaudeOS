/**
 * Owner-authored command templates (D-22, PROJ-10) and the custom-terminal
 * presets (D-23).
 *
 * A template is an argv array, never a string. Placeholders (`{projectPath}`,
 * `{script}`) are whole elements only and are replaced element-for-element;
 * rendering never splits, joins or re-parses an element, so a project path
 * full of spaces and quotes is still exactly one argument.
 *
 * The validator stays strict on purpose (E-6). Templates are owner-authored,
 * but a permissive validator turns a typo into a different program:
 *   - `argv[0]` must be absolute and executable — no `PATH` lookup, so the
 *     program that runs is the one the owner saw in the preview. The
 *     executable check needs `fs`, so it is injected (`isExecutable`) and
 *     this package stays free of filesystem access.
 *   - A placeholder embedded in a larger element (`--cwd={projectPath}`) is
 *     refused: substituting inside an element is how a value starts being
 *     parsed by whatever reads that element.
 *   - A placeholder that directly follows an interpreter's "run this code"
 *     flag (`sh -c`, `zsh -lc`, `perl -e`, `node --eval`, `pwsh -Command`,
 *     `osascript -e`) is refused for the same reason: a whole element is
 *     still parsed when the program reads it as source
 *     ({@link placeholderRunsAsCode}).
 *   - The Claude Code permission bypass is refused in any form -- the
 *     `--dangerously-skip-permissions` flag and the `bypassPermissions`
 *     permission mode, however spelled -- in either kind of template
 *     (CLAUDE.md prohibition, {@link FORBIDDEN_PERMISSION_TOKENS}).
 *
 * Presets route through `/usr/bin/open` or `/usr/bin/osascript`, which
 * return once the terminal has been handed the script, so exit status 0
 * means "handed off" (RESEARCH Pattern 1). An owner template that runs the
 * terminal binary directly is started detached by the service instead, so
 * the launch deadline never kills its window (ADR-0024, Terminal presets). Every preset ships `verified: false` until the owner
 * tests it (D-23).
 */
import type { TemplateRefusalReason, TerminalPresetId } from "@ccc/domain";
import { MAX_TEMPLATE_ARGUMENTS } from "@ccc/domain";
import { OPEN } from "./app-actions.js";

export const PLACEHOLDERS = ["{projectPath}", "{script}"] as const;

export const OSASCRIPT = "/usr/bin/osascript";
export type Placeholder = (typeof PLACEHOLDERS)[number];

/** The Claude Code permission-bypass flag, as documented. Refused in every template. */
export const FORBIDDEN_CLAUDE_FLAGS = ["--dangerously-skip-permissions"] as const;

/**
 * What the validator actually matches. Each argv element is normalised
 * (NFKC, lower-cased, every non-alphanumeric removed) and refused when it
 * contains either token, so `--dangerously_skip_permissions`,
 * `--permission-mode=bypassPermissions`, a bare `bypassPermissions` after
 * `--permission-mode`, and a `--settings` JSON value whose `defaultMode` is
 * `bypassPermissions` are all refused.
 */
export const FORBIDDEN_PERMISSION_TOKENS = [
  "dangerouslyskippermissions",
  "bypasspermissions",
] as const;

/** Executable plus arguments never exceed this many elements (UI-SPEC S7). */
export const MAX_TEMPLATE_ARGS = MAX_TEMPLATE_ARGUMENTS;

/**
 * `terminal`: a custom terminal command; must contain `{script}` and may use `{projectPath}`.
 * `claude-code`: the `claude` command line; may use `{projectPath}` only. In both, `argv[0]` is the executable.
 */
export type TemplateKind = "terminal" | "claude-code";

/** The refusals this pure validator can decide; the bundle and executable lookups are service-side. */
export type TemplateRefusal = Exclude<
  TemplateRefusalReason,
  "bundle-not-found" | "executable-not-found"
>;

export interface ValidateTemplateOptions {
  readonly kind: TemplateKind;
  /** The service passes an `accessSync(path, X_OK)` check. Called with `argv[0]` only. */
  readonly isExecutable: (path: string) => boolean;
}

/** `index` is the offending element, or `null` when the refusal is about the template as a whole. */
export type TemplateValidation =
  | { readonly ok: true; readonly argv: readonly string[] }
  | { readonly ok: false; readonly reason: TemplateRefusal; readonly index: number | null };

export interface TemplateValues {
  readonly script?: string;
  readonly projectPath?: string;
}

export interface TerminalPreset {
  readonly id: TerminalPresetId;
  readonly label: string;
  readonly argv: readonly string[];
  readonly verified: false;
  readonly note: string;
}

const ALLOWED_PLACEHOLDERS: Readonly<Record<TemplateKind, readonly Placeholder[]>> = {
  terminal: ["{projectPath}", "{script}"],
  "claude-code": ["{projectPath}"],
};

/** An element that is entirely one brace-wrapped name, e.g. `{script}` or a typo like `{scrpt}`. */
const WHOLE_TOKEN_PLACEHOLDER = /^\{[A-Za-z][A-Za-z0-9]*\}$/;
const NUL = String.fromCharCode(0);

function hasLineBreak(element: string): boolean {
  return element.includes("\n") || element.includes("\r") || element.includes(NUL);
}

function normaliseForFlagMatch(element: string): string {
  return element
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** `previous` is the element before this one, for the `--permission-mode <mode>` form. */
function containsForbiddenFlag(element: string, previous: string | undefined): boolean {
  const normalised = normaliseForFlagMatch(element);
  if (FORBIDDEN_PERMISSION_TOKENS.some((token) => normalised.includes(token))) return true;
  // Subsumed by the token check today; kept explicit so the two-element
  // `--permission-mode bypassPermissions` form stays refused if the tokens change.
  return (
    previous !== undefined &&
    normaliseForFlagMatch(previous) === "permissionmode" &&
    normalised === "bypasspermissions"
  );
}

/** Long-form flags whose next argument is source code (node, PowerShell). */
const LONG_CODE_FLAGS: ReadonlySet<string> = new Set(["--eval", "-command", "--command"]);

/**
 * True when `placeholder`, as the element right after `flag`, would be read
 * as source code rather than as a value. Matched: a short-option bundle
 * ending in `c` (`-c`, `-lc`, `-ic`: sh, bash, zsh, python) or in `e`/`E`
 * (`-e`, `-ne`, `-E`: perl, ruby, node, osascript), and `--eval`,
 * `-Command`, `--command` in any letter case.
 *
 * One exception keeps the Ghostty preset (and terminals like it) usable: a
 * bare `-e` followed by `{script}` is a terminal emulator's "run this
 * program", so it stays allowed unless the executable is osascript, whose
 * `-e` is AppleScript source. `{script}` is the service-generated script
 * path; `{projectPath}` after any of these flags is always refused.
 */
function placeholderRunsAsCode(
  placeholder: string,
  flag: string | undefined,
  executable: string | undefined,
): boolean {
  if (flag === undefined) return false;
  const bundle = /^-[A-Za-z]+$/.test(flag) && !flag.startsWith("--");
  const codeFlag = (bundle && /[ceE]$/.test(flag)) || LONG_CODE_FLAGS.has(flag.toLowerCase());
  if (!codeFlag) return false;
  if (placeholder === "{script}" && flag === "-e" && executable !== OSASCRIPT) return false;
  return true;
}

function refuse(reason: TemplateRefusal, index: number | null): TemplateValidation {
  return { ok: false, reason, index };
}

/**
 * Validates a command template (D-22). Total: never throws. Element checks
 * run in index order, so the first offending element is reported.
 */
export function validateCommandTemplate(
  argv: readonly string[],
  options: ValidateTemplateOptions,
): TemplateValidation {
  if (argv.length > MAX_TEMPLATE_ARGS) return refuse("too-many-arguments", MAX_TEMPLATE_ARGS);
  if (argv.length === 0) return refuse("executable-not-absolute", 0);

  const allowed = ALLOWED_PLACEHOLDERS[options.kind];
  for (const [index, element] of argv.entries()) {
    if (hasLineBreak(element)) return refuse("line-break", index);
    if (element === "") return refuse("empty-argument", index);
    if (containsForbiddenFlag(element, argv[index - 1])) return refuse("forbidden-flag", index);

    if (index === 0) {
      if (!element.startsWith("/")) return refuse("executable-not-absolute", 0);
      if (!options.isExecutable(element)) return refuse("executable-not-executable", 0);
      continue;
    }

    if (WHOLE_TOKEN_PLACEHOLDER.test(element)) {
      if (!(allowed as readonly string[]).includes(element)) {
        return refuse("unknown-placeholder", index);
      }
      if (placeholderRunsAsCode(element, argv[index - 1], argv[0])) {
        return refuse("embedded-placeholder", index);
      }
      continue;
    }
    if (PLACEHOLDERS.some((placeholder) => element.includes(placeholder))) {
      return refuse("embedded-placeholder", index);
    }
  }

  if (options.kind === "terminal" && !argv.includes("{script}")) {
    return refuse("missing-script-placeholder", null);
  }
  return { ok: true, argv };
}

/**
 * Replaces whole-token placeholders, element for element; every other
 * element is returned unchanged. Throws when the template uses a
 * placeholder whose value was not supplied. Validate first.
 */
export function renderCommandTemplate(
  argv: readonly string[],
  values: TemplateValues,
): readonly string[] {
  return argv.map((element) => {
    if (element === "{script}") {
      if (values.script === undefined)
        throw new RangeError("no value for the {script} placeholder");
      return values.script;
    }
    if (element === "{projectPath}") {
      if (values.projectPath === undefined) {
        throw new RangeError("no value for the {projectPath} placeholder");
      }
      return values.projectPath;
    }
    return element;
  });
}

/** Custom-terminal presets (RESEARCH "Terminal Presets"). All unverified until the owner's Test step succeeds. */
export const TERMINAL_PRESETS: readonly TerminalPreset[] = [
  {
    id: "iterm2",
    label: "iTerm2",
    argv: [
      OSASCRIPT,
      "-e",
      "on run argv",
      "-e",
      'tell application id "com.googlecode.iterm2" to create window with default profile command (item 1 of argv)',
      "-e",
      "end run",
      "{script}",
    ],
    verified: false,
    note: "The script path reaches AppleScript as an argument, never inside the script source. macOS asks once for Automation permission to control iTerm2.",
  },
  {
    id: "ghostty",
    label: "Ghostty",
    argv: [OPEN, "-na", "Ghostty", "--args", "-e", "{script}"],
    verified: false,
    note: "Ghostty may run the command a second time as typed text; the launch script has already deleted itself, so the second run does nothing.",
  },
  {
    id: "wezterm",
    label: "WezTerm",
    argv: [OPEN, "-na", "WezTerm", "--args", "start", "--cwd", "{projectPath}", "--", "{script}"],
    verified: false,
    note: "Starts through open so the launch is reported as soon as WezTerm receives it.",
  },
  {
    id: "blank",
    label: "Blank template",
    argv: ["", "{script}"],
    verified: false,
    note: "Fill in the full path of your terminal's executable before saving.",
  },
];
