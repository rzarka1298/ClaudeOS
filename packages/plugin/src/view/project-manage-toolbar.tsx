import type { ProjectId } from "@ccc/domain";
import { GithubLinkSchema, hasControlCharacter } from "@ccc/domain/browser";
import type { VNode } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ProjectsActions } from "../projects/projects-actions.js";
import type { ProjectRow } from "../widgets/panels.js";
import { nextToolbarIndex } from "../widgets/toolbar-keys.js";

/**
 * The S3 manage toolbar: Pin/Unpin, Rename, Set/Edit GitHub link, Remove from
 * projects (D-08, D-36, PROJ-15, RR-01, RR-11, RR-12). One `role="toolbar"`
 * tab stop with roving tabindex driven by {@link nextToolbarIndex} — the same
 * pure helper the S2 launch toolbar (plan 04-10) reuses, so the two never
 * diverge on wrap/Home/End behavior.
 *
 * `onStatus` carries every announcement and failure message this toolbar
 * produces up to the card's own `role="status"` region (Accessibility Floor
 * 2: one persistent live region per card, not a second one forked here).
 */
export interface ProjectManageToolbarProps {
  readonly row: Pick<ProjectRow, "id" | "name" | "pinned" | "github">;
  readonly actions: ProjectsActions;
  /**
   * Called after a successful removal with the project's id and name. The
   * caller owns both the focus move and the "Removed {project} from
   * projects." announcement: this toolbar's card unmounts with its row, so a
   * message sent to the card's own status region would vanish unheard.
   */
  readonly onRemoved: (projectId: string, projectName: string) => void;
  readonly onStatus: (message: string) => void;
}

type Mode =
  | { readonly kind: "buttons" }
  | { readonly kind: "renaming" }
  | { readonly kind: "github-link" }
  | { readonly kind: "remove-confirm" };

const NAME_ERROR = "▲ Enter a name between 1 and 64 characters.";
const GITHUB_LINK_ERROR = "▲ Enter a GitHub link like https://github.com/owner/repo.";
const SAVE_FAILED =
  "▲ Couldn't save that change. Check the service in Settings → Diagnostics, then try again.";

function validateName(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 64 || hasControlCharacter(trimmed)) {
    return NAME_ERROR;
  }
  return null;
}

function validateGithubLink(value: string): string | null {
  return GithubLinkSchema.safeParse(value).success ? null : GITHUB_LINK_ERROR;
}

