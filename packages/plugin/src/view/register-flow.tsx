import type { ProjectId, ProtectedLocation } from "@ccc/domain";
import { hasControlCharacter } from "@ccc/domain/browser";
import type { Ref, VNode } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { FolderPick, PickFolderOptions } from "../projects/folder-picker.js";
import type { ProjectsActions } from "../projects/projects-actions.js";
import { projectsSnapshot } from "../projects/projects-state.js";

/**
 * The S4 register-a-project flow (Task 2, D-03, D-04, D-29, PR-11).
 *
 * This is the WHOLE interaction, including the `Register a project` trigger
 * itself — `projects-view.tsx` mounts one `RegisterFlow` beside its toolbar
 * and never calls `pickFolder`/`actions.register` directly. `openerRef`
 * forwards to that trigger button's own DOM node, so a sibling flow (Task 3's
 * "remove the last project" focus target) can move focus there without this
 * component needing to know why.
 */
export interface RegisterFlowProps {
  readonly actions: ProjectsActions;
  readonly pickFolder: (options: PickFolderOptions) => Promise<FolderPick>;
  /** A brand-new registration: focus management for the new row is the caller's job (D-11: the row arrives later). */
  readonly onRegistered: (projectId: ProjectId) => void;
  /** An already-registered duplicate: the caller focuses that existing card. */
  readonly onDuplicate: (projectId: ProjectId) => void;
  readonly openerRef?: Ref<HTMLButtonElement> | undefined;
}

type Step =
  | { readonly kind: "idle" }
  | { readonly kind: "form"; readonly notice: string | null }
  | { readonly kind: "protected"; readonly path: string; readonly location: ProtectedLocation };

const DIALOG_TITLE = "Choose a project folder";
const DIALOG_BUTTON_LABEL = "Register folder";
const PICKER_UNAVAILABLE_NOTICE =
  "The folder picker isn't available here. Paste the folder's full path instead.";
const REFUSED_PROBLEM = "▲ Couldn't register this folder.";
const REFUSED_NEXT_STEP =
  "Choose an existing folder outside the managed vault and outside system folders, then try again.";

/**
 * Sentence case, per-location proper nouns (`obsidianmd/ui/sentence-case`,
 * UI-SPEC "Copywriting Contract"): "Documents", "Desktop" and "Downloads" are
 * common words the lint rule's `brands` list deliberately excludes (a bare
 * common word there would license Title Case anywhere), so this lookup table
 * — not free prose — is the one reviewed place they appear capitalised.
 * `cloud-storage` (D-29's `~/Library/CloudStorage`, third-party File Provider
 * drives) has no UI-SPEC precedent; "Cloud storage" matches the sentence-case
 * and generic-noun style of the other four.
 */
const PROTECTED_LOCATION_LABELS: Record<ProtectedLocation, string> = {
  documents: "Documents",
  desktop: "Desktop",
  downloads: "Downloads",
  "icloud-drive": "iCloud Drive",
  "cloud-storage": "Cloud storage",
};

