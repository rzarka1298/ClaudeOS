/**
 * The Settings cells of the visual harness (plan 08-21; Phase 8 UI-SPEC "Contrast pages" and
 * "Visual regression and fixtures", ADR-0023).
 *
 *   index.html?view=settings&case=settings-security&width=full&host=light
 *
 * Every cell mounts the REAL `SettingsDestination` from `@ccc/plugin` against the production
 * stylesheet, with an inert `SettingsHost` whose seams answer from the synthetic
 * `settings-fixtures.json`, the real health holder fed by a resolving `get`, and the frozen fixture
 * `now`. The destination decides what each section draws; this module only hands it the host and
 * the connection, so a baseline regresses when the shipped markup, copy or CSS does and not when a
 * copy of it drifts.
 *
 * PRIVACY (PRIV-04 layer 1, T-03-03, T-08-52). This module may import exactly three modules:
 * `preact`, `@ccc/plugin` and the synthetic `settings-fixtures.json` (plus the tolerated signals
 * package). `src/harness-purity.test.ts` enforces that set by source scan, and
 * `src/phase8-fixtures.test.ts` pins what the fixture file may say. Every value on screen therefore
 * comes from that fixture file or from a literal in this file. No cell reaches a socket: the seams
 * answer from memory. The bundle export port is left unconfigured, so `Save bundle` reads as
 * unavailable and no file can be written (08-16); `health/wiring.ts` is not in this graph.
 *
 * DETERMINISM. `now` is the fixture's own frozen `now`. Pane widths are fixed boxes (the narrow
 * pane is 24rem, the full pane 64rem): test infrastructure, not plugin code, so the plugin's "no
 * inline style" rule does not apply. The document is marked ready only once the state the case
 * names is on screen and has stayed there for a few beats.
 */

import type {
  ConnectionState,
  HealthApi,
  LaunchersActions,
  ProjectsActions,
  ResearchStatusResponse,
  ScanActions,
  SettingsHost,
} from "@ccc/plugin";
import {
  configureHealth,
  configureResearch,
  connectionState,
  createInertSettingsHost,
  createLaunchersSession,
  createSettingsSession,
  DestinationTabs,
  motionMode,
  SettingsDestination,
} from "@ccc/plugin";
import type { VNode } from "preact";
import fixtureFile from "./settings-fixtures.json";

// ---------------------------------------------------------------------------
// The fixture file's shape. Declared here rather than inferred so the cells read named fields,
// not a deep JSON literal union.
// ---------------------------------------------------------------------------

type Integration<K extends "claude" | "codex"> = Awaited<
  ReturnType<SettingsHost[K]["getIntegration"]>
>;
type Detection = Extract<
  Awaited<ReturnType<LaunchersActions["detect"]>>,
  { kind: "detected" }
>["detection"];
type Configs = Extract<
  Awaited<ReturnType<LaunchersActions["getConfigs"]>>,
  { kind: "loaded" }
>["configs"];
type ScanOutcome = Awaited<ReturnType<ScanActions["listScanState"]>>;
type ScanState = Extract<ScanOutcome, { kind: "state" }>["state"];
type HealthAnswer = Awaited<ReturnType<HealthApi["get"]>>;

interface FixtureFile {
  readonly now: string;
  readonly display: SettingsHost["display"];
  readonly claude: Integration<"claude">;
  readonly codex: Integration<"codex">;
  readonly research: ResearchStatusResponse;
  readonly detection: Detection;
  readonly configs: Configs;
  readonly scan: ScanState;
  readonly health: HealthAnswer;
}

export const SETTINGS_FIXTURES = fixtureFile as unknown as FixtureFile;
export const NOW = Date.parse(SETTINGS_FIXTURES.now);

export const LIVE: ConnectionState = { kind: "live" };
export const DISCONNECTED: ConnectionState = {
  kind: "disconnected",
  reason: "connect ECONNREFUSED",
};

/** The two pane widths every cell renders at (UI-SPEC: narrow <= 24rem, full >= 64rem). */
export const PANE_WIDTH = { narrow: "24rem", full: "64rem" } as const;
export type Width = keyof typeof PANE_WIDTH;

export function isWidth(value: string): value is Width {
  return Object.hasOwn(PANE_WIDTH, value);
}

/** The nine sections, in nav order. */
const SECTIONS = [
  "projects",
  "launchers",
  "integrations",
  "approvals-tasks",
  "paths",
  "visual",
  "security",
  "schedules",
  "diagnostics",
] as const;
export type SectionId = (typeof SECTIONS)[number];

export function isSection(value: string): value is SectionId {
  return (SECTIONS as readonly string[]).includes(value);
}

