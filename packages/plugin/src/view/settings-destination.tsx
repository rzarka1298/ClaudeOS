import { type Signal, signal } from "@preact/signals";
import type { VNode } from "preact";
import { useCallback, useEffect, useId, useRef, useState } from "preact/hooks";
import type { ConnectionState } from "../connection-state.js";
import type { LaunchersActions } from "../projects/launchers-actions.js";
import { type LaunchersSession, LaunchersSettings } from "./launchers-settings.js";
import type { SettingsHost } from "./settings-host.js";
import {
  SETTINGS_SECTION_LABELS,
  SETTINGS_SECTIONS,
  type SettingsSectionId,
  settingsSectionRequested,
  takeSettingsSectionRequest,
} from "./settings-sections.js";

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
}

export type SettingsSectionView = (props: SettingsSectionProps) => VNode;

/**
 * The sections that exist, keyed by id. The nav renders exactly the ids that have an entry here,
 * in the fixed {@link SETTINGS_SECTIONS} order; 08-13 (Diagnostics), 08-15 (Integrations,
 * Security) and 08-18 (Paths, Schedules) each add theirs. Every nav item is a real section.
 */
export const SECTION_VIEWS: Partial<Record<SettingsSectionId, SettingsSectionView>> = {
  projects: () => <ProjectsSection />,
  launchers: ({ connection, now, launchersActions, launchersSession }) => (
    <LaunchersSettings
      actions={launchersActions}
      connection={connection}
      now={now}
      session={launchersSession}
    />
  ),
};

function ProjectsSection(): VNode {
  return (
    <section className="ccc-settings-section">
      <h3 tabIndex={-1}>Projects</h3>
      <p>Register project folders and choose folders to scan for projects.</p>
    </section>
  );
}

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
  readonly connection: ConnectionState;
  readonly now: number;
}

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
  connection,
  now,
}: SettingsDestinationProps): VNode {
  const headingId = useId();
  const [activeId, setActiveId] = useState<SettingsSectionId>(() =>
    initialSection(settingsSession),
  );
  const [focusTick, setFocusTick] = useState(0);
  const [status, setStatus] = useState("");
  const contentRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Partial<Record<SettingsSectionId, HTMLButtonElement | null>>>({});

  const sections = registeredSections();

  const activate = useCallback(
    (id: SettingsSectionId): void => {
      setActiveId(id);
      if (settingsSession !== undefined) settingsSession.section.value = id;
      setFocusTick((tick) => tick + 1);
    },
    [settingsSession],
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
        <p className="ccc-settings-status" role="status">
          {status}
        </p>
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
              notify={setStatus}
              launchersActions={launchersActions}
              launchersSession={launchersSession}
            />
          )}
        </div>
      </div>
    </section>
  );
}
