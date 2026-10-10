import type {
  DetectedCodexExecutable,
  LauncherConfigView,
  SaveLauncherConfigRequest,
} from "@ccc/domain";
import type { VNode } from "preact";
import { useId } from "preact/hooks";
import type { ConnectionState } from "../connection-state.js";
import type { LaunchersActions } from "../projects/launchers-actions.js";
import {
  CODEX_PANEL_DESCRIPTION,
  CODEX_PANEL_NAME,
  type CodexDraft,
  type ExecutableDraft,
  type LauncherBadge,
  LauncherStatusBadge,
  type LaunchersSession,
  loadConfigs,
  PanelStatusLine,
  setPanelStatus,
  setSaveError,
} from "./launcher-panel-kit.js";
import { checkTemplate, TemplateEditor } from "./template-editor.js";

/**
 * The Codex launcher panel (plan 05.1-31, D-11, CODEX-03, UI-SPEC S4-b): which
 * `codex` runs and with which arguments, built from the same kit as the Claude
 * Code panel. A detected executable is sent by its opaque candidate id, so no
 * path the plugin never typed travels back to the service; the service
 * re-validates everything (T-05.1-01). Codex has no terminal control of its
 * own: it opens in the Claude Code row's terminal.
 */

export interface CodexLauncherPanelProps {
  readonly actions: LaunchersActions;
  readonly session: LaunchersSession;
  readonly connection: ConnectionState;
  readonly now: number;
  /** The sample project's display path for `{projectPath}` in the preview (RR-24). */
  readonly sampleDisplayPath: string;
}

type SavedCodex = NonNullable<LauncherConfigView["codex"]>;

/** The draft the saved configuration reads as. */
function savedBaseline(
  saved: SavedCodex,
  candidates: readonly DetectedCodexExecutable[],
): CodexDraft {
  const candidate = candidates.find((option) => option.displayPath === saved.executableDisplay);
  return {
    // A saved path under the home folder reaches the plugin only
    // home-abbreviated, so the owner re-enters it if they change anything
    // else (the service never echoes a home path).
    executable:
      candidate !== undefined
        ? { kind: "candidate", candidateId: candidate.candidateId }
        : {
            kind: "path",
            text: saved.executableDisplay.startsWith("/") ? saved.executableDisplay : "",
          },
    args: saved.args,
  };
}

/** What a never-saved panel proposes: one detected executable is preselected, several are not. */
function proposal(candidates: readonly DetectedCodexExecutable[]): CodexDraft {
  const only = candidates.length === 1 ? candidates[0] : undefined;
  return {
    executable: only !== undefined ? { kind: "candidate", candidateId: only.candidateId } : null,
    args: [],
  };
}

