import type {
  ProtectedLocation,
  ScanRootView,
  ScanStateResponse,
  SuggestionView,
} from "@ccc/domain";
import type { VNode } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { FolderPick, PickFolderOptions } from "../projects/folder-picker.js";
import type { ScanActionOutcome, ScanActions } from "../projects/projects-actions.js";
import { applyScanState, scanState } from "../projects/scan-state.js";
import { formatRelativeTime } from "../widgets/relative-time.js";
import { PROTECTED_LOCATION_LABELS, validateTypedPath } from "./register-flow.js";

/**
 * S5 — scan folders and suggestions (plan 04-13, PROJ-02, PROJ-03, D-07,
 * D-36). Everything here reflects scan route responses held in the
 * memory-only `scanState` signal; nothing is persisted plugin-side (D-43).
 */

const PICKER_TITLE = "Choose a folder to scan";
const PICKER_BUTTON_LABEL = "Add scan folder";
const PICKER_UNAVAILABLE_NOTICE =
  "The folder picker isn't available here. Paste the folder's full path instead.";
/** A problem line and its next step; rendered with an `aria-hidden` ▲ before the problem (Accessibility Floor 3). */
interface Problem {
  readonly problem: string;
  readonly nextStep: string;
}

const ADD_REFUSED: Problem = {
  problem: "Couldn't add this scan folder.",
  nextStep: "Choose an existing folder outside the managed vault and outside system folders.",
};
const SERVICE_PROBLEM: Problem = {
  problem: "Couldn't reach the command center service.",
  nextStep: "Check the service in Settings → Diagnostics, then try again.",
};
const MANAGEMENT_FAILURE: Problem = {
  problem: "Couldn't save that change.",
  nextStep: "Check the service in Settings → Diagnostics, then try again.",
};
const REGISTER_REFUSED: Problem = {
  problem: "Couldn't register this folder.",
  nextStep:
    "Choose an existing folder outside the managed vault and outside system folders, then try again.",
};
const SCAN_FAILED: Problem = {
  problem: "Couldn't scan this folder.",
  nextStep: "Check that it still exists, then choose Rescan folder.",
};
/** PR-11's `folder-access-denied` lines, with "this folder" (UI-SPEC S5 scan failure). */
const SCAN_ACCESS_DENIED: Problem = {
  problem: "macOS blocked access to this folder.",
  nextStep:
    "Move the folder out of Documents, Desktop, Downloads or iCloud Drive, or allow access in System Settings › Privacy & Security, then choose Rescan folder. Updating Node.js can make macOS block it again.",
};

/** The two lines of a problem, the glyph hidden from assistive technology with its text beside it. */
function ProblemLines({ problem }: { readonly problem: Problem }): VNode {
  return (
    <>
      <p className="ccc-state-body">
        <span aria-hidden="true">▲</span> <span>{problem.problem}</span>
      </p>
      <p className="ccc-state-body">{problem.nextStep}</p>
    </>
  );
}

const FOLDERS_PLURAL = new Intl.PluralRules("en");

/** `Found {n} new Git folder(s)` / `No new Git folders found.` (UI-SPEC S5 scan result). */
export function scanResultLine(found: number): string {
  if (found === 0) return "No new Git folders found.";
  return FOLDERS_PLURAL.select(found) === "one"
    ? `Found ${found} new Git folder`
    : `Found ${found} new Git folders`;
}

/** The failure copy for any non-state add outcome: the service, never the folder, when it was unreachable. */
function addFailure(outcome: Exclude<ScanActionOutcome, { kind: "state" }>): Problem {
  return outcome.kind === "service-disconnected" || outcome.kind === "failed"
    ? SERVICE_PROBLEM
    : ADD_REFUSED;
}

/** What a flow's persistent status region shows: nothing, plain text, or a problem. */
type StatusLine =
  | { readonly kind: "none" }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "problem"; readonly problem: Problem };

const NO_STATUS: StatusLine = { kind: "none" };

/** The persistent `role="status"` region (Accessibility Floor 2): always mounted, its content changes. */
function StatusRegion({ line }: { readonly line: StatusLine }): VNode {
  return (
    <div role="status">
      {line.kind === "text" && <p className="ccc-state-body">{line.text}</p>}
      {line.kind === "problem" && <ProblemLines problem={line.problem} />}
    </div>
  );
}

export interface AddScanFolderFlowProps {
  readonly actions: ScanActions;
  readonly pickFolder: (options: PickFolderOptions) => Promise<FolderPick>;
}

