import { type Signal, signal } from "@preact/signals";
import type { VNode } from "preact";
import { useCallback, useEffect, useId, useRef, useState } from "preact/hooks";
import type { ConnectionState } from "../connection-state.js";
import type { FolderPick, PickFolderOptions } from "../projects/folder-picker.js";
import type { LaunchersActions } from "../projects/launchers-actions.js";
import type { ProjectsActions, ScanActions } from "../projects/projects-actions.js";
import { type LaunchersSession, LaunchersSettings } from "./launchers-settings.js";
import { ApprovalsTasksSettings } from "./settings-approvals-tasks.js";
import { StatusLine } from "./settings-controls.js";
import type { SettingsHost } from "./settings-host.js";
import { ProjectsSettings } from "./settings-projects.js";
import {
  SETTINGS_SECTION_LABELS,
  SETTINGS_SECTIONS,
  type SettingsSectionId,
  settingsSectionRequested,
  takeSettingsSectionRequest,
} from "./settings-sections.js";
import { VisualSettings } from "./settings-visual.js";

/**
 * The command center's own Settings destination (plan 08-11, D-15, 08-UI-SPEC S1, R-01, R-02).
 *
 * One frame for nine sections: the `Settings` heading, a one-sentence description, ONE polite
 * status line, a `Settings sections` nav and the active section. One section renders at a time
 * (Projects and Launchers are heavy, and "every section" stays enumerable). The nav is a `nav`
 * of buttons with `aria-current="page"`, not a `tablist`: the destination is already a tabpanel.
 *
 * Keyboard (R-02): the nav is ONE tab stop. The active item carries `tabindex="0"` and the rest
 * `-1`; the arrow keys move focus between items without activating, Home and End jump, and
 * Enter or Space (a button's click) activates, which shows the section and moves focus to its
 * `h3` (`tabindex="-1"`), so Shift+Tab from the heading returns to the active item.
 *
 * Deep links: `requestSettingsSection(id)` (setup actions, the native tab's pointer row,
 * `requestLaunchersFocus()`) sets a one-shot signal that this component consumes once, on mount
 * and on change, activating that section and focusing its heading. A plain switch to the Settings
 * tab leaves the signal `null`, so it never moves focus. An id with no entry in
 * {@link SECTION_VIEWS} is consumed and ignored, exactly like an unknown id.
 */

/** What every section view receives. */
export interface SettingsSectionProps {
  readonly host: SettingsHost;
  readonly connection: ConnectionState;
  readonly now: number;
  /** Posts an outcome to the destination's one status line (R-17); the only live region. */
  readonly notify: (message: string) => void;
  readonly launchersActions: LaunchersActions;
  readonly launchersSession: LaunchersSession;
  /** The Projects destination's own bound actions, shared with the Projects section. */
  readonly projectsActions: ProjectsActions;
  readonly scanActions: ScanActions;
  readonly pickFolder: (options: PickFolderOptions) => Promise<FolderPick>;
}

export type SettingsSectionView = (props: SettingsSectionProps) => VNode;

/**
 * The sections that exist, keyed by id. The nav renders exactly the ids that have an entry here,
 * in the fixed {@link SETTINGS_SECTIONS} order; 08-13 (Diagnostics), 08-15 (Integrations,
 * Security) and 08-18 (Paths, Schedules) each add theirs. Every nav item is a real section.
 */
export const SECTION_VIEWS: Partial<Record<SettingsSectionId, SettingsSectionView>> = {
  projects: ({ connection, now, notify, projectsActions, scanActions, pickFolder }) => (
    <ProjectsSettings
      connection={connection}
      now={now}
      notify={notify}
      projectsActions={projectsActions}
      scanActions={scanActions}
      pickFolder={pickFolder}
    />
  ),
  "approvals-tasks": ({ host, connection, notify }) => (
    <ApprovalsTasksSettings host={host} connection={connection} notify={notify} />
  ),
  visual: ({ host, notify }) => <VisualSettings host={host} notify={notify} />,
  launchers: ({ connection, now, notify, launchersActions, launchersSession }) => (
    <LaunchersSettings
      actions={launchersActions}
      connection={connection}
      now={now}
      session={launchersSession}
      announce={notify}
    />
  ),
};

/** The sections that have a view, in nav order. */
function registeredSections(): SettingsSectionId[] {
  return SETTINGS_SECTIONS.filter((id) => SECTION_VIEWS[id] !== undefined);
}

/**
 * The last-visited section, held for the life of one command-center view (like the Launchers
 * session): leaving Settings and coming back finds the same section. Memory only, never
 * `data.json` (R-01).
 */
export interface SettingsSession {
  readonly section: Signal<SettingsSectionId | null>;
}

export function createSettingsSession(): SettingsSession {
  return { section: signal<SettingsSectionId | null>(null) };
}

export interface SettingsDestinationProps {
  readonly settingsHost: SettingsHost;
  readonly settingsSession?: SettingsSession | undefined;
  readonly launchersActions: LaunchersActions;
  readonly launchersSession: LaunchersSession;
  readonly projectsActions: ProjectsActions;
  /** Absent in a partial composition: the Projects section then resolves `failed` for every scan. */
  readonly scanActions?: ScanActions | undefined;
  readonly pickFolder: (options: PickFolderOptions) => Promise<FolderPick>;
  readonly connection: ConnectionState;
  readonly now: number;
}

/** How long the status line stays empty before a repeated identical message is set again. */
const REPEAT_GAP_MS = 60;

