import { MAX_TEMPLATE_ARGUMENTS, type TemplateRefusalReason } from "@ccc/domain";
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

/** `claude-code` edits `[claude, ...args]`'s args; `terminal` edits a custom terminal's whole argv. */
export type TemplateEditorKind = "claude-code" | "terminal";

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
 * The copy for one refusal, given the refused argument's value when known.
 * `forbidden-flag` covers more than the one flag S7 names (the service also
 * refuses `--permission-mode bypassPermissions` and any `--settings`), so
 * the line names what the owner actually typed rather than a flag they did
 * not.
 */
export function refusalCopy(reason: TemplateRefusalReason, value?: string): string {
  if (reason === "forbidden-flag" && value !== undefined) {
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
function checkRow(kind: TemplateEditorKind, row: number, value: string): string | null {
  if (value.includes("\n") || value.includes("\r")) return TEMPLATE_REFUSAL_COPY["line-break"];
  if (value === "") return TEMPLATE_REFUSAL_COPY["empty-argument"];
  if (kind === "terminal" && row === 0 && !value.startsWith("/")) return EXECUTABLE_NOT_ABSOLUTE;
  return null;
}

/** Every trivial problem in a template, keyed by template index — what Save launcher refuses on. */
export function checkTemplate(kind: TemplateEditorKind, value: readonly string[]): RowError[] {
  const problems: RowError[] = [];
  value.forEach((element, row) => {
    const problem = checkRow(kind, row, element);
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
    onChange(updated);
  }

  function blurRow(row: number): void {
    const problem = checkRow(kind, row, value[row] ?? "");
    const index = templateIndexOf(kind, row);
    const next = new Map(blurErrors);
    if (problem === null) next.delete(index);
    else next.set(index, problem);
    setBlurErrors(next);
  }

  function append(element: string): void {
    if (disabled || full) return;
    setPendingFocus(value.length);
    onChange([...value, element]);
  }

  function remove(row: number): void {
    if (disabled) return;
    setBlurErrors(new Map());
    setPendingFocus(row);
    onChange(value.filter((_, index) => index !== row));
  }

  const legend = kind === "terminal" ? "Terminal arguments" : "Claude Code arguments";
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
    kind === "claude-code" && executableDisplay !== null ? [executableDisplay, ...value] : value;

  return (
    <div className="ccc-inline-form">
      <fieldset className="ccc-template-rows">
        <legend className="ccc-field-label">{legend}</legend>
        {kind === "claude-code" && value.length === 0 && (
          <p className="ccc-field-help">
            No extra arguments. Claude Code starts with its defaults.
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
      <h5 id={previewHeadingId} className="ccc-field-label">
        Preview
      </h5>
      <p className="ccc-field-help">
        Exactly what runs, one argument per line. Nothing is passed through a shell.
      </p>
      <p className="ccc-field-help">
        {kind === "claude-code"
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