/** What must be on screen (inside the section content) before the document is ready. */
const SECTION_EXPECTS: Readonly<Record<SectionId, readonly string[]>> = {
  projects: ["ExampleProjects"],
  launchers: ["Detected"],
  integrations: ["Claude Code hooks"],
  "approvals-tasks": ["Rebuild task index"],
  paths: ["~/ExampleVault"],
  visual: ["Reduced motion"],
  security: ["Present", "Approval presence check", "Unavailable"],
  schedules: ["sources configured"],
  diagnostics: ["Subsystems"],
};

export function HarnessError({ message }: { readonly message: string }): VNode {
  // Harness-only: a typo in the spec must never produce a blank baseline.
  return <p className="ccc-harness-error">{message}</p>;
}

// ---------------------------------------------------------------------------
// The fixture-backed seams: answer from memory, never touch a socket.
// ---------------------------------------------------------------------------

export function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

/** The inert host with the seams a populated install answers. */
export function fixtureHost(): SettingsHost {
  const base = createInertSettingsHost();
  return {
    ...base,
    claude: { ...base.claude, getIntegration: () => Promise.resolve(SETTINGS_FIXTURES.claude) },
    codex: { ...base.codex, getIntegration: () => Promise.resolve(SETTINGS_FIXTURES.codex) },
    approvals: { sendTestApproval: () => {}, serviceAvailable: () => true },
    tasks: { ...base.tasks, serviceAvailable: () => true },
    copyText: () => Promise.resolve(),
    display: SETTINGS_FIXTURES.display,
  };
}

function failed<T extends { kind: string }>(): Promise<T> {
  return Promise.resolve({ kind: "failed" } as unknown as T);
}

const PROJECTS_ACTIONS: ProjectsActions = {
  register: failed,
  remove: failed,
  rename: failed,
  pin: failed,
  setGithubLink: failed,
  refresh: failed,
};

const SCAN_ACTIONS: ScanActions = {
  addScanRoot: failed,
  removeScanRoot: failed,
  rescan: failed,
  listScanState: () => Promise.resolve({ kind: "state", state: SETTINGS_FIXTURES.scan }),
  registerSuggestion: failed,
  dismissSuggestion: failed,
  suggestionsPage: failed,
};

const LAUNCHERS_ACTIONS: LaunchersActions = {
  detect: () => Promise.resolve({ kind: "detected", detection: SETTINGS_FIXTURES.detection }),
  getConfigs: () => Promise.resolve({ kind: "loaded", configs: SETTINGS_FIXTURES.configs }),
  save: () => Promise.resolve({ kind: "saved" }),
  test: () => Promise.resolve({ kind: "sent" }),
  markTested: () => Promise.resolve({ kind: "marked" }),
  openSystemSettings: () => Promise.resolve({ kind: "opened" }),
  codexDoctor: () => Promise.resolve({ kind: "healthy" }),
};

/** How the health holder answers: a fixture answer, never an answer, or a rejection. */
export type HealthBehaviour = "answer" | "loading" | "error";

export function installHealth(behaviour: HealthBehaviour, answer: HealthAnswer): void {
  const get: HealthApi["get"] =
    behaviour === "loading"
      ? () => never<HealthAnswer>()
      : behaviour === "error"
        ? () => Promise.reject(new Error("harness: the checks failed"))
        : () => Promise.resolve(answer);
  configureHealth({ api: { get } });
}

let installed = false;

/** Configures the process-wide holders once per page (every harness page is one cell). */
export function installSettingsHolders(behaviour: HealthBehaviour, answer: HealthAnswer): void {
  if (installed) return;
  installed = true;
  installHealth(behaviour, answer);
  configureResearch({
    api: {
      run: () => never(),
      status: () => Promise.resolve(SETTINGS_FIXTURES.research),
      list: () => Promise.resolve({ rows: [], nextCursor: null }),
      report: () => never(),
    },
    notify: () => undefined,
    openNote: () => true,
    copyText: () => true,
    requestRunNow: () => undefined,
  });
}

// ---------------------------------------------------------------------------
// Readiness: the document is marked ready only when the state the case names is on screen, after
// the scripted presses, and once it has stayed unchanged for a few beats.
// ---------------------------------------------------------------------------

/** One press: a CSS selector, or the visible text of a button. */
export type Press = { readonly selector: string } | { readonly button: string };

function findPress(press: Press): HTMLElement | null {
  if ("selector" in press) return document.querySelector<HTMLElement>(press.selector);
  const buttons = document.querySelectorAll<HTMLButtonElement>(".ccc-settings-content button");
  return [...buttons].find((button) => button.textContent?.trim() === press.button) ?? null;
}

export interface ReadySpec {
  /** Presses made in order, one per beat, each once its target exists. */
  readonly presses?: readonly Press[];
  /** True when the state the case names is on screen. */
  readonly done: () => boolean;
}

const STABLE_TICKS = 6;