/** Resolves `failed` for every scan action, so the section renders honestly without a host. */
const FAILED_SCAN = (): Promise<{ kind: "failed" }> => Promise.resolve({ kind: "failed" });
const NO_SCAN_ACTIONS: ScanActions = {
  addScanRoot: FAILED_SCAN,
  removeScanRoot: FAILED_SCAN,
  rescan: FAILED_SCAN,
  listScanState: FAILED_SCAN,
  registerSuggestion: FAILED_SCAN,
  dismissSuggestion: FAILED_SCAN,
  suggestionsPage: FAILED_SCAN,
};

/** Where the destination starts: a pending deep link, else the last visit, else the first section. */
function initialSection(session: SettingsSession | undefined): SettingsSectionId {
  const available = registeredSections();
  const pending = settingsSectionRequested.peek();
  if (pending !== null && available.includes(pending)) return pending;
  const last = session?.section.peek() ?? null;
  if (last !== null && available.includes(last)) return last;
  return available[0] ?? "projects";
}

/** Arrow-key movement target for the nav, or `null` for a key the nav does not handle. */
function navTarget(key: string, index: number, count: number): number | null {
  switch (key) {
    case "ArrowDown":
    case "ArrowRight":
      return (index + 1) % count;
    case "ArrowUp":
    case "ArrowLeft":
      return (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

export function SettingsDestination({
  settingsHost,
  settingsSession,
  launchersActions,
  launchersSession,
  projectsActions,
  scanActions = NO_SCAN_ACTIONS,
  pickFolder,
  connection,
  now,
}: SettingsDestinationProps): VNode {
  const headingId = useId();
  const [activeId, setActiveId] = useState<SettingsSectionId>(() =>
    initialSection(settingsSession),
  );
  const [focusTick, setFocusTick] = useState(0);
  const [status, setStatus] = useState("");
  // The words on the status line now, and a counter that voids a message still waiting to be set
  // when the owner has already moved on (a section change clears the line).
  const shownRef = useRef("");
  const epochRef = useRef(0);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Partial<Record<SettingsSectionId, HTMLButtonElement | null>>>({});

  const sections = registeredSections();

  // The ONE way a section speaks (FIX2B M1, m1). A live region announces a CHANGE, so a message
  // identical to the one on the line would be silent. It is cleared first and set again after a
  // beat: the gap has to cross a task (and a frame), because two DOM changes made in one task
  // reach assistive technology as no change at all.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPending = useCallback((): void => {
    epochRef.current += 1;
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);
  useEffect(() => cancelPending, [cancelPending]);

  const notify = useCallback(
    (message: string): void => {
      cancelPending();
      if (message === shownRef.current && message !== "") {
        const epoch = epochRef.current;
        shownRef.current = "";
        setStatus("");
        timerRef.current = setTimeout(() => {
          if (epochRef.current !== epoch) return;
          timerRef.current = null;
          shownRef.current = message;
          setStatus(message);
        }, REPEAT_GAP_MS);
        return;
      }
      shownRef.current = message;
      setStatus(message);
    },
    [cancelPending],
  );

  const activate = useCallback(
    (id: SettingsSectionId): void => {
      // A new section starts with a quiet line: the previous section's outcome is not its own.
      cancelPending();
      shownRef.current = "";
      setStatus("");
      setActiveId(id);
      if (settingsSession !== undefined) settingsSession.section.value = id;
      setFocusTick((tick) => tick + 1);
    },
    [settingsSession, cancelPending],
  );

  // A deep link: consumed once (the read clears it), on mount and whenever one arrives. The
  // value is read during render so a change re-runs the effect; an id with no view is consumed
  // and ignored so it cannot fire later when that section appears.
  const requested = settingsSectionRequested.value;
  useEffect(() => {
    if (requested === null) return;
    const id = takeSettingsSectionRequest();
    if (id !== null && SECTION_VIEWS[id] !== undefined) activate(id);
  }, [requested, activate]);

  // Focus follows an activation or a deep link, never a plain tab switch (focusTick stays 0).
  useEffect(() => {
    if (focusTick === 0) return;
    contentRef.current?.querySelector<HTMLElement>('h3[tabindex="-1"]')?.focus();
  }, [focusTick]);

  function onNavKeyDown(event: KeyboardEvent, index: number): void {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const target = navTarget(event.key, index, sections.length);
    if (target === null) return;
    event.preventDefault();
    const id = sections[target];
    if (id !== undefined) itemRefs.current[id]?.focus();
  }

  const SectionView = SECTION_VIEWS[activeId];

  return (
    <section className="ccc-settings" aria-labelledby={headingId}>
      <div className="ccc-settings-header">
        <h2 id={headingId} tabIndex={-1}>
          Settings
        </h2>
        <p>Plugin configuration and diagnostics.</p>
        {/* The destination's one live region: present before its first message, it announces
            setting-save, copy, check, rebuild and bundle outcomes, never a section change. */}
        <StatusLine message={status} />
      </div>
      <div className="ccc-settings-layout">
        <nav className="ccc-settings-nav" aria-label="Settings sections">
          <ul>
            {sections.map((id, index) => (
              <li key={id}>
                <button
                  type="button"
                  className="ccc-settings-nav-item"
                  ref={(element) => {
                    itemRefs.current[id] = element;
                  }}
                  aria-current={id === activeId ? "page" : undefined}
                  tabIndex={id === activeId ? 0 : -1}
                  onClick={() => activate(id)}
                  onKeyDown={(event) => onNavKeyDown(event, index)}
                >
                  {SETTINGS_SECTION_LABELS[id]}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="ccc-settings-content" ref={contentRef}>
          {SectionView === undefined ? null : (
            <SectionView
              host={settingsHost}
              connection={connection}
              now={now}
              notify={notify}
              launchersActions={launchersActions}
              launchersSession={launchersSession}
              projectsActions={projectsActions}
              scanActions={scanActions}
              pickFolder={pickFolder}
            />
          )}
        </div>
      </div>
    </section>
  );
}
