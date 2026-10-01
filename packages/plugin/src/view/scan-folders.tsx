import type { ProtectedLocation, ScanStateResponse, SuggestionView } from "@ccc/domain";
import type { VNode } from "preact";
import { useRef, useState } from "preact/hooks";
import type { FolderPick, PickFolderOptions } from "../projects/folder-picker.js";
import type { ScanActionOutcome, ScanActions } from "../projects/projects-actions.js";
import { applyScanState } from "../projects/scan-state.js";
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
const ADD_REFUSED =
  "▲ Couldn't add this scan folder. Choose an existing folder outside the managed vault and outside system folders.";
const SERVICE_PROBLEM =
  "▲ Couldn't reach the command center service. Check the service in Settings → Diagnostics, then try again.";

const FOLDERS_PLURAL = new Intl.PluralRules("en");

/** `Found {n} new Git folder(s)` / `No new Git folders found.` (UI-SPEC S5 scan result). */
export function scanResultLine(found: number): string {
  if (found === 0) return "No new Git folders found.";
  return FOLDERS_PLURAL.select(found) === "one"
    ? `Found ${found} new Git folder`
    : `Found ${found} new Git folders`;
}

/** The failure copy for any non-state scan outcome: the service, never the folder, when it was unreachable. */
function failureLine(outcome: Exclude<ScanActionOutcome, { kind: "state" }>): string {
  return outcome.kind === "service-disconnected" || outcome.kind === "failed"
    ? SERVICE_PROBLEM
    : ADD_REFUSED;
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
  const [status, setStatus] = useState("");
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
    setStatus("Scanning…");
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
      setStatus(failureLine(outcome));
      return;
    }
    if (outcome.state.protectedLocation !== undefined) {
      setStatus("");
      setStep({ kind: "protected", path, location: outcome.state.protectedLocation });
      return;
    }
    applyScanState(outcome.state);
    setStep({ kind: "idle" });
    setTypedPath("");
    setStatus("");
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
            setStatus("");
            setStep({ kind: "form", notice: null });
          }}
        >
          Type a path instead
        </button>
      </div>
      <p role="status" className="ccc-state-body">
        {status}
      </p>
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
  readonly now: number;
}

/** The Suggestions and Scan folders sections (UI-SPEC S3 reading order 5 and 6). */
export function ScanFolders({ state, actions }: ScanFoldersProps): VNode {
  const roots = state?.scanRoots ?? [];
  const suggestions = state?.suggestions ?? [];

  async function register(suggestion: SuggestionView): Promise<void> {
    const outcome = await actions.registerSuggestion(suggestion.suggestionId);
    if (outcome.kind === "registered" || outcome.kind === "already-registered") {
      const listed = await actions.listScanState();
      if (listed.kind === "state") applyScanState(listed.state);
    }
  }

  return (
    <div className="ccc-projects-section">
      {roots.length > 0 && (
        <section aria-labelledby="ccc-suggestions-heading">
          <h3 id="ccc-suggestions-heading" className="ccc-state-heading">
            Suggestions
          </h3>
          <ul className="ccc-list">
            {suggestions.map((suggestion) => (
              <li key={suggestion.suggestionId} className="ccc-suggestion-row">
                <div className="ccc-list-primary">
                  <p className="ccc-state-body">{suggestion.folderName}</p>
                  <p className="ccc-mono-label">{suggestion.displayPath}</p>
                </div>
                <button
                  type="button"
                  className="ccc-connect-button"
                  aria-label={`Register ${suggestion.folderName}`}
                  onClick={() => void register(suggestion)}
                >
                  Register
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-labelledby="ccc-scan-folders-heading">
        <h3 id="ccc-scan-folders-heading" className="ccc-state-heading">
          Scan folders
        </h3>
        <ul className="ccc-list">
          {roots.map((root) => (
            <li key={root.scanRootId} className="ccc-scan-folder-row">
              <p className="ccc-mono-label">{root.displayPath}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
