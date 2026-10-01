import type {
  DetectedApp,
  DetectionResponse,
  LaunchAction,
  LauncherConfigView,
  RefusedTemplate,
  TemplateRefusalReason,
} from "@ccc/domain";
import { BundleIdSchema } from "@ccc/domain";
import { type Signal, signal } from "@preact/signals";
import type { VNode } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import type { ConnectionState } from "../connection-state.js";
import type { LaunchersActions } from "../projects/launchers-actions.js";
import { formatRelativeTime } from "../widgets/relative-time.js";
import { launchersFocusRequested } from "./launchers-focus.js";

export { requestLaunchersFocus } from "./launchers-focus.js";

/**
 * The S6 Launchers section of the command center's own Settings destination
 * (D-37, plan 04-12). Detection proposes; only the owner's explicit
 * `Save launcher` sends anything to the service (D-27). Drafts live in a
 * {@link LaunchersSession} — memory only, for the life of the view (RR-25)
 * — and are never written to plugin settings, `data.json` or the vault
 * (D-43).
 */

/** The two launchers configured by choosing an installed app (D-19). */
export type AppLauncherId = "antigravity" | "claude-desktop";

/** The owner's in-progress choice for an app launcher. */
export type AppDraft =
  | { readonly kind: "detected"; readonly bundleId: string }
  | { readonly kind: "override"; readonly text: string };

/** What a panel's persistent status line says (UI-SPEC S6). */
export type PanelStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "saving" }
  | { readonly kind: "saved" }
  | { readonly kind: "save-failed" };

/** A save problem shown under the field it is about, not in the status line. */
export type SaveError =
  | { readonly kind: "invalid-bundle" }
  | {
      readonly kind: "refused";
      readonly reason: TemplateRefusalReason;
      readonly index: number | null;
      readonly template?: RefusedTemplate | undefined;
    };

/**
 * Everything the Launchers section knows, held by the view (the Shell
 * creates one per command-center view): leaving Settings and coming back
 * keeps the detection, the drafts and any in-flight result. Memory only.
 */
export interface LaunchersSession {
  readonly detection: Signal<DetectionResponse | null>;
  readonly detectPhase: Signal<"idle" | "detecting" | "failed">;
  readonly configs: Signal<LauncherConfigView | null>;
  readonly appDrafts: Signal<Partial<Record<AppLauncherId, AppDraft>>>;
  readonly status: Signal<Partial<Record<LaunchAction, PanelStatus>>>;
  readonly saveErrors: Signal<Partial<Record<LaunchAction, SaveError>>>;
  /** Set once detection has been started automatically, so a failure is not retried on every open. */
  autoDetected: boolean;
}

export function createLaunchersSession(): LaunchersSession {
  return {
    detection: signal(null),
    detectPhase: signal("idle"),
    configs: signal(null),
    appDrafts: signal({}),
    status: signal({}),
    saveErrors: signal({}),
    autoDetected: false,
  };
}

function setStatus(session: LaunchersSession, id: LaunchAction, status: PanelStatus): void {
  session.status.value = { ...session.status.value, [id]: status };
}

function setSaveError(session: LaunchersSession, id: LaunchAction, error: SaveError | null): void {
  const next = { ...session.saveErrors.value };
  if (error === null) delete next[id];
  else next[id] = error;
  session.saveErrors.value = next;
}

/** The fixed panel names (UI-SPEC S6 h4 copy). */
export const LAUNCHER_PANEL_NAMES: Readonly<Record<LaunchAction, string>> = {
  antigravity: "Antigravity",
  "claude-code": "Claude Code",
  "claude-desktop": "Claude Desktop",
  finder: "Finder",
  github: "GitHub",
};

const PANEL_DESCRIPTIONS: Readonly<Record<LaunchAction, string>> = {
  antigravity: "Opens a project folder in Antigravity.",
  "claude-code": "Starts a new Claude Code session in a terminal window at the project folder.",
  "claude-desktop": "Brings Claude Desktop to the front.",
  finder: "Reveals a project folder in Finder. Nothing to set up.",
  github: "Opens a project's GitHub page in your default browser. Nothing to set up.",
};

