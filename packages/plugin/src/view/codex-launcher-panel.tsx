import {
  type DetectedCodexExecutable,
  type LauncherConfigView,
  type SaveLauncherConfigRequest,
  terminalMayPromptForAutomation,
} from "@ccc/domain";
import type { VNode } from "preact";
import { useId, useRef } from "preact/hooks";
import type { ConnectionState } from "../connection-state.js";
import { LAUNCH_ERROR_COPY } from "../projects/launch-copy.js";
import type { LaunchersActions } from "../projects/launchers-actions.js";
import { proposedTerminal, terminalLabelOf } from "./claude-code-panel.js";
import {
  CODEX_PANEL_DESCRIPTION,
  CODEX_PANEL_NAME,
  type CodexDoctorState,
  type CodexDraft,
  type ExecutableDraft,
  FieldError,
  type LauncherBadge,
  LauncherStatusBadge,
  type LaunchersSession,
  loadConfigs,
  PanelFollowUps,
  type PanelStatus,
  PanelStatusLine,
  type RowError,
  runLauncherTest,
  type SaveError,
  setPanelStatus,
  setSaveError,
  type TerminalDraft,
  type TestBlock,
  TestLauncherButton,
  TestLines,
  terminalInSentence,
  terminalTestSentences,
} from "./launcher-panel-kit.js";
import { checkTemplate, refusalCopy, TemplateEditor } from "./template-editor.js";

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

/** `Found Codex {version} at {display path}.` (UI-SPEC S4-b); the version is dropped when unknown. */
function FoundLine({ option }: { readonly option: DetectedCodexExecutable }): VNode {
  return (
    <>
      {option.version === null ? "Found Codex at " : `Found Codex ${option.version} at `}
      <span className="ccc-display-path">{option.displayPath}</span>.
    </>
  );
}

const EXECUTABLE_NOT_FOUND =
  "This isn't a Codex executable this app can run. Choose Detect apps, or enter the full path to the codex file itself.";

/** Splits a save error into the executable line, each argument row's line and a general line. */
function errorsFor(
  error: SaveError | undefined,
  draft: CodexDraft,
): { executable: string | null; rows: Map<number, string>; general: string | null } {
  const result = {
    executable: null as string | null,
    rows: new Map<number, string>(),
    general: null as string | null,
  };
  if (error === undefined || error.kind === "invalid-bundle") return result;
  if (error.kind === "client") {
    result.executable = error.executable;
    result.rows = new Map(error.claude);
    return result;
  }
  const argv = ["", ...draft.args];
  if (error.index === 0) {
    result.executable =
      error.reason === "executable-not-absolute"
        ? "Enter the full path, starting with /."
        : error.reason === "executable-not-executable"
          ? "There's no executable file at this path."
          : error.reason === "executable-not-found"
            ? EXECUTABLE_NOT_FOUND
            : refusalCopy(error.reason, undefined, { template: "codex" });
    return result;
  }
  const copy = refusalCopy(error.reason, error.index === null ? undefined : argv[error.index], {
    template: "codex",
    previous: error.index === null ? undefined : argv[error.index - 1],
  });
  if (error.index === null) result.general = copy;
  else result.rows.set(error.index, copy);
  return result;
}

/** A Test or a mark-tested call is in flight: the Test button waits. */
function testBusy(status: PanelStatus): boolean {
  return status.kind === "testing" || status.kind === "confirming";
}

/**
 * A radio that is `aria-disabled` stays focusable but must not change: the
 * click's default (checking it) is cancelled while the service is away.
 */
function blockClickWhen(disabled: boolean): ((event: MouseEvent) => void) | undefined {
  return disabled ? (event) => event.preventDefault() : undefined;
}

/** Why the health control cannot run right now, if it cannot. */
type HealthBlock = "disconnected" | "save-first" | "busy" | null;