let readyStarted = false;

export function startReady(spec: ReadySpec): void {
  if (readyStarted) return;
  readyStarted = true;
  const presses = [...(spec.presses ?? [])];
  let tries = 0;
  let stable = 0;
  let lastPressAt = 0;
  const timer = setInterval(() => {
    tries += 1;
    const next = presses[0];
    if (next !== undefined) {
      // One press per beat: effects (focus moves, rebuilds) settle between presses.
      if (Date.now() - lastPressAt < 80) return;
      const target = findPress(next);
      if (target !== null) {
        presses.shift();
        lastPressAt = Date.now();
        target.click();
      }
    } else if (spec.done()) {
      stable += 1;
    } else {
      stable = 0;
    }
    if (stable >= STABLE_TICKS || tries > 1500) {
      clearInterval(timer);
      // One beat for the last paint (focus moves, container-query layout) to settle.
      setTimeout(() => document.documentElement.setAttribute("data-harness-ready", "true"), 120);
    }
  }, 10);
}

/** The text the section content shows, for readiness checks. */
export function contentText(): string {
  return document.querySelector(".ccc-settings-content")?.textContent ?? "";
}

/** True while anything in the section content is still loading. */
export function contentBusy(): boolean {
  const content = document.querySelector(".ccc-settings-content");
  if (content === null) return true;
  return (
    content.querySelector(".ccc-skeleton-line, [aria-busy='true']") !== null ||
    (content.textContent ?? "").includes("Detecting apps")
  );
}

// ---------------------------------------------------------------------------
// The frame: tab strip (optional), the Settings destination at a pane width.
// ---------------------------------------------------------------------------

export interface SettingsFrameProps {
  readonly section: SectionId;
  readonly width: Width;
  readonly connection: ConnectionState;
  readonly now: number;
  /** Adds the real tab strip above the destination (the contrast guard reads it). */
  readonly withNav: boolean;
  readonly host: SettingsHost;
}

export function SettingsFrame({
  section,
  width,
  connection,
  now,
  withNav,
  host,
}: SettingsFrameProps): VNode {
  connectionState.value = connection;
  const session = createSettingsSession();
  session.section.value = section;
  return (
    <div className="ccc-command-center" data-motion={motionMode.value}>
      <div data-harness-width={width} style={{ width: PANE_WIDTH[width] }}>
        {withNav ? <DestinationTabs activeId="settings" pendingCount={0} /> : null}
        <div className="ccc-content">
          <SettingsDestination
            settingsHost={host}
            settingsSession={session}
            launchersActions={LAUNCHERS_ACTIONS}
            launchersSession={createLaunchersSession()}
            projectsActions={PROJECTS_ACTIONS}
            scanActions={SCAN_ACTIONS}
            pickFolder={() => Promise.resolve({ kind: "cancelled" })}
            connection={connection}
            now={now}
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The entry the harness delegates to.
// ---------------------------------------------------------------------------

/** The `view` value this module owns; `main.tsx` delegates exactly this. */
export function isSettingsView(view: string): boolean {
  return view === "settings";
}

/**
 * Renders one Settings cell from the page's query parameters: `case` (`settings-<section>`),
 * `width` (narrow or full) and `nav=1` for the tab strip. `motion` is validated and applied by the
 * harness entry before it delegates here.
 */
export function SettingsCell({ params }: { readonly params: URLSearchParams }): VNode {
  const caseId = params.get("case") ?? "";
  const width = params.get("width") ?? "full";
  if (!isWidth(width)) {
    return <HarnessError message={`Unknown width "${width}" - expected narrow or full.`} />;
  }
  // Test-only (non-vacuity): a page with the tab strip and no destination, so a contrast page that
  // names text the destination draws must fail through its `mustSample`, never pass on an empty render.
  if (caseId === "__empty") {
    document.documentElement.setAttribute("data-harness-ready", "true");
    return (
      <div className="ccc-command-center" data-motion={motionMode.value}>
        <DestinationTabs activeId="settings" pendingCount={0} />
      </div>
    );
  }
  const section = caseId.startsWith("settings-") ? caseId.slice("settings-".length) : "";
  if (!isSection(section)) {
    return <HarnessError message={`Unknown settings case "${caseId}".`} />;
  }
  installSettingsHolders("answer", SETTINGS_FIXTURES.health);
  startReady({
    done: () =>
      !contentBusy() &&
      document.querySelector(".ccc-settings-content h3.ccc-settings-section-title") !== null &&
      SECTION_EXPECTS[section].every((text) => contentText().includes(text)),
  });
  return (
    <SettingsFrame
      section={section}
      width={width}
      connection={LIVE}
      now={NOW}
      withNav={params.get("nav") === "1"}
      host={fixtureHost()}
    />
  );
}
