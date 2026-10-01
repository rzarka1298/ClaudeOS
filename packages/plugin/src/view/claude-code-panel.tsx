import {
  type DetectionResponse,
  type LauncherConfigView,
  type SaveLauncherConfigRequest,
  TERMINAL_PRESET_IDS,
  type TerminalChoice,
  type TerminalPresetId,
  terminalMayPromptForAutomation,
} from "@ccc/domain";
import type { VNode } from "preact";
import { useId, useRef } from "preact/hooks";
import type { ConnectionState } from "../connection-state.js";
import type { LaunchersActions } from "../projects/launchers-actions.js";
import {
  type ClaudeCodeDraft,
  FieldError,
  LAUNCHER_PANEL_NAMES,
  type LauncherBadge,
  LauncherStatusBadge,
  type LaunchersSession,
  loadConfigs,
  PANEL_DESCRIPTIONS,
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
} from "./launcher-panel-kit.js";
import { checkTemplate, refusalCopy, TemplateEditor } from "./template-editor.js";

/**
 * The S6 Claude Code launcher panel (plan 04-12 Task 2, PROJ-10, D-21,
 * D-22, D-23): which `claude` runs, in which terminal, with which
 * arguments — each argument its own input, with the S7 preview of exactly
 * what runs. A detected executable is sent by its candidate id, so a path
 * the plugin was never typed never travels back to the service (D-43).
 */

/** `{Terminal}` for a terminal choice (the service's own labels, UI-SPEC "Launch error copy"). */
const PRESET_TERMINAL_LABELS: Readonly<Record<TerminalPresetId, string>> = {
  iterm2: "iTerm2",
  ghostty: "Ghostty",
  wezterm: "WezTerm",
  blank: "Your terminal",
};

export function terminalLabelOf(terminal: TerminalDraft | TerminalChoice): string {
  return terminal.kind === "terminal-app" ? "Terminal" : PRESET_TERMINAL_LABELS[terminal.preset];
}

/**
 * The presets in their offered order, from detection when it has them (one
 * copy of each preset lives in `@ccc/launchers`, PR-13). Before detection
 * answers, each preset starts as an empty executable plus `{script}` — the
 * owner can still type a template by hand.
 */
function presetsOf(detection: DetectionResponse | null): DetectionResponse["terminalPresets"] {
  if (detection !== null && detection.terminalPresets.length > 0) return detection.terminalPresets;
  return TERMINAL_PRESET_IDS.map((id) => ({
    id,
    label: id === "blank" ? "Blank template" : PRESET_TERMINAL_LABELS[id],
    argv: ["", "{script}"],
    verified: false,
  }));
}

function presetOptionLabel(preset: DetectionResponse["terminalPresets"][number]): string {
  if (preset.id === "blank") return "Blank template";
  return preset.verified ? preset.label : `${preset.label} (unverified)`;
}

/** The draft the saved configuration reads as (or `null` when nothing is saved). */
function savedBaseline(
  saved: NonNullable<LauncherConfigView["claude-code"]>,
  detection: DetectionResponse | null,
): ClaudeCodeDraft {
  const candidate = detection?.claudeExecutables.find(
    (option) => option.displayPath === saved.executableDisplay,
  );
  return {
    // A saved path outside the home folder is shown as typed; one under it
    // reaches the plugin only home-abbreviated, so the owner re-enters it
    // if they change anything else (the service never echoes a home path).
    executable:
      candidate !== undefined
        ? { kind: "candidate", candidateId: candidate.candidateId }
        : {
            kind: "path",
            text: saved.executableDisplay.startsWith("/") ? saved.executableDisplay : "",
          },
    args: saved.args,
    terminal: saved.terminal,
  };
}

/** What a never-saved panel proposes: one detected executable is preselected, several are not. */
function proposal(detection: DetectionResponse | null): ClaudeCodeDraft {
  const candidates = detection?.claudeExecutables ?? [];
  const only = candidates.length === 1 ? candidates[0] : undefined;
  return {
    executable:
      only !== undefined
        ? { kind: "candidate", candidateId: only.candidateId }
        : candidates.length === 0
          ? { kind: "path", text: "" }
          : null,
    args: [],
    terminal: { kind: "terminal-app" },
  };
}

