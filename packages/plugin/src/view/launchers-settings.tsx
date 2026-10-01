import type { DetectedApp, LaunchAction, LauncherConfigView } from "@ccc/domain";
import { BundleIdSchema } from "@ccc/domain";
import type { VNode } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import type { ConnectionState } from "../connection-state.js";
import type { LaunchersActions } from "../projects/launchers-actions.js";
import { projectRowsFrom, projectsSnapshot } from "../projects/projects-state.js";
import { formatRelativeTime } from "../widgets/relative-time.js";
import { ClaudeCodePanel } from "./claude-code-panel.js";
import {
  type AppDraft,
  type AppLauncherId,
  createLaunchersSession,
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
  runLauncherTest,
  setPanelStatus,
  setSaveError,
  type TestBlock,
  type TestCopy,
  TestLauncherButton,
  TestLines,
} from "./launcher-panel-kit.js";
import { launchersFocusRequested } from "./launchers-focus.js";

export { createLaunchersSession, type LaunchersSession } from "./launcher-panel-kit.js";
export { requestLaunchersFocus } from "./launchers-focus.js";

/**
 * The S6 Launchers section of the command center's own Settings destination
 * (D-37, plan 04-12). Detection proposes; only the owner's explicit
 * `Save launcher` sends anything to the service (D-27). Drafts live in a
 * {@link LaunchersSession} — memory only, for the life of the view (RR-25)
 * — and are never written to plugin settings, `data.json` or the vault
 * (D-43). Each Test fires one real launch of the SAVED configuration, and
 * only the owner's It opened marks a launcher Tested (D-28, RR-14).
 */

/** The preview's sample project when none is registered (RR-24). */
export const FALLBACK_SAMPLE_PATH = "~/example-project";

/** The first project in S1 order's display path, for the template preview (RR-24). */
function sampleDisplayPath(): string {
  const snapshot = projectsSnapshot.value;
  if (snapshot === undefined) return FALLBACK_SAMPLE_PATH;
  const first = projectRowsFrom(snapshot)[0];
  if (first === undefined) return FALLBACK_SAMPLE_PATH;
  return (
    snapshot.projects.find((view) => view.projectId === first.id)?.displayPath ??
    FALLBACK_SAMPLE_PATH
  );
}

const LOCATION_COPY: Readonly<Record<DetectedApp["location"], string>> = {
  applications: "In Applications",
  "user-applications": "In your Applications folder",
  other: "Elsewhere on this Mac",
};

/** What each Test launches, in the owner's words (RR-15, ADR-0024 Test step). */
const TEST_EXPLANATIONS: Readonly<Record<Exclude<LaunchAction, "claude-code">, string>> = {
  antigravity: "Test opens Antigravity without a project.",
  "claude-desktop": "Test brings Claude Desktop to the front.",
  finder: "Test reveals the managed vault folder in Finder.",
  github: "Test opens github.com in your default browser.",
};

function defaultTestCopy(id: LaunchAction): TestCopy {
  const appName = LAUNCHER_PANEL_NAMES[id];
  return {
    appName,
    question: `Test sent. Did ${appName} open?`,
    terminal: "Terminal",
    mayPrompt: false,
  };
}

/** A Test or a mark-tested call is in flight: the Test button waits. */
function testBusy(status: PanelStatus): boolean {
  return status.kind === "testing" || status.kind === "confirming";
}

/**
 * An app launcher's badge. `App not found` only when the service said so —
 * a Test answered `app-not-found`. Detection looks up a fixed list of
 * candidate bundle IDs, so a saved bundle it does not list (a typed
 * override) is not evidence the app is missing (wave-6 review).
 */
function appBadge(
  id: AppLauncherId,
  configs: LauncherConfigView | null,
  status: PanelStatus,
): LauncherBadge {
  const saved = configs?.[id] ?? null;
  if (saved === null) return "not-set-up";
  if (status.kind === "test-error" && status.error === "app-not-found") return "app-not-found";
  return saved.tested ? "tested" : "set-up";
}

