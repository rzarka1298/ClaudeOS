import {
  MAX_TEMPLATE_ARGUMENTS,
  type RefusedTemplate,
  type TemplateRefusalReason,
} from "@ccc/domain";
import type { VNode } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { FieldError, type RowError } from "./launcher-panel-kit.js";

/**
 * The S7 argument template editor and its preview (plan 04-12, D-22,
 * RR-13, PR-13). One labelled input per argv element and no free-text
 * command line anywhere, so the UI never introduces a parsing step: what
 * the preview lists, one element per line, is exactly what runs.
 *
 * The plugin checks only the trivial things on blur (an absolute
 * executable, an empty argument, a line break); the service owns the full
 * D-22 validation and answers `{ reason, index }`, which arrives here as
 * `errors` keyed by the template index it names.
 */

/**
 * `claude-code` edits `[claude, ...args]`'s args; `codex` (Phase 05.1) edits
 * `[codex, ...args]`'s args the same way; `terminal` edits a custom terminal's
 * whole argv.
 */
export type TemplateEditorKind = "claude-code" | "codex" | "terminal";

/** The S7 copy for each service refusal reason (the `▲` is rendered beside it). */
export const TEMPLATE_REFUSAL_COPY: Readonly<Record<TemplateRefusalReason, string>> = {
  "executable-not-absolute": "The executable must be a full path, starting with /.",
  "executable-not-executable": "There's no executable file at this path.",
  "embedded-placeholder": "Placeholders must be a whole argument, like {script}.",
  "missing-script-placeholder": "The template needs a {script} argument.",
  "forbidden-flag": "--dangerously-skip-permissions isn't allowed here.",
  "empty-argument": "Arguments can't be empty.",
  "line-break": "Arguments can't contain line breaks.",
  "too-many-arguments": "Use at most 32 arguments, counting the executable.",
  "unknown-placeholder": "The only placeholders are {script} and {projectPath}.",
  "bundle-not-found": "No installed app has this bundle ID.",
  "executable-not-found":
    "This isn't a claude executable the command center can run. Choose Detect apps, or enter the full path to the claude file itself.",
};

/**
 * The Codex ban set, written normalised (lower-case alphanumerics only) so no
 * flag spelling appears in source: the approval-and-sandbox bypass, the
 * hook-trust bypass, the "skip every prompt" spellings, the unrestricted
 * sandbox value and the two Phase 4 permission tokens. This is the plugin's
 * own trivial mirror of the launchers package's list (the plugin may not
 * import that package); the service stays authoritative (D-11, T-05.1-15).
 */
const CODEX_BAN_TOKENS: readonly string[] = [
  "dangerouslybypassapprovalsandsandbox",
  "dangerouslybypasshooktrust",
  "yolo",
  "fullauto",
  "approveforme",
  "dangerfullaccess",
  "dangerouslyskippermissions",
  "bypasspermissions",
];