function sameDraft(a: CodexDraft, b: CodexDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isChosen(executable: ExecutableDraft): boolean {
  return executable !== null && (executable.kind === "candidate" || executable.text !== "");
}

function codexBadge(saved: LauncherConfigView["codex"]): LauncherBadge {
  if (saved === null || saved === undefined) return "not-set-up";
  return saved.tested ? "tested" : "set-up";
}

/** `Found Codex {version} at {display path}.` (UI-SPEC S4-b); the version is dropped when unknown. */
function FoundLine({ option }: { readonly option: DetectedCodexExecutable }): VNode {
  return (
    <>
      {option.version === null ? "Found Codex at " : `Found Codex ${option.version} at `}
      <span className="ccc-display-path">{option.displayPath}</span>.
    </>
  );
}

/** The preview's first line: the chosen executable as the owner sees it. */
function executableDisplayOf(
  executable: ExecutableDraft,
  candidates: readonly DetectedCodexExecutable[],
): string | null {
  if (executable === null) return null;
  if (executable.kind === "candidate") {
    return (
      candidates.find((option) => option.candidateId === executable.candidateId)?.displayPath ??
      null
    );
  }
  return executable.text === "" ? null : executable.text;
}

/**
 * A radio that is `aria-disabled` stays focusable but must not change: the
 * click's default (checking it) is cancelled while the service is away.
 */
function blockClickWhen(disabled: boolean): ((event: MouseEvent) => void) | undefined {
  return disabled ? (event) => event.preventDefault() : undefined;
}

export function CodexLauncherPanel({
  actions,
  session,
  connection,
  now,
  sampleDisplayPath,
}: CodexLauncherPanelProps): VNode {
  const headingId = useId();
  const executableGroup = useId();
  const chooseNoteId = useId();
  const disabled = connection.kind === "disconnected";
  const ariaDisabled = disabled ? "true" : undefined;

  const candidates = session.detection.value?.codex?.executables ?? [];
  const saved = session.configs.value?.codex ?? null;
  const baseline = saved === null ? null : savedBaseline(saved, candidates);
  const draft = session.codexDraft.value;
  const current = draft ?? baseline ?? proposal(candidates);
  const executableChosen = isChosen(current.executable);
  const dirty = baseline === null ? executableChosen : !sameDraft(current, baseline);
  const status = session.status.value.codex ?? { kind: "idle" };
  const saving = status.kind === "saving";
  const canSave = current.executable !== null && !saving && !disabled;

  function setDraft(next: CodexDraft | null): void {
    if (disabled) return;
    session.codexDraft.value = next;
    setSaveError(session, "codex", null);
    if (status.kind !== "idle" && !saving) setPanelStatus(session, "codex", { kind: "idle" });
  }

  function update(change: Partial<CodexDraft>): void {
    setDraft({ ...current, ...change });
  }

  function save(): void {
    if (!canSave || current.executable === null) return;
    const problems = checkTemplate("codex", current.args);
    if (problems.length > 0) {
      setSaveError(session, "codex", {
        kind: "client",
        executable: null,
        claude: problems,
        terminal: [],
      });
      return;
    }
    const request: SaveLauncherConfigRequest = {
      launcherId: "codex",
      executable:
        current.executable.kind === "candidate"
          ? { kind: "candidate", candidateId: current.executable.candidateId }
          : { kind: "path", path: current.executable.text },
      args: [...current.args],
    };
    setSaveError(session, "codex", null);
    setPanelStatus(session, "codex", { kind: "saving" });
    // An edit made while the save runs is kept (wave-6 review).
    const draftAtSave = session.codexDraft.value;
    void actions.save(request).then((outcome) => {
      switch (outcome.kind) {
        case "saved":
          setPanelStatus(session, "codex", { kind: "saved" });
          void loadConfigs(session, actions).then((applied) => {
            if (applied && session.codexDraft.value === draftAtSave) {
              session.codexDraft.value = null;
            }
          });
          return;
        case "refused":
          setPanelStatus(session, "codex", { kind: "idle" });
          setSaveError(session, "codex", {
            kind: "refused",
            reason: outcome.reason,
            index: outcome.index,
            template: outcome.template,
          });
          return;
        default:
          setPanelStatus(session, "codex", { kind: "save-failed" });
          // An uncertain outcome may still have stored: re-read what the
          // service holds; the draft stays.
          void loadConfigs(session, actions);
      }
    });
  }

  const executableDisplay = executableDisplayOf(current.executable, candidates);

  return (
    <section className="ccc-card ccc-launcher-panel" aria-labelledby={headingId}>
      <h4 id={headingId} className="ccc-section-label">
        {CODEX_PANEL_NAME}
      </h4>
      <LauncherStatusBadge badge={codexBadge(saved)} />
      <p className="ccc-state-body">{CODEX_PANEL_DESCRIPTION}</p>

      {candidates.length > 0 && (
        <fieldset className="ccc-radio-group">
          <legend className="ccc-field-label">Codex executable</legend>
          {candidates.map((option) => (
            <label key={option.candidateId}>
              <input
                type="radio"
                name={executableGroup}
                aria-disabled={ariaDisabled}
                onClick={blockClickWhen(disabled)}
                checked={
                  current.executable?.kind === "candidate" &&
                  current.executable.candidateId === option.candidateId
                }
                onChange={() =>
                  update({ executable: { kind: "candidate", candidateId: option.candidateId } })
                }
              />{" "}
              <FoundLine option={option} />
            </label>
          ))}
        </fieldset>
      )}

      <TemplateEditor
        kind="codex"
        value={current.args}
        onChange={(args) => update({ args })}
        errors={new Map()}
        sampleDisplayPath={sampleDisplayPath}
        terminalLabel="Terminal"
        executableDisplay={executableDisplay}
        disabled={disabled}
      />

      <div className="ccc-manage-toolbar">
        <button
          type="button"
          className="ccc-connect-button"
          aria-disabled={canSave ? undefined : "true"}
          aria-describedby={current.executable === null ? chooseNoteId : undefined}
          onClick={save}
        >
          Save launcher
        </button>
        {current.executable === null && (
          <span id={chooseNoteId} className="ccc-visually-hidden">
            Choose a codex executable first
          </span>
        )}
        {dirty && <span className="ccc-list-meta">Unsaved changes</span>}
      </div>
      <PanelStatusLine
        id="codex"
        status={status}
        now={now}
        copy={{
          appName: CODEX_PANEL_NAME,
          question: "Test sent. Did Codex open?",
          terminal: "Terminal",
          mayPrompt: false,
        }}
      />
    </section>
  );
}