const LOCATION_COPY: Readonly<Record<DetectedApp["location"], string>> = {
  applications: "In Applications",
  "user-applications": "In your Applications folder",
  other: "Elsewhere on this Mac",
};

/** A launcher's S6 status badge. */
export type LauncherBadge = "not-set-up" | "set-up" | "tested" | "app-not-found";

const BADGE_GLYPH: Readonly<Record<LauncherBadge, string>> = {
  "not-set-up": "◌",
  "set-up": "◆",
  tested: "✓",
  "app-not-found": "▲",
};

const BADGE_TEXT: Readonly<Record<LauncherBadge, string>> = {
  "not-set-up": "Not set up",
  "set-up": "Set up",
  tested: "Tested",
  "app-not-found": "App not found",
};

export function LauncherStatusBadge({ badge }: { readonly badge: LauncherBadge }): VNode {
  return (
    <span className="ccc-badge" data-launcher-badge={badge}>
      <span
        className={badge === "app-not-found" ? "ccc-error-glyph" : "ccc-meta-glyph"}
        aria-hidden="true"
      >
        {BADGE_GLYPH[badge]}
      </span>{" "}
      {BADGE_TEXT[badge]}
    </span>
  );
}

function appBadge(
  id: AppLauncherId,
  configs: LauncherConfigView | null,
  detection: DetectionResponse | null,
): LauncherBadge {
  const saved = configs?.[id] ?? null;
  if (saved === null) return "not-set-up";
  if (detection !== null && !detection.apps[id].some((app) => app.bundleId === saved.bundleId)) {
    return "app-not-found";
  }
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
  const connected = connection.kind !== "disconnected";

  function runDetect(): void {
    if (session.detectPhase.value === "detecting") return;
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

  function loadConfigs(): void {
    void actions.getConfigs().then((outcome) => {
      if (outcome.kind === "loaded") session.configs.value = outcome.configs;
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
  // prior detection (D-27); the saved configuration is re-read on each open.
  useEffect(() => {
    if (!connected) return;
    loadConfigs();
    if (session.detection.value === null && !session.autoDetected) {
      session.autoDetected = true;
      runDetect();
    }
    // `actions` and `session` are stable for the life of the view.
  }, [connected]);

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
      <p className="ccc-list-meta">{`${setUpCount} of 3 launchers set up`}</p>
      <div className="ccc-manage-toolbar">
        <button
          type="button"
          className="ccc-connect-button"
          aria-disabled={detectPhase === "detecting" ? "true" : undefined}
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
      <AppLauncherPanel id="antigravity" actions={actions} session={session} />
      <PlaceholderPanel
        id="claude-code"
        badge={configs?.["claude-code"] ? "set-up" : "not-set-up"}
      />
      <AppLauncherPanel id="claude-desktop" actions={actions} session={session} />
      <PlaceholderPanel id="finder" badge={null} />
      <PlaceholderPanel id="github" badge={null} />
    </section>
  );
}

function PlaceholderPanel({
  id,
  badge,
}: {
  readonly id: LaunchAction;
  readonly badge: LauncherBadge | null;
}): VNode {
  const headingId = useId();
  return (
    <section className="ccc-card ccc-launcher-panel" aria-labelledby={headingId}>
      <h4 id={headingId} className="ccc-field-label">
        {LAUNCHER_PANEL_NAMES[id]}
      </h4>
      {badge !== null && <LauncherStatusBadge badge={badge} />}
      <p className="ccc-state-body">{PANEL_DESCRIPTIONS[id]}</p>
    </section>
  );
}

interface AppLauncherPanelProps {
  readonly id: AppLauncherId;
  readonly actions: LaunchersActions;
  readonly session: LaunchersSession;
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
function AppLauncherPanel({ id, actions, session }: AppLauncherPanelProps): VNode {
  const headingId = useId();
  const groupName = useId();
  const chooseNoteId = useId();
  const overrideInputId = useId();
  const overrideErrorId = useId();
  const choiceErrorId = useId();

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
  const canSave = choice !== null && !saving;

  function setDraft(next: AppDraft | null): void {
    const drafts = { ...session.appDrafts.value };
    if (next === null) delete drafts[id];
    else drafts[id] = next;
    session.appDrafts.value = drafts;
    setSaveError(session, id, null);
    if (status.kind === "saved" || status.kind === "save-failed") {
      setStatus(session, id, { kind: "idle" });
    }
  }

  function save(): void {
    if (!canSave || value === null) return;
    if (!BundleIdSchema.safeParse(value).success) {
      setSaveError(session, id, { kind: "invalid-bundle" });
      return;
    }
    setSaveError(session, id, null);
    setStatus(session, id, { kind: "saving" });
    void actions.save({ launcherId: id, bundleId: value }).then((outcome) => {
      switch (outcome.kind) {
        case "saved":
          setStatus(session, id, { kind: "saved" });
          void actions.getConfigs().then((loaded) => {
            if (loaded.kind !== "loaded") return;
            session.configs.value = loaded.configs;
            const drafts = { ...session.appDrafts.value };
            delete drafts[id];
            session.appDrafts.value = drafts;
          });
          return;
        case "refused":
          setStatus(session, id, { kind: "idle" });
          setSaveError(session, id, {
            kind: "refused",
            reason: outcome.reason,
            index: outcome.index,
            template: outcome.template,
          });
          return;
        default:
          setStatus(session, id, { kind: "save-failed" });
      }
    });
  }

  const overrideChosen = choice?.kind === "override";
  const overrideInvalid = saveError?.kind === "invalid-bundle";
  const notFound = saveError?.kind === "refused" && saveError.reason === "bundle-not-found";
  const otherRefusal = saveError?.kind === "refused" && !notFound;
  const lines = detection === null ? [] : detectionLines(id, detected);

  return (
    <section className="ccc-card ccc-launcher-panel" aria-labelledby={headingId}>
      <h4 id={headingId} className="ccc-field-label">
        {appName}
      </h4>
      <LauncherStatusBadge badge={appBadge(id, configs, detection)} />
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
              checked={choice?.kind === "detected" && choice.bundleId === app.bundleId}
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
            checked={overrideChosen}
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
            value={choice.text}
            aria-invalid={overrideInvalid || notFound ? "true" : undefined}
            aria-describedby={overrideInvalid || notFound ? overrideErrorId : undefined}
            onInput={(event) => setDraft({ kind: "override", text: event.currentTarget.value })}
          />
          {(overrideInvalid || notFound) && (
            <p id={overrideErrorId} className="ccc-field-error">
              <span className="ccc-error-glyph" aria-hidden="true">
                ▲
              </span>
              {overrideInvalid
                ? "Enter a bundle ID like com.example.app."
                : "No installed app has this bundle ID."}
            </p>
          )}
        </div>
      )}
      {!overrideChosen && notFound && (
        <p id={choiceErrorId} className="ccc-field-error">
          <span className="ccc-error-glyph" aria-hidden="true">
            ▲
          </span>
          No installed app has this bundle ID.
        </p>
      )}
      {otherRefusal && (
        <p className="ccc-field-error">
          <span className="ccc-error-glyph" aria-hidden="true">
            ▲
          </span>
          Enter a bundle ID like com.example.app.
        </p>
      )}
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
        {dirty && <span className="ccc-list-meta">Unsaved changes</span>}
        {draft !== undefined && dirty && (
          <button type="button" className="ccc-list-more" onClick={() => setDraft(null)}>
            Discard changes
          </button>
        )}
      </div>
      <PanelStatusLine status={status} />
    </section>
  );
}

function PanelStatusLine({ status }: { readonly status: PanelStatus }): VNode {
  const tone =
    status.kind === "save-failed" ? "error" : status.kind === "saved" ? "success" : undefined;
  return (
    <p role="status" className="ccc-launch-status" data-tone={tone}>
      {status.kind === "saving" && "Saving…"}
      {status.kind === "saved" && (
        <>
          <span className="ccc-meta-glyph" aria-hidden="true">
            ✓
          </span>{" "}
          Saved
        </>
      )}
      {status.kind === "save-failed" && (
        <>
          <span className="ccc-error-glyph" aria-hidden="true">
            ▲
          </span>
          Couldn't save launcher settings.
          <br />
          Check the service in Settings → Diagnostics, then try again.
        </>
      )}
    </p>
  );
}