type AddStep =
  | { readonly kind: "idle" }
  | { readonly kind: "form"; readonly notice: string | null }
  | { readonly kind: "protected"; readonly path: string; readonly location: ProtectedLocation };

/**
 * `Add a scan folder`: the same picker/typed-path pair as S4's register
 * flow, with the S5 titles. The chosen path goes to the service once, in the
 * add request, and is never shown in any message (D-43).
 */
export function AddScanFolderFlow({ actions, pickFolder }: AddScanFolderFlowProps): VNode {
  const [step, setStep] = useState<AddStep>({ kind: "idle" });
  const [typedPath, setTypedPath] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusLine>(NO_STATUS);
  const [busy, setBusyState] = useState(false);
  const busyRef = useRef(false);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  function setBusy(value: boolean): void {
    busyRef.current = value;
    setBusyState(value);
  }

  async function attemptAdd(path: string, acknowledge?: boolean): Promise<void> {
    setTypedPath(path);
    setBusy(true);
    setStatus({ kind: "text", text: "Scanning…" });
    let outcome: ScanActionOutcome;
    try {
      outcome =
        acknowledge === undefined
          ? await actions.addScanRoot(path)
          : await actions.addScanRoot(path, acknowledge);
    } catch {
      outcome = { kind: "failed" };
    }
    setBusy(false);
    if (outcome.kind !== "state") {
      setStatus({ kind: "problem", problem: addFailure(outcome) });
      return;
    }
    if (outcome.state.protectedLocation !== undefined) {
      setStatus(NO_STATUS);
      setStep({ kind: "protected", path, location: outcome.state.protectedLocation });
      return;
    }
    applyScanState(outcome.state);
    setStep({ kind: "idle" });
    setTypedPath("");
    setStatus(NO_STATUS);
  }

  async function handleTriggerClick(): Promise<void> {
    if (busyRef.current) return;
    setBusy(true);
    let pick: FolderPick;
    try {
      pick = await pickFolder({ title: PICKER_TITLE, buttonLabel: PICKER_BUTTON_LABEL });
    } catch {
      pick = { kind: "unavailable" };
    }
    if (pick.kind === "picked") {
      await attemptAdd(pick.path);
      return;
    }
    setBusy(false);
    if (pick.kind === "unavailable") {
      setValidationError(null);
      setStep({ kind: "form", notice: PICKER_UNAVAILABLE_NOTICE });
      return;
    }
    openerRef.current?.focus();
  }

  function closeForm(): void {
    setStep({ kind: "idle" });
    setValidationError(null);
    setTypedPath("");
    openerRef.current?.focus();
  }

  async function handleSubmit(event: Event): Promise<void> {
    event.preventDefault();
    if (busyRef.current) return;
    const error = validateTypedPath(typedPath);
    if (error !== null) {
      setValidationError(error);
      return;
    }
    setValidationError(null);
    await attemptAdd(typedPath);
  }

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    closeForm();
  }

  return (
    <div className="ccc-inline-form">
      <div className="ccc-manage-toolbar">
        <button
          type="button"
          ref={openerRef}
          className="ccc-connect-button"
          aria-disabled={busy ? "true" : undefined}
          onClick={() => void handleTriggerClick()}
        >
          Add a scan folder
        </button>
        <button
          type="button"
          className="ccc-list-more"
          aria-label="Type a path instead for a scan folder"
          onClick={() => {
            setValidationError(null);
            setStatus(NO_STATUS);
            setStep({ kind: "form", notice: null });
          }}
        >
          Type a path instead
        </button>
      </div>
      <StatusRegion line={status} />
      {step.kind === "form" && (
        // biome-ignore lint/a11y/noStaticElementInteractions: the Escape handler is a keyboard-only affordance for this form; it gains no role or tabindex itself.
        <div className="ccc-inline-form" onKeyDown={handleKeyDown}>
          {step.notice !== null && <p className="ccc-field-help">{step.notice}</p>}
          <form onSubmit={(event) => void handleSubmit(event)}>
            <label className="ccc-field-label" htmlFor="ccc-scan-path-input">
              Folder path
            </label>
            <input
              id="ccc-scan-path-input"
              type="text"
              className="ccc-text-input ccc-text-input--mono"
              placeholder="/Users/USERNAME/code"
              value={typedPath}
              aria-invalid={validationError !== null ? "true" : undefined}
              aria-describedby={validationError !== null ? "ccc-scan-path-error" : undefined}
              onInput={(event) => setTypedPath((event.target as HTMLInputElement).value)}
            />
            <p className="ccc-field-help">The full path, starting with /.</p>
            {validationError !== null && (
              <p id="ccc-scan-path-error" className="ccc-field-error">
                {validationError}
              </p>
            )}
            <div className="ccc-manage-toolbar">
              <button
                type="submit"
                className="ccc-connect-button"
                aria-disabled={busy ? "true" : undefined}
              >
                Add scan folder
              </button>
              <button type="button" className="ccc-list-more" onClick={closeForm}>
                Cancel scan folder
              </button>
            </div>
          </form>
        </div>
      )}
      {step.kind === "protected" && (
        // biome-ignore lint/a11y/noStaticElementInteractions: the Escape handler is a keyboard-only affordance for this step; it gains no role or tabindex itself.
        <div className="ccc-inline-form" onKeyDown={handleKeyDown}>
          <p className="ccc-state-heading">
            {`This folder is in ${PROTECTED_LOCATION_LABELS[step.location]}`}
          </p>
          <p className="ccc-state-body">
            {`macOS protects ${PROTECTED_LOCATION_LABELS[step.location]}. It may block the command ` +
              "center's service from reading this folder, sometimes without asking. If scanning " +
              `stops working, move the folder out of ${PROTECTED_LOCATION_LABELS[step.location]}, ` +
              "or allow access in System Settings › Privacy & Security."}
          </p>
          <div className="ccc-manage-toolbar">
            <button
              type="button"
              className="ccc-connect-button"
              aria-disabled={busy ? "true" : undefined}
              onClick={() => {
                if (step.kind === "protected" && !busyRef.current) {
                  void attemptAdd(step.path, true);
                }
              }}
            >
              Add scan folder
            </button>
            <button
              type="button"
              className="ccc-list-more"
              onClick={() => setStep({ kind: "form", notice: null })}
            >
              Choose another folder
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export interface ScanFoldersProps {
  readonly state: ScanStateResponse | undefined;
  readonly actions: ScanActions;
  /** The render clock (ms), so "Scanned {relative time}" is a pure function of props. */
  readonly now: number;
}

/** Suggestions shown per scan folder before `Show {n} more` (RR-18). */
export const SUGGESTIONS_PAGE = 25;

/** `{n} folder` / `{n} folders` (UI-SPEC S5 suggestions heading meta). */
function folderCount(n: number): string {
  return FOLDERS_PLURAL.select(n) === "one" ? `${n} folder` : `${n} folders`;
}

/** The scan state the service last reported, or the rendered one before any response. */
function currentState(fallback: ScanStateResponse | undefined): ScanStateResponse | undefined {
  return scanState.value ?? fallback;
}

/**
 * The Suggestions and Scan folders sections (UI-SPEC S3 reading order 5 and
 * 6, S5). Suggestions render only while at least one scan folder exists.
 */
export function ScanFolders({ state, actions, now }: ScanFoldersProps): VNode {
  const roots = state?.scanRoots ?? [];
  const suggestions = state?.suggestions ?? [];
  const [dismissedAny, setDismissedAny] = useState(false);
  const [announcement, setAnnouncement] = useState<StatusLine>(NO_STATUS);
  const [shownByRoot, setShownByRoot] = useState<Readonly<Record<string, number>>>({});

  async function register(suggestion: SuggestionView): Promise<void> {
    const outcome = await actions.registerSuggestion(suggestion.suggestionId);
    switch (outcome.kind) {
      case "registered":
        setAnnouncement({ kind: "text", text: `Registered ${suggestion.folderName}.` });
        break;
      case "already-registered":
        setAnnouncement({
          kind: "text",
          text: `This folder is already registered as ${suggestion.folderName}.`,
        });
        break;
      case "refused":
      case "invalid":
        setAnnouncement({ kind: "problem", problem: REGISTER_REFUSED });
        return;
      default:
        setAnnouncement({ kind: "problem", problem: SERVICE_PROBLEM });
        return;
    }
    // The registered folder leaves the suggestions; the service is the source.
    const listed = await actions.listScanState();
    if (listed.kind === "state") applyScanState(listed.state);
  }

  async function dismiss(suggestion: SuggestionView): Promise<void> {
    const outcome = await actions.dismissSuggestion(suggestion.suggestionId);
    if (outcome.kind !== "ok") {
      setAnnouncement({ kind: "problem", problem: MANAGEMENT_FAILURE });
      return;
    }
    const latest = currentState(state);
    if (latest !== undefined) {
      applyScanState({
        ...latest,
        suggestions: latest.suggestions.filter((s) => s.suggestionId !== suggestion.suggestionId),
      });
    }
    setDismissedAny(true);
  }

  return (
    <>
      {roots.length > 0 && (
        <section className="ccc-projects-section" aria-labelledby="ccc-suggestions-heading">
          <h3 id="ccc-suggestions-heading" className="ccc-state-heading">
            Suggestions
          </h3>
          {suggestions.length > 0 && (
            <p className="ccc-list-meta">{folderCount(suggestions.length)}</p>
          )}
          <StatusRegion line={announcement} />
          {suggestions.length === 0 ? (
            <div>
              <p className="ccc-state-heading">No suggestions.</p>
              <p className="ccc-state-body">
                Every Git folder found is already registered, or none were found.
              </p>
            </div>
          ) : (
            roots.map((root) => {
              const group = suggestions.filter((s) => s.scanRootId === root.scanRootId);
              if (group.length === 0) return null;
              const shown = shownByRoot[root.scanRootId] ?? SUGGESTIONS_PAGE;
              const remaining = group.length - shown;
              const headingId = `ccc-suggestions-${root.scanRootId}`;
              return (
                // biome-ignore lint/a11y/useSemanticElements: a fieldset implies form controls and brings browser chrome; this is a labelled group of rows.
                <div key={root.scanRootId} role="group" aria-labelledby={headingId}>
                  <h4 id={headingId} className="ccc-mono-label ccc-display-path">
                    {root.displayPath}
                  </h4>
                  <ul className="ccc-list">
                    {group.slice(0, shown).map((suggestion) => (
                      <li key={suggestion.suggestionId} className="ccc-suggestion-row">
                        <div className="ccc-list-primary">
                          <p className="ccc-list-primary">{suggestion.folderName}</p>
                          <p className="ccc-mono-label ccc-display-path">
                            {suggestion.displayPath}
                          </p>
                        </div>
                        <button
                          type="button"
                          className="ccc-connect-button"
                          aria-label={`Register ${suggestion.folderName}`}
                          onClick={() => void register(suggestion)}
                        >
                          Register
                        </button>
                        <button
                          type="button"
                          className="ccc-list-more"
                          aria-label={`Dismiss ${suggestion.folderName}`}
                          onClick={() => void dismiss(suggestion)}
                        >
                          Dismiss
                        </button>
                      </li>
                    ))}
                  </ul>
                  {remaining > 0 && (
                    <button
                      type="button"
                      className="ccc-list-more"
                      onClick={() =>
                        setShownByRoot({
                          ...shownByRoot,
                          [root.scanRootId]: shown + SUGGESTIONS_PAGE,
                        })
                      }
                    >
                      {`Show ${Math.min(remaining, SUGGESTIONS_PAGE)} more`}
                    </button>
                  )}
                </div>
              );
            })
          )}
          {dismissedAny && (
            <p className="ccc-list-meta">Dismissed suggestions come back after the next rescan.</p>
          )}
        </section>
      )}
      <section className="ccc-projects-section" aria-labelledby="ccc-scan-folders-heading">
        <h3 id="ccc-scan-folders-heading" className="ccc-state-heading">
          Scan folders
        </h3>
        {roots.length === 0 ? (
          <div>
            <p className="ccc-state-heading">No scan folders yet.</p>
            <p className="ccc-state-body">
              Add a parent folder to find the Git projects inside it. Only folders you add here are
              ever scanned.
            </p>
          </div>
        ) : (
          <ul className="ccc-list">
            {roots.map((root) => (
              <ScanFolderRow key={root.scanRootId} root={root} actions={actions} now={now} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

type RowStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "scanning" }
  | { readonly kind: "result"; readonly found: number }
  | { readonly kind: "problem"; readonly problem: Problem };

interface ScanFolderRowProps {
  readonly root: ScanRootView;
  readonly actions: ScanActions;
  readonly now: number;
}

/**
 * One scan folder: its display path, last scan, depth, `Rescan folder` and
 * `Stop scanning` with the inline confirmation. Each row owns its own
 * in-flight state, so scanning one folder never blocks another (S5 loading).
 */
function ScanFolderRow({ root, actions, now }: ScanFolderRowProps): VNode {
  const [status, setStatus] = useState<RowStatus>({ kind: "idle" });
  const [confirming, setConfirming] = useState(false);
  const [returnFocus, setReturnFocus] = useState(false);
  const busyRef = useRef(false);
  const stopRef = useRef<HTMLButtonElement | null>(null);
  const keepRef = useRef<HTMLButtonElement | null>(null);
  const depthId = `ccc-scan-depth-${root.scanRootId}`;

  useEffect(() => {
    if (confirming) keepRef.current?.focus();
    else if (returnFocus) {
      stopRef.current?.focus();
      setReturnFocus(false);
    }
  }, [confirming, returnFocus]);

  async function rescan(depth?: number): Promise<void> {
    if (busyRef.current) return;
    busyRef.current = true;
    // Written before the first await, so it shows in the same render (D-40).
    setStatus({ kind: "scanning" });
    let outcome: ScanActionOutcome;
    try {
      outcome =
        depth === undefined
          ? await actions.rescan(root.scanRootId)
          : await actions.rescan(root.scanRootId, depth);
    } catch {
      outcome = { kind: "failed" };
    }
    busyRef.current = false;
    if (outcome.kind !== "state") {
      setStatus({ kind: "problem", problem: SERVICE_PROBLEM });
      return;
    }
    applyScanState(outcome.state);
    setStatus({
      kind: "result",
      found: outcome.state.suggestions.filter((s) => s.scanRootId === root.scanRootId).length,
    });
  }

  function keep(): void {
    setConfirming(false);
    setReturnFocus(true);
  }

  async function remove(): Promise<void> {
    const outcome = await actions.removeScanRoot(root.scanRootId);
    if (outcome.kind === "state") {
      applyScanState(outcome.state);
      return;
    }
    setConfirming(false);
    setStatus({ kind: "problem", problem: MANAGEMENT_FAILURE });
  }

  const scanProblem =
    root.scanStatus === "failed"
      ? SCAN_FAILED
      : root.scanStatus === "access-denied"
        ? SCAN_ACCESS_DENIED
        : null;
  const scanning = status.kind === "scanning";

  return (
    <li className="ccc-scan-folder-row">
      <div className="ccc-list-primary">
        <p className="ccc-mono-label ccc-display-path">{root.displayPath}</p>
        <p className="ccc-list-meta">
          {root.lastScannedAt === null
            ? "Not scanned yet"
            : `Scanned ${formatRelativeTime(root.lastScannedAt, now)}`}
        </p>
        {!scanning && scanProblem !== null && <ProblemLines problem={scanProblem} />}
        <div role="status">
          {scanning && <p className="ccc-state-body">Scanning…</p>}
          {status.kind === "result" && scanProblem === null && (
            <p className="ccc-state-body">{scanResultLine(status.found)}</p>
          )}
          {status.kind === "problem" && <ProblemLines problem={status.problem} />}
        </div>
        <label className="ccc-field-label" htmlFor={depthId}>
          Look this many levels deep
        </label>
        <select
          id={depthId}
          className="ccc-text-input"
          value={String(root.depth)}
          aria-disabled={scanning ? "true" : undefined}
          onChange={(event) => {
            const depth = Number((event.target as HTMLSelectElement).value);
            void rescan(depth);
          }}
        >
          <option value="1">1 level (default)</option>
          <option value="2">2 levels</option>
          <option value="3">3 levels</option>
        </select>
      </div>
      {confirming ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: the Escape handler is a keyboard-only affordance for this inline confirmation; it gains no role or tabindex itself.
        <div
          className="ccc-inline-form"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            keep();
          }}
        >
          <p className="ccc-state-body">
            Stop scanning this folder? Projects already registered from it stay registered.
          </p>
          <div className="ccc-manage-toolbar">
            <button type="button" className="ccc-button-danger" onClick={() => void remove()}>
              Remove scan folder
            </button>
            <button type="button" ref={keepRef} className="ccc-list-more" onClick={keep}>
              Keep scan folder
            </button>
          </div>
        </div>
      ) : (
        <div className="ccc-manage-toolbar">
          <button
            type="button"
            className="ccc-list-more"
            aria-disabled={scanning ? "true" : undefined}
            onClick={() => void rescan()}
          >
            Rescan folder
          </button>
          <button
            type="button"
            ref={stopRef}
            className="ccc-list-more"
            onClick={() => setConfirming(true)}
          >
            Stop scanning
          </button>
        </div>
      )}
    </li>
  );
}