/** The health region: one of three fixed lines, never any doctor output (R4). */
function HealthLines({ state }: { readonly state: CodexDoctorState }): VNode | null {
  switch (state.kind) {
    case "checking":
      return <>Checking…</>;
    case "healthy":
      return (
        <>
          <span className="ccc-meta-glyph" aria-hidden="true">
            ✓
          </span>{" "}
          Codex doctor reports it's healthy.
        </>
      );
    case "problem":
      return (
        <>
          <span className="ccc-error-glyph" aria-hidden="true">
            ▲
          </span>
          Codex doctor reported a problem.
        </>
      );
    case "service-failure":
      return (
        <>
          <span className="ccc-error-glyph" aria-hidden="true">
            ▲
          </span>
          <span>{LAUNCH_ERROR_COPY["service-disconnected"].problem}</span>
          <br />
          <span>{LAUNCH_ERROR_COPY["service-disconnected"].nextStep}</span>
        </>
      );
    default:
      return null;
  }
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
  const pathInputId = useId();
  const pathErrorId = useId();
  const chooseNoteId = useId();
  const healthNoteId = useId();
  const testButtonRef = useRef<HTMLButtonElement>(null);
  const disabled = connection.kind === "disconnected";
  const ariaDisabled = disabled ? "true" : undefined;

  const detection = session.detection.value;
  const candidates = detection?.codex?.executables ?? [];
  const configs = session.configs.value;
  const saved = configs?.codex ?? null;
  const baseline = saved === null ? null : savedBaseline(saved, candidates);
  const draft = session.codexDraft.value;
  const current = draft ?? baseline ?? proposal(candidates);
  const dirty = baseline === null ? isChosen(current.executable) : !sameDraft(current, baseline);
  const status = session.status.value.codex ?? { kind: "idle" };
  const saving = status.kind === "saving";
  const canSave = current.executable !== null && !saving && !disabled;
  const errors = errorsFor(session.saveErrors.value.codex, current);
  const doctor = session.codexDoctor.value;

  // Codex opens in the Claude Code row's terminal: a read-only mirror of the
  // SAVED choice, or of that panel's draft or proposal when nothing is saved.
  const claudeSavedTerminal = configs?.["claude-code"]?.terminal ?? null;
  const mirroredTerminal: TerminalDraft =
    claudeSavedTerminal ?? session.claudeDraft.value?.terminal ?? proposedTerminal(detection);
  const terminalLabel = terminalLabelOf(mirroredTerminal);
  const sentences = terminalTestSentences(terminalLabel, "Codex");

  const testBlock: TestBlock = disabled
    ? "disconnected"
    : saved === null || dirty
      ? "save-first"
      : testBusy(status)
        ? "busy"
        : null;
  const healthBlock: HealthBlock = disabled
    ? "disconnected"
    : saved === null
      ? "save-first"
      : doctor.kind === "checking"
        ? "busy"
        : null;

  function setDraft(next: CodexDraft | null): void {
    if (disabled) return;
    session.codexDraft.value = next;
    setSaveError(session, "codex", null);
    if (status.kind !== "idle" && !saving && !testBusy(status)) {
      setPanelStatus(session, "codex", { kind: "idle" });
    }
  }

  function update(change: Partial<CodexDraft>): void {
    setDraft({ ...current, ...change });
  }

  function save(): void {
    if (!canSave || current.executable === null) return;
    const executableProblem =
      current.executable.kind === "path" && !current.executable.text.startsWith("/")
        ? "Enter the full path, starting with /."
        : null;
    // The plugin's own trivial check: a convenience, the service is authoritative.
    const rowProblems: RowError[] = checkTemplate("codex", current.args);
    if (executableProblem !== null || rowProblems.length > 0) {
      setSaveError(session, "codex", {
        kind: "client",
        executable: executableProblem,
        claude: rowProblems,
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
          // A health result belongs to the launcher it checked.
          if (session.codexDoctor.value.kind !== "checking") {
            session.codexDoctor.value = { kind: "idle" };
          }
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

  /** The owner's press is the only thing that ever runs doctor (R4, T-05.1-11). */
  function checkHealth(): void {
    if (healthBlock !== null) return;
    session.codexDoctor.value = { kind: "checking" };
    void actions.codexDoctor().then((outcome) => {
      session.codexDoctor.value =
        outcome.kind === "healthy"
          ? { kind: "healthy" }
          : outcome.kind === "problem"
            ? { kind: "problem" }
            : { kind: "service-failure" };
    });
  }

  const executableDisplay = executableDisplayOf(current.executable, candidates);
  const showExecutableChoices = candidates.length > 0 || current.executable?.kind === "path";
  const notInstalled = detection !== null && candidates.length === 0 && saved === null;

  return (
    <section className="ccc-card ccc-launcher-panel" aria-labelledby={headingId}>
      <h4 id={headingId} className="ccc-section-label">
        {CODEX_PANEL_NAME}
      </h4>
      <LauncherStatusBadge badge={codexBadge(saved)} />
      <p className="ccc-state-body">{CODEX_PANEL_DESCRIPTION}</p>
      <p className="ccc-list-meta">{`Opens in ${terminalInSentence(terminalLabel)}.`}</p>

      {notInstalled && (
        <p className="ccc-list-meta">
          <span className="ccc-meta-glyph" aria-hidden="true">
            ◌
          </span>{" "}
          Codex isn't installed on this Mac. Install it, then choose Detect again.
        </p>
      )}

      {showExecutableChoices && (
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
          <label>
            <input
              type="radio"
              name={executableGroup}
              aria-disabled={ariaDisabled}
              onClick={blockClickWhen(disabled)}
              checked={current.executable?.kind === "path"}
              onChange={() =>
                update({
                  executable: {
                    kind: "path",
                    text: current.executable?.kind === "path" ? current.executable.text : "",
                  },
                })
              }
            />{" "}
            Use a different path
          </label>
        </fieldset>
      )}
      {current.executable?.kind === "path" && (
        <div className="ccc-inline-form">
          <label className="ccc-field-label" htmlFor={pathInputId}>
            Path to codex
          </label>
          <input
            id={pathInputId}
            type="text"
            className="ccc-text-input ccc-text-input--mono"
            spellcheck={false}
            autocomplete="off"
            value={current.executable.text}
            readOnly={disabled}
            aria-disabled={ariaDisabled}
            aria-invalid={errors.executable !== null ? "true" : undefined}
            aria-describedby={errors.executable !== null ? pathErrorId : undefined}
            onInput={(event) =>
              update({ executable: { kind: "path", text: event.currentTarget.value } })
            }
          />
        </div>
      )}
      {errors.executable !== null && <FieldError id={pathErrorId} text={errors.executable} />}

      <TemplateEditor
        kind="codex"
        value={current.args}
        onChange={(args) => update({ args })}
        errors={errors.rows}
        generalError={errors.general}
        sampleDisplayPath={sampleDisplayPath}
        terminalLabel={terminalLabel}
        executableDisplay={executableDisplay}
        disabled={disabled}
      />

      <TestLines
        automation={mirroredTerminal.kind === "custom"}
        explanation={sentences.explanation}
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
        <TestLauncherButton
          appName={CODEX_PANEL_NAME}
          block={testBlock}
          buttonRef={testButtonRef}
          onTest={() => runLauncherTest(session, actions, "codex", claudeSavedTerminal)}
        />
        {dirty && <span className="ccc-list-meta">Unsaved changes</span>}
        {draft !== null && dirty && (
          <button
            type="button"
            className="ccc-list-more"
            aria-disabled={ariaDisabled}
            onClick={() => setDraft(null)}
          >
            Discard changes
          </button>
        )}
      </div>
      <PanelStatusLine
        id="codex"
        status={status}
        now={now}
        copy={{
          appName: CODEX_PANEL_NAME,
          question: sentences.question,
          terminal: terminalLabel,
          mayPrompt:
            claudeSavedTerminal !== null && terminalMayPromptForAutomation(claudeSavedTerminal),
        }}
      />
      <PanelFollowUps
        id="codex"
        status={status}
        session={session}
        actions={actions}
        disabled={disabled}
        testButtonRef={testButtonRef}
      />

      <div className="ccc-manage-toolbar">
        <button
          type="button"
          className="ccc-list-more"
          aria-disabled={healthBlock === null ? undefined : "true"}
          aria-describedby={healthBlock === "save-first" ? healthNoteId : undefined}
          onClick={checkHealth}
        >
          Check Codex health
        </button>
        {healthBlock === "save-first" && (
          <span id={healthNoteId} className="ccc-visually-hidden">
            Save a Codex launcher first
          </span>
        )}
      </div>
      <p
        role="status"
        className="ccc-launch-status"
        data-codex-health=""
        data-tone={
          doctor.kind === "problem" || doctor.kind === "service-failure"
            ? "error"
            : doctor.kind === "healthy"
              ? "success"
              : undefined
        }
        aria-busy={doctor.kind === "checking" ? "true" : undefined}
      >
        <HealthLines state={doctor} />
      </p>
    </section>
  );
}