/** The value an app panel's current choice would save, or `null` when nothing is chosen. */
function appChoiceValue(draft: AppDraft | null): string | null {
  if (draft === null) return null;
  return draft.kind === "detected" ? draft.bundleId : draft.text.trim();
}

/**
 * The choice an app panel shows before the owner touches it: the saved
 * bundle (a detected radio when installed, else the bundle ID field), or,
 * with nothing saved, the single detected app. Two or more matches
 * preselect nothing (D-19).
 */
function appBaseline(
  savedBundle: string | null,
  detected: readonly DetectedApp[],
): AppDraft | null {
  if (savedBundle !== null) {
    return detected.some((app) => app.bundleId === savedBundle)
      ? { kind: "detected", bundleId: savedBundle }
      : { kind: "override", text: savedBundle };
  }
  const only = detected.length === 1 ? detected[0] : undefined;
  return only === undefined ? null : { kind: "detected", bundleId: only.bundleId };
}

/**
 * A radio that is `aria-disabled` stays focusable but must not change: the
 * click's default (checking it) is cancelled, so the last-known choice stays
 * selected while the service is away.
 */
function blockClickWhen(disabled: boolean): ((event: MouseEvent) => void) | undefined {
  return disabled ? (event) => event.preventDefault() : undefined;
}

export interface LaunchersSettingsProps {
  readonly actions: LaunchersActions;
  readonly connection: ConnectionState;
  readonly now: number;
  /** The view's session; a standalone mount creates its own. */
  readonly session?: LaunchersSession | undefined;
}

export function LaunchersSettings({
  actions,
  connection,
  now,
  session: providedSession,
}: LaunchersSettingsProps): VNode {
  const [ownSession] = useState(createLaunchersSession);
  const session = providedSession ?? ownSession;
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const disconnected = connection.kind === "disconnected";

  function runDetect(): void {
    if (disconnected || session.detectPhase.value === "detecting") return;
    session.detectPhase.value = "detecting";
    void actions.detect().then((outcome) => {
      if (outcome.kind === "detected") {
        session.detection.value = outcome.detection;
        session.detectPhase.value = "idle";
      } else {
        session.detectPhase.value = "failed";
      }
    });
  }

  // The focus hand-off: consumed once, on whichever render first sees it.
  const focusRequested = launchersFocusRequested.value;
  useEffect(() => {
    if (!focusRequested) return;
    launchersFocusRequested.value = false;
    headingRef.current?.focus();
  }, [focusRequested]);

  // Detection runs by itself only the first time the section opens with no
  // prior detection (D-27); the saved configuration is re-read on each open
  // and whenever the service comes back. Both wait for a live connection, so
  // opening Settings while the service is still connecting does not spend
  // the one automatic detection on a request that cannot be answered.
  const live = connection.kind === "live";
  useEffect(() => {
    if (!live) return;
    void loadConfigs(session, actions);
    if (session.detection.value === null && !session.autoDetected) {
      session.autoDetected = true;
      runDetect();
    }
    // `actions` and `session` are stable for the life of the view.
  }, [live]);

  const detection = session.detection.value;
  const detectPhase = session.detectPhase.value;
  const configs = session.configs.value;
  const setUpCount =
    configs === null
      ? 0
      : [configs.antigravity, configs["claude-code"], configs["claude-desktop"]].filter(
          (config) => config !== null,
        ).length;

  return (
    <section className="ccc-settings-section ccc-projects-section">
      <div className="ccc-card-header">
        <h3 ref={headingRef} tabIndex={-1}>
          Launchers
        </h3>
      </div>
      <p className="ccc-state-body">
        Choose which apps open your projects, then test each one. Nothing is saved until you choose
        Save launcher.
      </p>
      {disconnected && (
        <div className="ccc-banner">
          <p className="ccc-state-heading">Service disconnected</p>
          <p className="ccc-state-body">Reconnect the service to detect, save or test launchers.</p>
        </div>
      )}
      <p className="ccc-list-meta">{`${setUpCount} of 3 launchers set up`}</p>
      <div className="ccc-manage-toolbar">
        <button
          type="button"
          className="ccc-connect-button"
          aria-disabled={disconnected || detectPhase === "detecting" ? "true" : undefined}
          onClick={() => runDetect()}
        >
          Detect apps
        </button>
      </div>
      <p role="status" className="ccc-launch-status">
        {detectPhase === "detecting" && "Detecting apps…"}
        {detectPhase !== "detecting" &&
          detection !== null &&
          `Detected ${formatRelativeTime(detection.detectedAt, now)}`}
        {detectPhase === "failed" && (
          <>
            {detection !== null && <br />}
            <span className="ccc-error-glyph" aria-hidden="true">
              ▲
            </span>
            <span>Couldn't detect apps.</span>
            <br />
            <span>Enter bundle IDs by hand, or choose Detect apps again.</span>
          </>
        )}
      </p>
      <AppLauncherPanel
        id="antigravity"
        actions={actions}
        session={session}
        now={now}
        disabled={disconnected}
      />
      <ClaudeCodePanel
        actions={actions}
        session={session}
        connection={connection}
        now={now}
        sampleDisplayPath={sampleDisplayPath()}
      />
      <AppLauncherPanel
        id="claude-desktop"
        actions={actions}
        session={session}
        now={now}
        disabled={disconnected}
      />
      <NoSetupPanel
        id="finder"
        actions={actions}
        session={session}
        now={now}
        disabled={disconnected}
      />
      <NoSetupPanel
        id="github"
        actions={actions}
        session={session}
        now={now}
        disabled={disconnected}
      />
    </section>
  );
}