/** The folder's own basename, for the pre-arrival "Registered {name}." announcement (D-04: the service defaults the display name to this). */
function basenameOf(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

/** Client-side pre-check mirroring `AbsolutePathSchema` (D-03); the service re-validates authoritatively. */
function validateTypedPath(value: string): string | null {
  if (!value.startsWith("/")) {
    return "▲ Enter the full path, starting with /.";
  }
  if (hasControlCharacter(value)) {
    return "▲ Paths can't contain line breaks or control characters.";
  }
  return null;
}

export function RegisterFlow({
  actions,
  pickFolder,
  onRegistered,
  onDuplicate,
  openerRef,
}: RegisterFlowProps): VNode {
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [typedPath, setTypedPath] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const openerButtonRef = useRef<HTMLButtonElement | null>(null);
  const typeLinkRef = useRef<HTMLButtonElement | null>(null);
  const protectedHeadingRef = useRef<HTMLHeadingElement | null>(null);

  // Focus moves to the protected-location explanation the moment it appears
  // (S4 step 3) — no other control in this component would otherwise take
  // focus after `actions.register` resolves.
  useEffect(() => {
    if (step.kind === "protected") protectedHeadingRef.current?.focus();
  }, [step.kind]);

  function assignOpenerRef(el: HTMLButtonElement | null): void {
    openerButtonRef.current = el;
    if (openerRef) {
      if (typeof openerRef === "function") openerRef(el);
      else (openerRef as { current: HTMLButtonElement | null }).current = el;
    }
  }

  function resolveOutcome(
    path: string,
    outcome: Awaited<ReturnType<ProjectsActions["register"]>>,
  ): void {
    setBusy(false);
    switch (outcome.kind) {
      case "registered": {
        setStatus(`Registered ${basenameOf(path)}.`);
        setStep({ kind: "idle" });
        setTypedPath("");
        onRegistered(outcome.projectId);
        return;
      }
      case "already-registered": {
        const name =
          projectsSnapshot.value?.projects.find((p) => p.projectId === outcome.projectId)
            ?.displayName ?? basenameOf(path);
        setStatus(`This folder is already registered as ${name}.`);
        setStep({ kind: "idle" });
        setTypedPath("");
        onDuplicate(outcome.projectId);
        return;
      }
      case "protected-location": {
        setStatus("");
        setStep({ kind: "protected", path, location: outcome.location });
        return;
      }
      default: {
        // refused | invalid | service-disconnected | failed — one constant
        // problem+next-step pair, never a message that echoes the path
        // (D-04). The typed value is kept in the input for editing.
        setStatus(`${REFUSED_PROBLEM} ${REFUSED_NEXT_STEP}`);
        return;
      }
    }
  }

  async function attemptRegister(
    path: string,
    acknowledgeProtectedLocation?: boolean,
  ): Promise<void> {
    setTypedPath(path);
    setBusy(true);
    setStatus("Registering…");
    // Passing `undefined` explicitly as a second argument is a different
    // call shape from omitting it entirely (`toHaveBeenCalledWith` sees
    // both) — omit rather than pass `undefined` so the dialog-pick path
    // (no acknowledgement) posts exactly `{ path }`, matching D-04.
    const outcome =
      acknowledgeProtectedLocation === undefined
        ? await actions.register(path)
        : await actions.register(path, acknowledgeProtectedLocation);
    resolveOutcome(path, outcome);
  }

  async function handleTriggerClick(): Promise<void> {
    const pick = await pickFolder({ title: DIALOG_TITLE, buttonLabel: DIALOG_BUTTON_LABEL });
    if (pick.kind === "picked") {
      await attemptRegister(pick.path);
      return;
    }
    if (pick.kind === "unavailable") {
      setValidationError(null);
      setStep({ kind: "form", notice: PICKER_UNAVAILABLE_NOTICE });
      return;
    }
    // cancelled: nothing changes, focus returns to the button that opened it.
    openerButtonRef.current?.focus();
  }

  function openTypedForm(): void {
    setValidationError(null);
    setStatus("");
    setStep({ kind: "form", notice: null });
  }

  function closeForm(focusTarget: "opener" | "type-link"): void {
    setStep({ kind: "idle" });
    setValidationError(null);
    setTypedPath("");
    if (focusTarget === "opener") openerButtonRef.current?.focus();
    else typeLinkRef.current?.focus();
  }

  async function handleFormSubmit(event: Event): Promise<void> {
    event.preventDefault();
    const error = validateTypedPath(typedPath);
    if (error !== null) {
      setValidationError(error);
      return;
    }
    setValidationError(null);
    await attemptRegister(typedPath);
  }

  function handleFormKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    closeForm("opener");
  }

  async function handleProtectedRegister(): Promise<void> {
    if (step.kind !== "protected") return;
    await attemptRegister(step.path, true);
  }

  function handleChooseAnotherFolder(): void {
    if (step.kind !== "protected") return;
    setTypedPath(step.path);
    setValidationError(null);
    setStatus("");
    setStep({ kind: "form", notice: null });
  }

  return (
    <div className="ccc-inline-form">
      <div className="ccc-manage-toolbar">
        <button
          type="button"
          ref={assignOpenerRef}
          className="ccc-connect-button"
          aria-disabled={busy ? "true" : undefined}
          onClick={() => {
            if (busy) return;
            void handleTriggerClick();
          }}
        >
          Register a project
        </button>
        <button type="button" ref={typeLinkRef} className="ccc-list-more" onClick={openTypedForm}>
          Type a path instead
        </button>
      </div>
      <p role="status" className="ccc-state-body">
        {status}
      </p>
      {step.kind === "form" && (
        // biome-ignore lint/a11y/noStaticElementInteractions: the Escape handler is a keyboard-only affordance for this form; it gains no role or tabindex itself.
        <div className="ccc-inline-form" onKeyDown={handleFormKeyDown}>
          {step.notice !== null && <p className="ccc-field-help">{step.notice}</p>}
          <form onSubmit={(event) => void handleFormSubmit(event)}>
            <label className="ccc-field-label" htmlFor="ccc-register-path-input">
              Folder path
            </label>
            <input
              id="ccc-register-path-input"
              type="text"
              className="ccc-text-input ccc-text-input--mono"
              placeholder="/Users/USERNAME/code/example-project"
              value={typedPath}
              aria-invalid={validationError !== null ? "true" : undefined}
              aria-describedby={validationError !== null ? "ccc-register-path-error" : undefined}
              onInput={(event) => setTypedPath((event.target as HTMLInputElement).value)}
            />
            <p className="ccc-field-help">The full path, starting with /.</p>
            {validationError !== null && (
              <p id="ccc-register-path-error" className="ccc-field-error">
                {validationError}
              </p>
            )}
            <div className="ccc-manage-toolbar">
              <button
                type="submit"
                className="ccc-connect-button"
                aria-disabled={busy ? "true" : undefined}
              >
                Register folder
              </button>
              <button type="button" className="ccc-list-more" onClick={() => closeForm("opener")}>
                Cancel registration
              </button>
            </div>
          </form>
        </div>
      )}
      {step.kind === "protected" && (
        // biome-ignore lint/a11y/noStaticElementInteractions: the Escape handler is a keyboard-only affordance for this step; it gains no role or tabindex itself.
        <div className="ccc-inline-form" onKeyDown={handleFormKeyDown}>
          <p className="ccc-state-heading" ref={protectedHeadingRef} tabIndex={-1}>
            {`This folder is in ${PROTECTED_LOCATION_LABELS[step.location]}`}
          </p>
          <p className="ccc-state-body">
            {`macOS protects ${PROTECTED_LOCATION_LABELS[step.location]}. It may block the command ` +
              "center's service from reading this folder, sometimes without asking. If Git status or " +
              `launches for this project stop working, move the project out of ${PROTECTED_LOCATION_LABELS[step.location]}, ` +
              "or allow access in System Settings › Privacy & Security."}
          </p>
          <div className="ccc-manage-toolbar">
            <button
              type="button"
              className="ccc-connect-button"
              aria-disabled={busy ? "true" : undefined}
              onClick={() => void handleProtectedRegister()}
            >
              Register folder
            </button>
            <button type="button" className="ccc-list-more" onClick={handleChooseAnotherFolder}>
              Choose another folder
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