/** The preview's first line: the chosen executable as the owner sees it. */
function executableDisplayOf(
  executable: ClaudeCodeDraft["executable"],
  candidates: DetectionResponse["claudeExecutables"],
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

function sameDraft(a: ClaudeCodeDraft, b: ClaudeCodeDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function claudeBadge(saved: LauncherConfigView["claude-code"] | undefined): LauncherBadge {
  if (saved === null || saved === undefined) return "not-set-up";
  return saved.tested ? "tested" : "set-up";
}

/** Splits a save error into the executable line, each editor's rows and each editor's general line. */
function errorsFor(
  error: SaveError | undefined,
  draft: ClaudeCodeDraft,
): {
  executable: string | null;
  claude: Map<number, string>;
  terminal: Map<number, string>;
  claudeGeneral: string | null;
  terminalGeneral: string | null;
} {
  const result = {
    executable: null as string | null,
    claude: new Map<number, string>(),
    terminal: new Map<number, string>(),
    claudeGeneral: null as string | null,
    terminalGeneral: null as string | null,
  };
  if (error === undefined || error.kind === "invalid-bundle") return result;
  if (error.kind === "client") {
    result.executable = error.executable;
    result.claude = new Map(error.claude);
    result.terminal = new Map(error.terminal);
    return result;
  }
  const template =
    error.template ?? (error.reason === "missing-script-placeholder" ? "terminal" : "claude-code");
  const argv =
    template === "terminal"
      ? draft.terminal.kind === "custom"
        ? draft.terminal.argv
        : []
      : ["", ...draft.args];
  const copy = refusalCopy(error.reason, error.index === null ? undefined : argv[error.index]);
  if (template === "claude-code" && error.index === 0) {
    result.executable =
      error.reason === "executable-not-absolute"
        ? "Enter the full path, starting with /."
        : error.reason === "executable-not-executable"
          ? "There's no executable file at this path."
          : copy;
  } else if (error.index === null) {
    if (template === "terminal") result.terminalGeneral = copy;
    else result.claudeGeneral = copy;
  } else if (template === "terminal") {
    result.terminal.set(error.index, copy);
  } else {
    result.claude.set(error.index, copy);
  }
  return result;
}

export interface ClaudeCodePanelProps {
  readonly actions: LaunchersActions;
  readonly session: LaunchersSession;
  readonly connection: ConnectionState;
  readonly now: number;
  /** The sample project's display path for `{projectPath}` in the preview (RR-24). */
  readonly sampleDisplayPath: string;
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

export function ClaudeCodePanel({
  actions,
  session,
  connection,
  now,
  sampleDisplayPath,
}: ClaudeCodePanelProps): VNode {
  const headingId = useId();
  const executableGroup = useId();
  const terminalGroup = useId();
  const pathInputId = useId();
  const pathErrorId = useId();
  const presetSelectId = useId();
  const chooseNoteId = useId();
  const testButtonRef = useRef<HTMLButtonElement>(null);
  const disabled = connection.kind === "disconnected";
  const ariaDisabled = disabled ? "true" : undefined;

  const detection = session.detection.value;
  const configs = session.configs.value;
  const saved = configs?.["claude-code"] ?? null;
  const baseline = saved === null ? null : savedBaseline(saved, detection);
  const draft = session.claudeDraft.value;
  const current = draft ?? baseline ?? proposal(detection);
  const executableChosen =
    current.executable !== null &&
    (current.executable.kind === "candidate" || current.executable.text !== "");
  const dirty = baseline === null ? executableChosen : !sameDraft(current, baseline);
  const status = session.status.value["claude-code"] ?? { kind: "idle" };
  const saving = status.kind === "saving";
  const canSave = current.executable !== null && !saving && !disabled;
  const errors = errorsFor(session.saveErrors.value["claude-code"], current);
  const candidates = detection?.claudeExecutables ?? [];
  const presets = presetsOf(detection);
  const terminalLabel = terminalLabelOf(current.terminal);

  // A Test exercises the SAVED configuration (PR-13), so it is the saved
  // terminal whose Automation prompt the Test may meet (wave 5).
  const savedTerminal = saved?.terminal ?? null;
  const savedTerminalLabel = terminalInSentence(
    terminalLabelOf(savedTerminal ?? { kind: "terminal-app" }),
  );
  const testBlock: TestBlock = disabled
    ? "disconnected"
    : saved === null || dirty
      ? "save-first"
      : testBusy(status)
        ? "busy"
        : null;

  function setDraft(next: ClaudeCodeDraft | null): void {
    if (disabled) return;
    session.claudeDraft.value = next;
    setSaveError(session, "claude-code", null);
    if (status.kind !== "idle" && !saving && !testBusy(status)) {
      setPanelStatus(session, "claude-code", { kind: "idle" });
    }
  }

  function update(change: Partial<ClaudeCodeDraft>): void {
    setDraft({ ...current, ...change });
  }

  function chooseTerminal(kind: "terminal-app" | "custom"): void {
    if (kind === current.terminal.kind) return;
    if (kind === "terminal-app") {
      update({ terminal: { kind: "terminal-app" } });
      return;
    }
    const savedCustom = saved?.terminal.kind === "custom" ? saved.terminal : null;
    const blank = presets.find((preset) => preset.id === "blank");
    update({
      terminal: savedCustom ?? {
        kind: "custom",
        preset: "blank",
        argv: blank?.argv ?? ["", "{script}"],
      },
    });
  }

  function choosePreset(id: string): void {
    const preset = presets.find((option) => option.id === id);
    if (preset === undefined) return;
    update({ terminal: { kind: "custom", preset: preset.id, argv: [...preset.argv] } });
  }

  function save(): void {
    if (!canSave || current.executable === null) return;
    const executableProblem =
      current.executable.kind === "path" && !current.executable.text.startsWith("/")
        ? "Enter the full path, starting with /."
        : null;
    const claudeProblems: RowError[] = checkTemplate("claude-code", current.args);
    const terminalProblems: RowError[] =
      current.terminal.kind === "custom" ? checkTemplate("terminal", current.terminal.argv) : [];
    if (executableProblem !== null || claudeProblems.length > 0 || terminalProblems.length > 0) {
      setSaveError(session, "claude-code", {
        kind: "client",
        executable: executableProblem,
        claude: claudeProblems,
        terminal: terminalProblems,
      });
      return;
    }
    const request: SaveLauncherConfigRequest = {
      launcherId: "claude-code",
      executable:
        current.executable.kind === "candidate"
          ? { kind: "candidate", candidateId: current.executable.candidateId }
          : { kind: "path", path: current.executable.text },
      args: [...current.args],
      terminal:
        current.terminal.kind === "terminal-app"
          ? { kind: "terminal-app" }
          : { kind: "custom", preset: current.terminal.preset, argv: [...current.terminal.argv] },
    };
    setSaveError(session, "claude-code", null);
    setPanelStatus(session, "claude-code", { kind: "saving" });
    // An edit made while the save runs is kept (wave-6 review).
    const draftAtSave = session.claudeDraft.value;
    void actions.save(request).then((outcome) => {
      switch (outcome.kind) {
        case "saved":
          setPanelStatus(session, "claude-code", { kind: "saved" });
          void loadConfigs(session, actions).then((applied) => {
            if (applied && session.claudeDraft.value === draftAtSave) {
              session.claudeDraft.value = null;
            }
          });
          return;
        case "refused":
          setPanelStatus(session, "claude-code", { kind: "idle" });
          setSaveError(session, "claude-code", {
            kind: "refused",
            reason: outcome.reason,
            index: outcome.index,
            template: outcome.template,
          });
          return;
        default:
          setPanelStatus(session, "claude-code", { kind: "save-failed" });
      }
    });
  }

  const executableDisplay = executableDisplayOf(current.executable, candidates);
  const pathChosen = current.executable?.kind === "path";
  const customTerminal = current.terminal.kind === "custom" ? current.terminal : null;
  const presetTested =
    customTerminal &&
    saved?.tested &&
    JSON.stringify(saved.terminal) === JSON.stringify(customTerminal);
  const presetApp =
    customTerminal !== null && customTerminal.preset !== "blank" && detection !== null
      ? detection.apps[customTerminal.preset]
      : null;

  return (
    <section className="ccc-card ccc-launcher-panel" aria-labelledby={headingId}>
      <h4 id={headingId} className="ccc-field-label">
        {LAUNCHER_PANEL_NAMES["claude-code"]}
      </h4>
      <LauncherStatusBadge badge={claudeBadge(saved)} />
      <p className="ccc-state-body">{PANEL_DESCRIPTIONS["claude-code"]}</p>

      <fieldset className="ccc-radio-group">
        <legend className="ccc-field-label">Claude Code executable</legend>
        {detection !== null && candidates.length === 0 && (
          <>
            <p className="ccc-list-meta">Claude Code wasn't found in the usual places.</p>
            <p className="ccc-list-meta">Enter the full path to the claude executable.</p>
          </>
        )}
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
            <span className="ccc-display-path">{option.displayPath}</span>
          </label>
        ))}
        <label>
          <input
            type="radio"
            name={executableGroup}
            aria-disabled={ariaDisabled}
            onClick={blockClickWhen(disabled)}
            checked={pathChosen}
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
      {current.executable?.kind === "path" && (
        <div className="ccc-inline-form">
          <label className="ccc-field-label" htmlFor={pathInputId}>
            Path to claude
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

      <fieldset className="ccc-radio-group">
        <legend className="ccc-field-label">Terminal</legend>
        <label>
          <input
            type="radio"
            name={terminalGroup}
            aria-disabled={ariaDisabled}
            onClick={blockClickWhen(disabled)}
            checked={current.terminal.kind === "terminal-app"}
            onChange={() => chooseTerminal("terminal-app")}
          />{" "}
          Terminal <span className="ccc-list-meta">Built in to macOS.</span>
        </label>
        <label>
          <input
            type="radio"
            name={terminalGroup}
            aria-disabled={ariaDisabled}
            onClick={blockClickWhen(disabled)}
            checked={current.terminal.kind === "custom"}
            onChange={() => chooseTerminal("custom")}
          />{" "}
          Custom terminal{" "}
          <span className="ccc-list-meta">Any terminal, started from an argument template.</span>
        </label>
      </fieldset>
      {customTerminal !== null && (
        <div className="ccc-inline-form">
          <label className="ccc-field-label" htmlFor={presetSelectId}>
            Start from a preset
          </label>
          <select
            id={presetSelectId}
            className="ccc-text-input"
            value={customTerminal.preset}
            aria-disabled={ariaDisabled}
            onChange={(event) => {
              if (disabled) {
                // Keep the last-known preset while the service is away.
                event.currentTarget.value = customTerminal.preset;
                return;
              }
              choosePreset(event.currentTarget.value);
            }}
          >
            {presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {presetOptionLabel(preset)}
              </option>
            ))}
          </select>
          {presetTested ? (
            <LauncherStatusBadge badge="tested" />
          ) : (
            <span className="ccc-badge">
              <span className="ccc-meta-glyph" aria-hidden="true">
                △
              </span>{" "}
              Unverified
            </span>
          )}
          {presetApp !== null && presetApp.length === 0 && (
            <p className="ccc-list-meta">{`${PRESET_TERMINAL_LABELS[customTerminal.preset]} wasn't found on this Mac.`}</p>
          )}
          <TemplateEditor
            kind="terminal"
            value={customTerminal.argv}
            onChange={(argv) => update({ terminal: { ...customTerminal, argv } })}
            errors={errors.terminal}
            generalError={errors.terminalGeneral}
            sampleDisplayPath={sampleDisplayPath}
            terminalLabel={terminalLabel}
            disabled={disabled}
          />
        </div>
      )}

      <TemplateEditor
        kind="claude-code"
        value={current.args}
        onChange={(args) => update({ args })}
        errors={errors.claude}
        generalError={errors.claudeGeneral}
        sampleDisplayPath={sampleDisplayPath}
        terminalLabel={terminalLabel}
        executableDisplay={executableDisplay}
        disabled={disabled}
      />

      <TestLines
        automation={current.terminal.kind === "custom"}
        explanation={`Test opens a new ${terminalInSentence(terminalLabel)} window at the managed vault folder that shows the Claude Code version.`}
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
            Choose a claude executable first
          </span>
        )}
        <TestLauncherButton
          appName={LAUNCHER_PANEL_NAMES["claude-code"]}
          block={testBlock}
          buttonRef={testButtonRef}
          onTest={() => runLauncherTest(session, actions, "claude-code", savedTerminal)}
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
        id="claude-code"
        status={status}
        now={now}
        copy={{
          appName: LAUNCHER_PANEL_NAMES["claude-code"],
          question: `Test sent. Did a ${savedTerminalLabel} window open and show the Claude Code version?`,
          terminal: savedTerminalLabel,
          mayPrompt: savedTerminal !== null && terminalMayPromptForAutomation(savedTerminal),
        }}
      />
      <PanelFollowUps
        id="claude-code"
        status={status}
        session={session}
        actions={actions}
        disabled={disabled}
        testButtonRef={testButtonRef}
      />
    </section>
  );
}