interface PanelProps<Id extends LaunchAction> {
  readonly id: Id;
  readonly actions: LaunchersActions;
  readonly session: LaunchersSession;
  readonly now: number;
  /** The service is disconnected: last-known values, every control `aria-disabled`. */
  readonly disabled: boolean;
}

/** Finder and GitHub: nothing to set up, but each still has its Test step (RR-15). */
function NoSetupPanel({
  id,
  actions,
  session,
  now,
  disabled,
}: PanelProps<"finder" | "github">): VNode {
  const headingId = useId();
  const testButtonRef = useRef<HTMLButtonElement>(null);
  const status = session.status.value[id] ?? { kind: "idle" };
  const block: TestBlock = disabled ? "disconnected" : testBusy(status) ? "busy" : null;
  return (
    <section className="ccc-card ccc-launcher-panel" aria-labelledby={headingId}>
      <h4 id={headingId} className="ccc-section-label">
        {LAUNCHER_PANEL_NAMES[id]}
      </h4>
      {status.kind === "tested" && <LauncherStatusBadge badge="tested" />}
      <p className="ccc-state-body">{PANEL_DESCRIPTIONS[id]}</p>
      <TestLines automation={false} explanation={TEST_EXPLANATIONS[id]} />
      <div className="ccc-manage-toolbar">
        <TestLauncherButton
          appName={LAUNCHER_PANEL_NAMES[id]}
          block={block}
          buttonRef={testButtonRef}
          onTest={() => runLauncherTest(session, actions, id, null)}
        />
      </div>
      <PanelStatusLine id={id} status={status} now={now} copy={defaultTestCopy(id)} />
      <PanelFollowUps
        id={id}
        status={status}
        session={session}
        actions={actions}
        disabled={disabled}
        testButtonRef={testButtonRef}
      />
    </section>
  );
}