/** The same normalisation the service uses: NFKC, lower-case, alphanumerics only. */
function normaliseForFlagMatch(element: string): string {
  return element
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** `--config`/`--profile` in any spelling and the short `-c`/`-p` forms (the service refuses them outright). */
function isCodexConfigFlag(element: string): boolean {
  if (element.startsWith("--")) {
    const eq = element.indexOf("=");
    const name = (eq === -1 ? element : element.slice(0, eq)).toLowerCase().replace(/_/g, "-");
    return name === "--config" || name === "--profile";
  }
  return /^-[cp]/.test(element);
}

/** Why a Codex argument is refused, or `null` when the trivial check lets it through. */
function codexRefusalKind(element: string): "ban" | "config" | null {
  const normalised = normaliseForFlagMatch(element);
  if (CODEX_BAN_TOKENS.some((token) => normalised.includes(token))) return "ban";
  return isCodexConfigFlag(element) ? "config" : null;
}

/** The refused argument as the owner sees it: a bare value is shown with the flag before it. */
function refusedFlagDisplay(value: string, previous: string | undefined): string {
  const shown =
    !value.startsWith("-") && previous !== undefined && previous.startsWith("-")
      ? `${previous} ${value}`
      : value;
  return shown.length > 80 ? `${shown.slice(0, 77)}...` : shown;
}

/** The Codex refusal sentence (UI-SPEC S4-b) for the argument the owner typed. */
function codexRefusalSentence(value: string, previous: string | undefined): string {
  const flag = refusedFlagDisplay(value, previous);
  return codexRefusalKind(value) === "config"
    ? `${flag} isn't allowed. It can change Codex's own settings, so this app never launches Codex with it.`
    : `${flag} isn't allowed. It turns off Codex's sandbox or approval checks, so this app never launches Codex with it.`;
}

/**
 * The copy for one refusal, given the refused argument's value when known.
 * `forbidden-flag` covers more than the one flag S7 names (the service also
 * refuses `--permission-mode bypassPermissions` and any `--settings`), so
 * the line names what the owner actually typed rather than a flag they did
 * not. A Codex refusal (`options.template` of `codex`) uses the Codex
 * sentence, naming the argument (and the flag before a bare value).
 */
export function refusalCopy(
  reason: TemplateRefusalReason,
  value?: string,
  options: {
    readonly template?: RefusedTemplate | undefined;
    readonly previous?: string | undefined;
  } = {},
): string {
  if (reason === "forbidden-flag" && value !== undefined) {
    if (options.template === "codex") return codexRefusalSentence(value, options.previous);
    const normalised = value.trim().toLowerCase();
    if (normalised.startsWith("--settings")) return "--settings isn't allowed here.";
    if (normalised.includes("permission-mode") || normalised === "bypasspermissions") {
      return "Skipping permission prompts isn't allowed here.";
    }
  }
  return TEMPLATE_REFUSAL_COPY[reason];
}

const EXECUTABLE_NOT_ABSOLUTE = TEMPLATE_REFUSAL_COPY["executable-not-absolute"];

/** The template index of row `row`: a terminal argv counts its executable row, Claude Code args start at 1. */
function templateIndexOf(kind: TemplateEditorKind, row: number): number {
  return kind === "terminal" ? row : row + 1;
}

/** The trivial blur-time check for one row (PR-13); `null` when it passes. */
function checkRow(
  kind: TemplateEditorKind,
  row: number,
  value: string,
  previous?: string,
): string | null {
  if (value.includes("\n") || value.includes("\r")) return TEMPLATE_REFUSAL_COPY["line-break"];
  if (value === "") return TEMPLATE_REFUSAL_COPY["empty-argument"];
  if (kind === "terminal" && row === 0 && !value.startsWith("/")) return EXECUTABLE_NOT_ABSOLUTE;
  // Codex only (D-11): a refused argument is caught here too, before any request.
  if (kind === "codex" && codexRefusalKind(value) !== null) {
    return codexRefusalSentence(value, previous);
  }
  return null;
}

/** Every trivial problem in a template, keyed by template index — what Save launcher refuses on. */
export function checkTemplate(kind: TemplateEditorKind, value: readonly string[]): RowError[] {
  const problems: RowError[] = [];
  value.forEach((element, row) => {
    const problem = checkRow(kind, row, element, value[row - 1]);
    if (problem !== null) problems.push([templateIndexOf(kind, row), problem]);
  });
  return problems;
}

/** How a placeholder reads in the preview (UI-SPEC S7 copy). */
function previewText(element: string, sampleDisplayPath: string): string {
  if (element === "{script}") return "‹launch script›";
  if (element === "{projectPath}") return sampleDisplayPath;
  return element;
}

export interface TemplateEditorProps {
  readonly kind: TemplateEditorKind;
  readonly value: readonly string[];
  readonly onChange: (next: readonly string[]) => void;
  /** Service-reported or save-time problems, keyed by template index. */
  readonly errors: ReadonlyMap<number, string>;
  /** A problem about the template as a whole (a refusal with no index). */
  readonly generalError?: string | null | undefined;
  /** The sample project's home-abbreviated path for `{projectPath}` (RR-24). */
  readonly sampleDisplayPath: string;
  /** The `{Terminal}` the Claude Code caption names. */
  readonly terminalLabel: string;
  /** The Claude Code preview's first line: the chosen executable, when known. */
  readonly executableDisplay?: string | null | undefined;
  /** Disconnected: every control `aria-disabled`, still focusable, nothing changes. */
  readonly disabled?: boolean | undefined;
}

export function TemplateEditor({
  kind,
  value,
  onChange,
  errors,
  generalError = null,
  sampleDisplayPath,
  terminalLabel,
  executableDisplay = null,
  disabled = false,
}: TemplateEditorProps): VNode {
  const baseId = useId();
  const previewHeadingId = useId();
  const capNoteId = useId();
  const [blurErrors, setBlurErrors] = useState<ReadonlyMap<number, string>>(new Map());
  const [pendingFocus, setPendingFocus] = useState<number | null>(null);
  const inputRefs = useRef(new Map<number, HTMLInputElement>());
  const addRef = useRef<HTMLButtonElement | null>(null);
  /** The template this editor last emitted (or was mounted with). */
  const emittedRef = useRef<readonly string[]>(value);

  // Blur errors are keyed by row: a template replaced from outside (a preset
  // switch, Discard changes, a reload) is not the one they were about, so
  // they go with it (wave-6 review). The editor's own edits keep them.
  const valueKey = JSON.stringify(value);
  useEffect(() => {
    if (valueKey === JSON.stringify(emittedRef.current)) return;
    emittedRef.current = value;
    setBlurErrors((previous) => (previous.size === 0 ? previous : new Map()));
  }, [valueKey]);

  function emit(next: readonly string[]): void {
    emittedRef.current = next;
    onChange(next);
  }

  const maxRows = kind === "terminal" ? MAX_TEMPLATE_ARGUMENTS : MAX_TEMPLATE_ARGUMENTS - 1;
  const full = value.length >= maxRows;

  // Focus follows a removal to the next row (or Add argument), and an
  // addition to its new row, once the rows have re-rendered.
  useEffect(() => {
    if (pendingFocus === null) return;
    (inputRefs.current.get(pendingFocus) ?? addRef.current)?.focus();
    setPendingFocus(null);
  }, [pendingFocus]);

  function setRow(row: number, next: string): void {
    if (disabled) return;
    const updated = [...value];
    updated[row] = next;
    const index = templateIndexOf(kind, row);
    if (blurErrors.has(index)) {
      const remaining = new Map(blurErrors);
      remaining.delete(index);
      setBlurErrors(remaining);
    }
    emit(updated);
  }

  function blurRow(row: number): void {
    const problem = checkRow(kind, row, value[row] ?? "", value[row - 1]);
    const index = templateIndexOf(kind, row);
    const next = new Map(blurErrors);
    if (problem === null) next.delete(index);
    else next.set(index, problem);
    setBlurErrors(next);
  }

  function append(element: string): void {
    if (disabled || full) return;
    setPendingFocus(value.length);
    emit([...value, element]);
  }

  function remove(row: number): void {
    if (disabled) return;
    setBlurErrors(new Map());
    setPendingFocus(row);
    emit(value.filter((_, index) => index !== row));
  }

  const legend =
    kind === "terminal"
      ? "Terminal arguments"
      : kind === "codex"
        ? "Codex arguments"
        : "Claude Code arguments";
  const placeholderButton =
    kind === "terminal" ? (
      <button
        type="button"
        className="ccc-list-more"
        aria-disabled={disabled || full ? "true" : undefined}
        aria-describedby={full ? capNoteId : undefined}
        onClick={() => append("{script}")}
      >
        Add {"{script}"} argument
      </button>
    ) : (
      <button
        type="button"
        className="ccc-list-more"
        aria-disabled={disabled || full ? "true" : undefined}
        aria-describedby={full ? capNoteId : undefined}
        onClick={() => append("{projectPath}")}
      >
        Add {"{projectPath}"} argument
      </button>
    );
  const previewItems =
    kind !== "terminal" && executableDisplay !== null ? [executableDisplay, ...value] : value;

  return (
    <div className="ccc-inline-form">
      <fieldset className="ccc-template-rows">
        <legend className="ccc-field-label">{legend}</legend>
        {kind !== "terminal" && value.length === 0 && (
          <p className="ccc-field-help">
            {kind === "codex"
              ? "No extra arguments. Codex starts with its defaults."
              : "No extra arguments. Claude Code starts with its defaults."}
          </p>
        )}
        {value.map((element, row) => {
          const index = templateIndexOf(kind, row);
          const inputId = `${baseId}-row-${row}`;
          const errorId = `${baseId}-error-${row}`;
          const problem = blurErrors.get(index) ?? errors.get(index) ?? null;
          const isExecutable = kind === "terminal" && row === 0;
          return (
            // An argv row IS its position (S7: row order is fixed by position), so the index is its key.
            <div key={row}>
              <div className="ccc-template-row">
                <label className="ccc-field-label" htmlFor={inputId}>
                  {isExecutable ? "Executable" : `Argument ${index}`}
                </label>
                <input
                  id={inputId}
                  ref={(element_) => {
                    if (element_) inputRefs.current.set(row, element_);
                    else inputRefs.current.delete(row);
                  }}
                  type="text"
                  className="ccc-text-input ccc-text-input--mono"
                  spellcheck={false}
                  autocomplete="off"
                  value={element}
                  readOnly={disabled}
                  aria-disabled={disabled ? "true" : undefined}
                  aria-invalid={problem !== null ? "true" : undefined}
                  aria-describedby={problem !== null ? errorId : undefined}
                  onInput={(event) => setRow(row, event.currentTarget.value)}
                  onBlur={() => blurRow(row)}
                />
                {!isExecutable && (
                  <button
                    type="button"
                    className="ccc-list-more"
                    aria-label={`Remove argument ${index}`}
                    aria-disabled={disabled ? "true" : undefined}
                    onClick={() => remove(row)}
                  >
                    Remove argument
                  </button>
                )}
              </div>
              {problem !== null && <FieldError id={errorId} text={problem} />}
            </div>
          );
        })}
        {generalError !== null && <FieldError text={generalError} />}
        <div className="ccc-manage-toolbar">
          <button
            ref={addRef}
            type="button"
            className="ccc-list-more"
            aria-disabled={disabled || full ? "true" : undefined}
            aria-describedby={full ? capNoteId : undefined}
            onClick={() => append("")}
          >
            Add argument
          </button>
          {placeholderButton}
          {full && (
            <span id={capNoteId} className="ccc-visually-hidden">
              Up to 32 arguments
            </span>
          )}
        </div>
      </fieldset>
      <h5 id={previewHeadingId} className="ccc-section-label">
        Preview
      </h5>
      <p className="ccc-field-help">
        Exactly what runs, one argument per line. Nothing is passed through a shell.
      </p>
      <p className="ccc-field-help">
        {kind !== "terminal"
          ? `Runs inside ${terminalLabel}, at the project folder:`
          : "Starts the terminal with:"}
      </p>
      <ol className="ccc-preview-list" aria-labelledby={previewHeadingId}>
        {previewItems.map((element, index) => (
          <li key={index}>{previewText(element, sampleDisplayPath)}</li>
        ))}
      </ol>
    </div>
  );
}