export function ProjectManageToolbar({
  row,
  actions,
  onRemoved,
  onStatus,
}: ProjectManageToolbarProps): VNode {
  // `ProjectRow.id` is deliberately a plain `string` (panels.tsx: `ListBody`'s
  // generic `keyOf` has no reason to know about the brand); every service
  // action needs the real `ProjectId`, so it is re-branded once here rather
  // than at each call site.
  const projectId = row.id as ProjectId;
  const [mode, setMode] = useState<Mode>({ kind: "buttons" });
  const [focusedIndex, setFocusedIndex] = useState(0);
  // Set whenever a form closes back to "buttons": the DOM node to focus
  // does not exist until AFTER this render commits, so the actual `.focus()`
  // call lives in the effect below, keyed on `mode.kind` returning to
  // "buttons" — calling `.focus()` synchronously inside the same handler
  // that flips `mode` would read a stale (pre-unmount) ref.
  const [returnFocusIndex, setReturnFocusIndex] = useState<number | null>(null);
  const [nameDraft, setNameDraft] = useState(row.name);
  const [nameError, setNameError] = useState<string | null>(null);
  // Only an owner-set override is editable or clearable here: a link derived
  // from the git remote is not stored as an override, so "Edit" would
  // pre-fill a value the owner never set and "Clear" would send a no-op
  // `null` while announcing that something was cleared (RR-12).
  const overrideLabel =
    row.github.kind === "github" && row.github.source === "override" ? row.github.label : null;
  const [linkDraft, setLinkDraft] = useState(
    overrideLabel === null ? "" : `https://${overrideLabel}`,
  );
  const [linkError, setLinkError] = useState<string | null>(null);

  const pinButtonRef = useRef<HTMLButtonElement | null>(null);
  const renameButtonRef = useRef<HTMLButtonElement | null>(null);
  const githubButtonRef = useRef<HTMLButtonElement | null>(null);
  const removeButtonRef = useRef<HTMLButtonElement | null>(null);
  const keepButtonRef = useRef<HTMLButtonElement | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const linkInputRef = useRef<HTMLInputElement | null>(null);
  const buttonRefs = [pinButtonRef, renameButtonRef, githubButtonRef, removeButtonRef];
  // Set when Pin/Unpin is pressed while it holds focus. The registry delta
  // that follows re-sorts the grid (pinned first), and moving the focused
  // card's DOM subtree drops focus to the body even though keyed
  // reconciliation keeps the same nodes (UI-SPEC S2: "This also applies to
  // pin and unpin in S3"). The layout effect below puts it back.
  const restorePinFocusRef = useRef(false);

  // Runs after the commit that carries the new `pinned` value — the same
  // commit that reorders the cards — so focus is back on the same control
  // before the browser paints. Focus that the owner has already moved
  // somewhere else is never taken back.
  useLayoutEffect(() => {
    if (!restorePinFocusRef.current) return;
    restorePinFocusRef.current = false;
    const button = pinButtonRef.current;
    if (button === null) return;
    const active = button.ownerDocument.activeElement;
    if (active === button) return;
    if (active === null || active === button.ownerDocument.body) {
      button.focus();
      setFocusedIndex(0);
    }
  }, [row.pinned]);

  // Each inline form takes focus the moment it opens — none of these
  // transitions is reachable except by activating the button that opens it,
  // so there is always a next control to move keyboard focus to.
  useEffect(() => {
    if (mode.kind === "renaming") nameInputRef.current?.focus();
    else if (mode.kind === "github-link") linkInputRef.current?.focus();
    else if (mode.kind === "remove-confirm") keepButtonRef.current?.focus();
    else if (mode.kind === "buttons" && returnFocusIndex !== null) {
      buttonRefs[returnFocusIndex]?.current?.focus();
      setFocusedIndex(returnFocusIndex);
      setReturnFocusIndex(null);
    }
    // `buttonRefs` is rebuilt fresh each render from stable ref containers, not reactive state.
  }, [mode.kind, returnFocusIndex]);

  function handleToolbarKeyDown(event: KeyboardEvent): void {
    const next = nextToolbarIndex(focusedIndex, event.key, buttonRefs.length);
    if (next === focusedIndex) return;
    event.preventDefault();
    setFocusedIndex(next);
    buttonRefs[next]?.current?.focus();
  }

  async function handleTogglePin(): Promise<void> {
    const wasPinned = row.pinned;
    const button = pinButtonRef.current;
    // Armed BEFORE the request: the registry delta can land before the pin
    // response does.
    restorePinFocusRef.current = button !== null && button.ownerDocument.activeElement === button;
    const outcome = await actions.pin(projectId, !wasPinned);
    if (outcome.kind !== "ok") {
      restorePinFocusRef.current = false;
      onStatus(SAVE_FAILED);
      return;
    }
    onStatus(wasPinned ? "Unpinned." : "Pinned.");
  }

  function openRename(): void {
    setNameDraft(row.name);
    setNameError(null);
    setMode({ kind: "renaming" });
  }

  function closeRename(focusTarget: "rename-button"): void {
    setMode({ kind: "buttons" });
    setNameError(null);
    if (focusTarget === "rename-button") setReturnFocusIndex(1);
  }

  async function handleRenameSubmit(event: Event): Promise<void> {
    event.preventDefault();
    const error = validateName(nameDraft);
    if (error !== null) {
      setNameError(error);
      return;
    }
    const outcome = await actions.rename(projectId, nameDraft.trim());
    if (outcome.kind !== "ok") {
      onStatus(SAVE_FAILED);
      return;
    }
    onStatus(`Renamed to ${nameDraft.trim()}.`);
    closeRename("rename-button");
  }

  function handleRenameKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    closeRename("rename-button");
  }

  function openGithubLink(): void {
    setLinkDraft(overrideLabel === null ? "" : `https://${overrideLabel}`);
    setLinkError(null);
    setMode({ kind: "github-link" });
  }

  function closeGithubLink(): void {
    setMode({ kind: "buttons" });
    setLinkError(null);
    setReturnFocusIndex(2);
  }

  async function saveGithubLink(url: string | null): Promise<void> {
    const outcome = await actions.setGithubLink(projectId, url);
    if (outcome.kind !== "ok") {
      onStatus(SAVE_FAILED);
      return;
    }
    onStatus(url === null ? "GitHub link cleared." : "GitHub link saved.");
    closeGithubLink();
  }

  async function handleGithubLinkSubmit(event: Event): Promise<void> {
    event.preventDefault();
    const error = validateGithubLink(linkDraft.trim());
    if (error !== null) {
      setLinkError(error);
      return;
    }
    await saveGithubLink(linkDraft.trim());
  }

  function handleGithubLinkKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    closeGithubLink();
  }

  function openRemoveConfirm(): void {
    setMode({ kind: "remove-confirm" });
  }

  function keepProject(): void {
    setMode({ kind: "buttons" });
    setReturnFocusIndex(3);
  }

  async function handleRemoveConfirmed(): Promise<void> {
    const outcome = await actions.remove(projectId);
    if (outcome.kind !== "ok") {
      onStatus(SAVE_FAILED);
      return;
    }
    onRemoved(projectId, row.name);
  }

  function handleRemoveConfirmKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    keepProject();
  }

  if (mode.kind === "renaming") {
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: the Escape handler is a keyboard-only affordance for this inline form; it gains no role or tabindex itself.
      <div className="ccc-inline-form" onKeyDown={handleRenameKeyDown}>
        <form onSubmit={(event) => void handleRenameSubmit(event)}>
          <label className="ccc-field-label" htmlFor={`ccc-rename-input-${row.id}`}>
            Project name
          </label>
          <input
            id={`ccc-rename-input-${row.id}`}
            ref={nameInputRef}
            type="text"
            className="ccc-text-input"
            value={nameDraft}
            aria-invalid={nameError !== null ? "true" : undefined}
            aria-describedby={nameError !== null ? `ccc-rename-error-${row.id}` : undefined}
            onInput={(event) => setNameDraft((event.target as HTMLInputElement).value)}
          />
          {nameError !== null && (
            <p id={`ccc-rename-error-${row.id}`} className="ccc-field-error">
              {nameError}
            </p>
          )}
          <div className="ccc-manage-toolbar">
            <button type="submit" className="ccc-connect-button">
              Save name
            </button>
            <button
              type="button"
              className="ccc-list-more"
              onClick={() => closeRename("rename-button")}
            >
              Keep current name
            </button>
          </div>
        </form>
      </div>
    );
  }

  if (mode.kind === "github-link") {
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: the Escape handler is a keyboard-only affordance for this inline form; it gains no role or tabindex itself.
      <div className="ccc-inline-form" onKeyDown={handleGithubLinkKeyDown}>
        <form onSubmit={(event) => void handleGithubLinkSubmit(event)}>
          <label className="ccc-field-label" htmlFor={`ccc-github-link-input-${row.id}`}>
            GitHub link
          </label>
          <input
            id={`ccc-github-link-input-${row.id}`}
            ref={linkInputRef}
            type="text"
            className="ccc-text-input ccc-text-input--mono"
            placeholder="https://github.com/owner/repo"
            value={linkDraft}
            aria-invalid={linkError !== null ? "true" : undefined}
            aria-describedby={linkError !== null ? `ccc-github-link-error-${row.id}` : undefined}
            onInput={(event) => setLinkDraft((event.target as HTMLInputElement).value)}
          />
          {linkError !== null && (
            <p id={`ccc-github-link-error-${row.id}`} className="ccc-field-error">
              {linkError}
            </p>
          )}
          <div className="ccc-manage-toolbar">
            <button type="submit" className="ccc-connect-button">
              Save GitHub link
            </button>
            <button type="button" className="ccc-list-more" onClick={closeGithubLink}>
              Discard link changes
            </button>
            {overrideLabel !== null && (
              <button
                type="button"
                className="ccc-list-more"
                onClick={() => void saveGithubLink(null)}
              >
                Clear GitHub link
              </button>
            )}
          </div>
        </form>
      </div>
    );
  }

  if (mode.kind === "remove-confirm") {
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: the Escape handler is a keyboard-only affordance for this inline confirmation; it gains no role or tabindex itself.
      <div className="ccc-inline-form" onKeyDown={handleRemoveConfirmKeyDown}>
        <p className="ccc-state-body">
          {`Remove ${row.name} from projects? Its folder and files stay on disk.`}
        </p>
        <div className="ccc-manage-toolbar">
          <button
            type="button"
            className="ccc-button-danger"
            onClick={() => void handleRemoveConfirmed()}
          >
            Remove project
          </button>
          <button type="button" ref={keepButtonRef} className="ccc-list-more" onClick={keepProject}>
            Keep project
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      role="toolbar"
      aria-label={`${row.name} management`}
      className="ccc-manage-toolbar"
      onKeyDown={handleToolbarKeyDown}
    >
      <button
        type="button"
        ref={pinButtonRef}
        tabIndex={focusedIndex === 0 ? 0 : -1}
        className="ccc-quick-action"
        onFocus={() => setFocusedIndex(0)}
        onClick={() => void handleTogglePin()}
      >
        {row.pinned ? "Unpin project" : "Pin project"}
      </button>
      <button
        type="button"
        ref={renameButtonRef}
        tabIndex={focusedIndex === 1 ? 0 : -1}
        className="ccc-quick-action"
        onFocus={() => setFocusedIndex(1)}
        onClick={openRename}
      >
        Rename project
      </button>
      <button
        type="button"
        ref={githubButtonRef}
        tabIndex={focusedIndex === 2 ? 0 : -1}
        className="ccc-quick-action"
        onFocus={() => setFocusedIndex(2)}
        onClick={openGithubLink}
      >
        {overrideLabel !== null ? "Edit GitHub link" : "Set GitHub link"}
      </button>
      <button
        type="button"
        ref={removeButtonRef}
        tabIndex={focusedIndex === 3 ? 0 : -1}
        className="ccc-quick-action"
        onFocus={() => setFocusedIndex(3)}
        onClick={openRemoveConfirm}
      >
        Remove from projects
      </button>
    </div>
  );
}