function detectionLines(id: AppLauncherId, detected: readonly DetectedApp[]): string[] {
  const app = LAUNCHER_PANEL_NAMES[id];
  if (detected.length === 0) {
    return [`${app} wasn't found on this Mac.`, "Install it, or enter its bundle ID below."];
  }
  if (detected.length === 1) return [`Found ${app}.`];
  return [`Found ${detected.length} apps that look like ${app}. Choose the one to use.`];
}

/** S6's Antigravity and Claude Desktop panels: choose a detected bundle, or type one. */
function AppLauncherPanel({
  id,
  actions,
  session,
  now,
  disabled,
}: PanelProps<AppLauncherId>): VNode {
  const headingId = useId();
  const groupName = useId();
  const chooseNoteId = useId();
  const overrideInputId = useId();
  const overrideErrorId = useId();
  const choiceErrorId = useId();
  const testButtonRef = useRef<HTMLButtonElement>(null);

  const appName = LAUNCHER_PANEL_NAMES[id];
  const detection = session.detection.value;
  const detected = detection?.apps[id] ?? [];
  const configs = session.configs.value;
  const savedBundle = configs?.[id]?.bundleId ?? null;
  const draft = session.appDrafts.value[id];
  const choice = draft ?? appBaseline(savedBundle, detected);
  const value = appChoiceValue(choice);
  const dirty = value !== savedBundle && choice !== null;
  const status = session.status.value[id] ?? { kind: "idle" };
  const saveError = session.saveErrors.value[id];
  const saving = status.kind === "saving";
  const canSave = choice !== null && !saving && !disabled;
  const testBlock: TestBlock = disabled
    ? "disconnected"
    : savedBundle === null || dirty
      ? "save-first"
      : testBusy(status)
        ? "busy"
        : null;

  function setDraft(next: AppDraft | null): void {
    if (disabled) return;
    const drafts = { ...session.appDrafts.value };
    if (next === null) delete drafts[id];
    else drafts[id] = next;
    session.appDrafts.value = drafts;
    setSaveError(session, id, null);
    if (status.kind !== "idle" && !saving && !testBusy(status)) {
      setPanelStatus(session, id, { kind: "idle" });
    }
  }

  function save(): void {
    if (!canSave || value === null) return;
    if (!BundleIdSchema.safeParse(value).success) {
      setSaveError(session, id, { kind: "invalid-bundle" });
      return;
    }
    setSaveError(session, id, null);
    setPanelStatus(session, id, { kind: "saving" });
    // The draft this save sends; an edit made while it runs is the owner's
    // next change and must survive the save (wave-6 review).
    const draftAtSave = session.appDrafts.value[id];
    void actions.save({ launcherId: id, bundleId: value }).then((outcome) => {
      switch (outcome.kind) {
        case "saved":
          setPanelStatus(session, id, { kind: "saved" });
          void loadConfigs(session, actions).then((applied) => {
            if (!applied || session.appDrafts.value[id] !== draftAtSave) return;
            const drafts = { ...session.appDrafts.value };
            delete drafts[id];
            session.appDrafts.value = drafts;
          });
          return;
        case "refused":
          setPanelStatus(session, id, { kind: "idle" });
          setSaveError(session, id, {
            kind: "refused",
            reason: outcome.reason,
            index: outcome.index,
            template: outcome.template,
          });
          return;
        default:
          setPanelStatus(session, id, { kind: "save-failed" });
          // An uncertain outcome (a timeout, a dropped connection) may still
          // have stored: re-read what the service holds; the draft stays
          // (codex review 3, finding 4).
          void loadConfigs(session, actions);
      }
    });
  }

  const overrideChosen = choice?.kind === "override";
  const overrideInvalid = saveError?.kind === "invalid-bundle";
  const notFound = saveError?.kind === "refused" && saveError.reason === "bundle-not-found";
  const otherRefusal = saveError?.kind === "refused" && !notFound;
  const lines = detection === null ? [] : detectionLines(id, detected);
  const ariaDisabled = disabled ? "true" : undefined;

  return (
    <section className="ccc-card ccc-launcher-panel" aria-labelledby={headingId}>
      <h4 id={headingId} className="ccc-section-label">
        {appName}
      </h4>
      <LauncherStatusBadge badge={appBadge(id, configs, status)} />
      <p className="ccc-state-body">{PANEL_DESCRIPTIONS[id]}</p>
      {lines.map((line) => (
        <p key={line} className="ccc-list-meta">
          {line}
        </p>
      ))}
      <fieldset className="ccc-radio-group" aria-describedby={notFound ? choiceErrorId : undefined}>
        <legend className="ccc-field-label">{`Which ${appName}?`}</legend>
        {detected.map((app) => (
          <label key={app.bundleId}>
            <input
              type="radio"
              name={groupName}
              aria-disabled={ariaDisabled}
              checked={choice?.kind === "detected" && choice.bundleId === app.bundleId}
              onClick={blockClickWhen(disabled)}
              onChange={() => setDraft({ kind: "detected", bundleId: app.bundleId })}
            />{" "}
            <span>{app.name}</span> <span className="ccc-display-path">{app.bundleId}</span>{" "}
            <span className="ccc-list-meta">{LOCATION_COPY[app.location]}</span>
          </label>
        ))}
        <label>
          <input
            type="radio"
            name={groupName}
            aria-disabled={ariaDisabled}
            checked={overrideChosen}
            onClick={blockClickWhen(disabled)}
            onChange={() =>
              setDraft({
                kind: "override",
                text: choice?.kind === "override" ? choice.text : "",
              })
            }
          />{" "}
          Use a different bundle ID
        </label>
      </fieldset>
      {overrideChosen && (
        <div className="ccc-inline-form">
          <label className="ccc-field-label" htmlFor={overrideInputId}>
            Bundle ID
          </label>
          <input
            id={overrideInputId}
            type="text"
            className="ccc-text-input ccc-text-input--mono"
            placeholder="com.example.app"
            spellcheck={false}
            autocomplete="off"
            value={choice.text}
            readOnly={disabled}
            aria-disabled={ariaDisabled}
            aria-invalid={overrideInvalid || notFound ? "true" : undefined}
            aria-describedby={overrideInvalid || notFound ? overrideErrorId : undefined}
            onInput={(event) => setDraft({ kind: "override", text: event.currentTarget.value })}
          />
          {(overrideInvalid || notFound) && (
            <FieldError
              id={overrideErrorId}
              text={
                overrideInvalid
                  ? "Enter a bundle ID like com.example.app."
                  : "No installed app has this bundle ID."
              }
            />
          )}
        </div>
      )}
      {!overrideChosen && notFound && (
        <FieldError id={choiceErrorId} text="No installed app has this bundle ID." />
      )}
      {otherRefusal && <FieldError text="Enter a bundle ID like com.example.app." />}
      <TestLines automation={false} explanation={TEST_EXPLANATIONS[id]} />
      <div className="ccc-manage-toolbar">
        <button
          type="button"
          className="ccc-connect-button"
          aria-disabled={canSave ? undefined : "true"}
          aria-describedby={choice === null ? chooseNoteId : undefined}
          onClick={save}
        >
          Save launcher
        </button>
        {choice === null && (
          <span id={chooseNoteId} className="ccc-visually-hidden">
            Choose an app first
          </span>
        )}
        <TestLauncherButton
          appName={appName}
          block={testBlock}
          buttonRef={testButtonRef}
          onTest={() => runLauncherTest(session, actions, id, null)}
        />
        {dirty && <span className="ccc-list-meta">Unsaved changes</span>}
        {draft !== undefined && dirty && (
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
      <PanelStatusLine id={id} status={status} now={now} copy={defaultTestCopy(id)} />
      <PanelFollowUps
        id={id}
        status={status}
        session={session}
        actions={actions}
        disabled={disabled}
        testButtonRef={testButtonRef}
      />
    </section>
  );
}
