/**
 * The isolated widget harness (UI-08, D-21 as amended, research OQ1).
 *
 * One static page renders ONE cell of the visual matrix — a widget in a
 * presentation, at a motion mode — chosen by the query string:
 *
 *   index.html?widget=service-health&state=ready&motion=full
 *
 * It renders the REAL `WidgetFrame` and the REAL registry definitions from
 * `@ccc/plugin`, inside the same `.ccc-command-center` root and against the
 * same production stylesheet the plugin ships, so a baseline regresses when
 * the component's markup or CSS does — not when a copy of it drifts.
 *
 * PRIVACY (PRIV-04 layer 1, T-03-03). This file may import exactly three
 * modules: `preact`, `@ccc/plugin` and the synthetic `widget-fixtures.json`.
 * `src/harness-purity.test.ts` enforces that set by source scan, and
 * `build.mjs` declares no externals so a transitive Obsidian import fails the
 * bundle outright. Every value on screen therefore comes from the fixture file
 * or from a literal in this file — nothing here can reach a vault, a client or
 * the network.
 *
 * DETERMINISM. `now` is the fixture's own frozen `now`, so every relative time
 * ("2 minutes ago") is identical on every run; Playwright pins the timezone
 * and locale for the one absolute time in the Source panel.
 */

import type {
  ActiveSessionsData,
  AnyWidgetDefinition,
  ClaudeUsageData,
  ConnectionState,
  GithubDiscoveriesData,
  MotionMode,
  ProjectShortcutsData,
  QuickActionsData,
  ServiceHealthData,
  SessionView,
  TechIntelData,
  TodayData,
  UsageSummary,
  WidgetId,
  WidgetState,
} from "@ccc/plugin";
import {
  AgentRuns,
  connectionState,
  isWidgetId,
  motionMode,
  selectedRunId,
  serviceHealthStateFor,
  sessionsById,
  usageSummary,
  WIDGETS,
  WidgetFrame,
  WidgetHostContext,
} from "@ccc/plugin";
import type { ComponentChildren } from "preact";
import { render } from "preact";
import fixtureFile from "../src/widget-fixtures.json";

// ---------------------------------------------------------------------------
// The fixture file's shape (plan 03-02). Declared here rather than inferred so
// the adapters below read named fields, not a thirty-way JSON literal union.
// ---------------------------------------------------------------------------

interface FixturePartiality {
  readonly partial: boolean;
  readonly missingSources?: readonly string[];
}

interface FixtureVariant {
  readonly observedAt: string;
  readonly freshness: "live" | "cached" | "stale" | "unavailable";
  readonly partiality: FixturePartiality;
  readonly sources: readonly { readonly label: string; readonly status: string }[];
  readonly capability?: string;
  readonly message?: string;
  // The prototype data payload: loosely typed on purpose — each adapter below
  // reads the fields its own panel's prototype defined.
  readonly data: Readonly<Record<string, unknown>>;
}

type FixtureStateKey = "live" | "stale" | "empty" | "permission-required" | "failure";

interface FixturePanel {
  readonly id: string;
  readonly title: string;
  readonly states: Readonly<Record<FixtureStateKey, FixtureVariant>>;
}

interface FixtureFile {
  readonly now: string;
  readonly panels: readonly FixturePanel[];
}

const FIXTURES = fixtureFile as unknown as FixtureFile;
const NOW = Date.parse(FIXTURES.now);

// ---------------------------------------------------------------------------
// The matrix vocabulary.
// ---------------------------------------------------------------------------

/** Every card presentation the matrix screenshots (UI-SPEC per-state table). */
const PRESENTATIONS = [
  "loading",
  "empty",
  "ready",
  "stale",
  "disconnected",
  "error",
  "permission-required",
  "unavailable",
] as const;

type Presentation = (typeof PRESENTATIONS)[number];

function isPresentation(value: string): value is Presentation {
  return (PRESENTATIONS as readonly string[]).includes(value);
}

/** The pseudo-widget for the atmosphere cells: the root, the twinkle field, no card. */
const BACKGROUND = "background";

/** The disconnect reason every disconnected cell shows — synthetic, fixed. */
const DISCONNECT_REASON = "connect ECONNREFUSED";

// ---------------------------------------------------------------------------
// Fixture data → each widget's typed body data.
//
// The prototype fixtures (plan 03-02) were written as display strings for the
// three prototype pages; the production bodies (plan 03-06) take typed data.
// These adapters are the one translation between them. They only reshape and
// parse what the fixture already says — they never add a value the fixture
// does not contain, except where a production field has no prototype
// counterpart, which is named inline.
// ---------------------------------------------------------------------------

type Fields = Readonly<Record<string, unknown>>;

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function list(value: unknown): readonly Fields[] {
  return Array.isArray(value) ? (value as readonly Fields[]) : [];
}

/** "4.2K stars" → 4200, "1.84M" → 1840000, "830 stars" → 830, "4 open" → 4. */
// A fixture string with no number in it ("Issue count unavailable") is an
// unavailable value: it maps to null, never 0, so the harness renders the same
// "unavailable" copy the production cards do.
function quantity(value: unknown): number | null {
  const match = /(\d+(?:\.\d+)?)\s*([KM])?/i.exec(text(value));
  if (match === null) return null;
  const scale = match[2]?.toUpperCase() === "M" ? 1e6 : match[2]?.toUpperCase() === "K" ? 1e3 : 1;
  return Math.round(Number(match[1]) * scale);
}

function adaptServiceHealth(data: Fields): ServiceHealthData {
  // The prototype carries the last event as a display line: "Last event: x".
  const lines: readonly unknown[] = Array.isArray(data.lines) ? data.lines : [];
  const eventLine = lines.map((line) => text(line)).find((line) => line.startsWith("Last event: "));
  return eventLine === undefined
    ? { connection: "live" }
    : {
        connection: "live",
        lastEvent: { type: eventLine.slice("Last event: ".length), occurredAt: FIXTURES.now },
      };
}

function adaptToday(data: Fields): TodayData {
  const nextEvent = data.nextEvent as Fields | null | undefined;
  const tasks = list(data.dueTasks).map((task) => ({
    title: text(task.title),
    dueAt: text(task.due),
  }));
  const unread = data.unread as Fields | null | undefined;
  return {
    nextEvent:
      nextEvent === null || nextEvent === undefined
        ? null
        : { title: text(nextEvent.title), startsAt: text(nextEvent.time) },
    remainingCount: quantity(data.kpi),
    dueTasks: tasks.filter((task) => task.dueAt !== "Overdue"),
    overdueTasks: tasks.filter((task) => task.dueAt === "Overdue"),
    unreadSummary: unread === null || unread === undefined ? null : text(unread.summary),
    // No prototype counterpart: the fixtures model failures as whole-card
    // `failure` variants, never as a line inside a ready card.
    failures: [],
  };
}

/**
 * The eight domain `RunState` values (05-06). This file cannot import
 * `@ccc/domain` (the three-module purity list above), so the set is a local,
 * harness-only copy used only to validate the fixture's own `state` field —
 * never a second source of truth for the production mapping, which lives in
 * `RUN_STATE_DISPLAY` and is exercised by the real component this harness
 * renders.
 */
const RUN_STATES = new Set([
  "queued",
  "starting",
  "running",
  "waiting-for-approval",
  "stale",
  "completed",
  "failed",
  "cancelled",
]);

/** An unrecognised state maps to `stale` (unknown) — never an invented terminal state. */
function sessionState(value: unknown): string {
  const state = text(value);
  return RUN_STATES.has(state) ? state : "stale";
}

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);

/**
 * `ActiveSessionsData` (05-06) carries real `SessionView` rows, which this
 * file cannot import the type for (the purity list above). The object below
 * is built to that shape from the fixture's own fields, with an honest
 * default for every field the prototype fixture never carried (subagents,
 * link kind, transcript, …) — never a value the fixture does not say.
 */
function adaptActiveSessions(data: Fields): ActiveSessionsData {
  const sessions = list(data.rows).map((row) => ({
    runId: `${text(row.project)}-${text(row.name)}`,
    revision: 1,
    claudeSessionId: typeof row.claudeSessionId === "string" ? row.claudeSessionId : null,
    state: sessionState(row.state),
    activity: null,
    projectId: text(row.project),
    projectName: text(row.project),
    name: text(row.name),
    model: typeof row.model === "string" ? row.model : null,
    effort: null,
    launchSource: "terminal",
    permissionMode: null,
    claudeVersion: null,
    startedAt: text(row.startedAt, FIXTURES.now),
    endedAt: TERMINAL_STATES.has(sessionState(row.state))
      ? text(row.lastActivityAt, FIXTURES.now)
      : null,
    lastActivityAt: text(row.lastActivityAt, FIXTURES.now),
    subagents: { active: 0, lastType: null },
    lastError: null,
    linkKind: null,
    linkedFromRunId: null,
    cwdBasename: null,
    worktreeBasename: null,
    hasTranscript: false,
    terminateRequested: false,
    hasConversation: true,
  }));
  return { sessions, nowMs: NOW } as unknown as ActiveSessionsData;
}

/** All three launchers set up: S10's setup callout stays out of the ready and stale cells. */
const HARNESS_LAUNCHERS_SET_UP = {
  antigravity: "set-up",
  "claude-code": { status: "set-up", terminalLabel: "Terminal" },
  "claude-desktop": "set-up",
} as const;

/**
 * No launcher set up (RR-26). The `empty` fixture is a fresh install — the
 * registry answered "none registered" — so its cell also shows the S10 setup
 * callout after the empty copy (UI-SPEC S1 "Setup state"; 04-15 carried item).
 */
const HARNESS_LAUNCHERS_NOT_SET_UP = {
  antigravity: "not-set-up",
  "claude-code": { status: "not-set-up", terminalLabel: "Terminal" },
  "claude-desktop": "not-set-up",
} as const;

/**
 * One S1 row's git picture. The prototype rows carry only a branch and a
 * clean/dirty string, so the production states they cannot express — pinned
 * or not, a detached HEAD, a branch git could not name, a failed read — are
 * assigned by the row's POSITION, per fixture variant, so every S1 row
 * anatomy the UI-SPEC defines reaches a baseline (plan 04-15; wave-3 and
 * wave-6 carried items). Branch names and dirtiness still come from the row.
 */
type RowShape =
  | "pinned"
  | "unpinned"
  | "detached"
  | "stale"
  | "branch-unavailable"
  | "first-read-failed";

/**
 * `live` (the ready and disconnected cells): one pinned row, one unpinned row
 * with uncommitted changes, one detached HEAD. `stale`: a last-good row whose
 * refresh failed (`◔ Stale`), a branch git could not name, and a project
 * whose very first read failed (`▲ Couldn't read Git status`).
 */
const ROW_SHAPES: Readonly<Partial<Record<FixtureStateKey, readonly RowShape[]>>> = {
  live: ["pinned", "unpinned", "detached"],
  stale: ["stale", "branch-unavailable", "first-read-failed"],
};

function projectRow(row: Fields, shape: RowShape): ProjectShortcutsData["projects"][number] {
  const dirty = text(row.dirty) !== "Clean";
  const branch = text(row.branch) || null;
  const git: ProjectShortcutsData["projects"][number]["git"] =
    shape === "first-read-failed"
      ? { kind: "pending" }
      : {
          kind: "repo",
          branch: shape === "detached" || shape === "branch-unavailable" ? null : branch,
          detached: shape === "detached",
          dirty,
          commits: [],
          remote: null,
        };
  return {
    id: text(row.project),
    name: text(row.project),
    pinned: shape === "pinned" || shape === "stale",
    git,
    gitReadFailed: shape === "stale" || shape === "first-read-failed",
    // A row the fixture gives an issue COUNT ("4 open") is a GitHub repository;
    // a row whose count is unavailable has no target the harness can claim, so
    // its GitHub button takes the aria-disabled `No GitHub remote` look. The
    // label is display-only and never rendered by S1.
    github:
      quantity(row.openIssues) === null
        ? { kind: "none" }
        : {
            kind: "github",
            label: `github.com/example/${text(row.project).toLowerCase()}`,
            source: "remote",
          },
    observedAt: shape === "first-read-failed" ? null : FIXTURES.now,
    // Never populated in Phase 4 (D-15) — no prototype counterpart is read.
    openItems: null,
    sessionCount: null,
    nextTask: null,
  };
}

function adaptProjectShortcuts(data: Fields, variant: FixtureStateKey): ProjectShortcutsData {
  const shapes = ROW_SHAPES[variant] ?? [];
  return {
    projects: list(data.rows).map((row, index) => projectRow(row, shapes[index] ?? "unpinned")),
    launchers: variant === "empty" ? HARNESS_LAUNCHERS_NOT_SET_UP : HARNESS_LAUNCHERS_SET_UP,
  };
}

/**
 * The 05-10 fixture's `data.summary` is already a `UsageSummary`-shaped
 * plain object — no display-string parsing (`quantity()`) needed, since the
 * production body now takes typed data straight from the service, not a
 * prototype's display strings. This file cannot import `@ccc/domain`'s
 * `UsageSummary` type (the three-module purity list above), so the field is
 * read as `ClaudeUsageData["summary"]` — the one type this harness already
 * carries via `@ccc/plugin`.
 *
 * A fallback "everything off" summary covers the `empty` /
 * `permission-required` / `failure` fixture states, whose `data` is `{}`:
 * `WidgetFrame` never calls `renderBody` for those presentations (frame.tsx
 * `case "empty"` renders its own generic copy without reading `state.data`),
 * so this value is never actually drawn — it exists only so `ADAPTERS`
 * stays a total function over every `FixtureStateKey`.
 */
const EMPTY_USAGE_SUMMARY: ClaudeUsageData["summary"] = {
  capacity: { kind: "unavailable", reason: "wrapper-not-installed", version: null },
  ranges: {
    today: {
      activity: { kind: "unavailable", reason: "analysis-off", version: null },
      cost: { kind: "unavailable", reason: "needs-activity-or-wrapper" },
    },
    "last-7-days": {
      activity: { kind: "unavailable", reason: "analysis-off", version: null },
      cost: { kind: "unavailable", reason: "needs-activity-or-wrapper" },
    },
    "this-month": {
      activity: { kind: "unavailable", reason: "analysis-off", version: null },
      cost: { kind: "unavailable", reason: "needs-activity-or-wrapper" },
    },
  },
  analysis: { enabled: false, firstScanPending: false },
  observedAt: FIXTURES.now,
};

function adaptClaudeUsage(data: Fields): ClaudeUsageData {
  const summary = data.summary as ClaudeUsageData["summary"] | undefined;
  return { summary: summary ?? EMPTY_USAGE_SUMMARY, nowMs: NOW };
}

function adaptTechIntel(data: Fields): TechIntelData {
  return {
    stories: list(data.rows).map((row) => ({
      id: text(row.headline),
      headline: text(row.headline),
      category: text(row.category),
      summary: text(row.summary),
      sourceCount: quantity(row.sourceCount) ?? 1, // a story always has at least one source
    })),
    marketSummary: typeof data.marketLine === "string" ? data.marketLine : null,
  };
}

function adaptGithubDiscoveries(data: Fields): GithubDiscoveriesData {
  return {
    repos: list(data.rows).map((row) => ({
      id: text(row.name),
      name: text(row.name),
      stars: quantity(row.stars),
      growth: text(row.growth),
      reason: text(row.note),
    })),
  };
}

function adaptQuickActions(): QuickActionsData {
  // S8 reads the launcher summary (D-38); every launcher set up, so the live
  // pair renders (visual cells re-baselined in plan 04-15).
  return { launchers: HARNESS_LAUNCHERS_SET_UP };
}

/**
 * The widget host the real shell provides (plan 04-14): a quick switcher is
 * wired, so S8's `Start a Claude Code session` renders live, as it does in
 * Obsidian. No System Settings route — a harness has no service to ask, and
 * no cell shows a launch error line.
 */
const HARNESS_WIDGET_HOST = { switcherAvailable: true } as const;

/** Every adapter sees which fixture variant it is reshaping; most ignore it. */
type Adapter = (data: Fields, variant: FixtureStateKey) => unknown;

const ADAPTERS: { readonly [K in WidgetId]: Adapter } = {
  "service-health": adaptServiceHealth,
  today: adaptToday,
  "active-sessions": adaptActiveSessions,
  "project-shortcuts": adaptProjectShortcuts,
  "claude-usage": adaptClaudeUsage,
  "tech-intel": adaptTechIntel,
  "github-discoveries": adaptGithubDiscoveries,
  "quick-actions": adaptQuickActions,
};

// ---------------------------------------------------------------------------
// One cell: fixture variant + presentation → the WidgetState and connection
// the real frame is handed. The frame's own `resolveCardPresentation` then
// derives what is drawn — the harness never picks a presentation directly.
// ---------------------------------------------------------------------------

interface CellInputs {
  readonly state: WidgetState<unknown>;
  readonly connection: ConnectionState;
}

const LIVE: ConnectionState = { kind: "live" };

function readyFrom(
  id: WidgetId,
  states: FixturePanel["states"],
  key: FixtureStateKey,
  isEmpty: boolean,
): WidgetState<unknown> {
  const variant = states[key];
  return {
    kind: "ready",
    data: ADAPTERS[id](variant.data, key),
    observedAt: variant.observedAt,
    freshness: variant.freshness,
    partiality:
      variant.partiality.missingSources === undefined
        ? { partial: variant.partiality.partial }
        : {
            partial: variant.partiality.partial,
            missingSources: [...variant.partiality.missingSources],
          },
    isEmpty,
  };
}

function cellFor(id: WidgetId, panel: FixturePanel, presentation: Presentation): CellInputs {
  const { states } = panel;
  switch (presentation) {
    case "loading":
      return { state: { kind: "loading" }, connection: LIVE };
    case "unavailable":
      return { state: { kind: "unavailable" }, connection: LIVE };
    case "ready":
      return { state: readyFrom(id, states, "live", false), connection: LIVE };
    case "stale":
      return { state: readyFrom(id, states, "stale", false), connection: LIVE };
    case "empty":
      return { state: readyFrom(id, states, "empty", true), connection: LIVE };
    case "error":
      return {
        state: { kind: "error", message: text(states.failure.message, "The source failed.") },
        connection: LIVE,
      };
    case "permission-required":
      return {
        state: {
          kind: "permission-required",
          capability: text(states["permission-required"].capability, "service"),
          sourceLabel: states["permission-required"].sources
            .map((source) => source.label)
            .join(" and "),
        },
        connection: LIVE,
      };
    case "disconnected": {
      const connection: ConnectionState = { kind: "disconnected", reason: DISCONNECT_REASON };
      if (id === "service-health") {
        // Service health's one data key is `local` — its data IS the
        // connection — so a dropped transport does not flip it to the generic
        // disconnected card. The production mapping says what it shows.
        return {
          state: serviceHealthStateFor(connection, undefined, states.live.observedAt),
          connection,
        };
      }
      return { state: readyFrom(id, states, "live", false), connection };
    }
  }
}

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------

/** Twelve points, matching the shell's field (styles.css positions them). */
const TWINKLE_POINTS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as const;

function Twinkle() {
  return (
    <div className="ccc-twinkle" aria-hidden="true">
      {TWINKLE_POINTS.map((point) => (
        <span className="ccc-twinkle-point" key={point} />
      ))}
    </div>
  );
}

function HarnessError({ message }: { readonly message: string }) {
  // Harness-only: a typo in the spec must never produce a blank baseline.
  return <p className="ccc-harness-error">{message}</p>;
}

function Root({
  motion,
  children,
}: {
  readonly motion: MotionMode;
  readonly children: ComponentChildren;
}) {
  return (
    <div className="ccc-command-center" data-motion={motion}>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The Agent runs destination cells (UI-SPEC "Visual regression" S3, plan
// 05-13 Task 3). Synthetic project and session names only (PRIV-04); every
// timestamp is relative to the fixture's own frozen `NOW`, matching the
// widget-matrix determinism rule above.
// ---------------------------------------------------------------------------

const AGENT_RUNS_CASES = [
  "selected-waiting",
  "selected-stale",
  "narrow-detail",
  "disconnected",
] as const;
type AgentRunsCase = (typeof AGENT_RUNS_CASES)[number];

function isAgentRunsCase(value: string): value is AgentRunsCase {
  return (AGENT_RUNS_CASES as readonly string[]).includes(value);
}

/** Builds one synthetic `SessionView`. Every field the domain schema
 * requires is given an honest value — `Not reported` fields stay `null`
 * rather than a guessed string, matching the data-integrity rule the real
 * component renders under. */
function syntheticSession(overrides: Partial<SessionView>): SessionView {
  return {
    runId: "0mfk1a2b3c4d5e6f7a8b9c0d1",
    revision: 1,
    claudeSessionId: "claude-session-fixture",
    state: "running",
    activity: "working",
    projectId: "proj-fixture",
    projectName: "fixture-project",
    name: "Refactor the parser",
    model: "claude-opus",
    effort: null,
    launchSource: "terminal",
    permissionMode: null,
    claudeVersion: "2.1.220",
    startedAt: new Date(NOW - 45 * 60_000).toISOString(),
    endedAt: null,
    lastActivityAt: new Date(NOW - 5_000).toISOString(),
    subagents: { active: 0, lastType: null },
    lastError: null,
    linkKind: null,
    linkedFromRunId: null,
    cwdBasename: "fixture-project",
    worktreeBasename: null,
    hasTranscript: true,
    terminateRequested: false,
    hasConversation: true,
    ...overrides,
  } as SessionView;
}

const SYNTHETIC_USAGE_SUMMARY: UsageSummary = (() => {
  const today = {
    activity: {
      kind: "available",
      range: "today",
      bounds: {
        start: new Date(NOW - 12 * 3_600_000).toISOString(),
        end: new Date(NOW).toISOString(),
      },
      totals: { input: 120_000, output: 48_000, cacheWrite: 6_000, cacheRead: 18_000 },
      byProject: [
        {
          projectId: "proj-fixture",
          projectName: "fixture-project",
          counters: { input: 90_000, output: 36_000, cacheWrite: 4_000, cacheRead: 12_000 },
        },
        {
          projectId: null,
          projectName: null,
          counters: { input: 30_000, output: 12_000, cacheWrite: 2_000, cacheRead: 6_000 },
        },
      ],
      byModel: [
        {
          model: "claude-opus",
          counters: { input: 120_000, output: 48_000, cacheWrite: 6_000, cacheRead: 18_000 },
        },
      ],
      bySkill: [],
      observedAt: new Date(NOW).toISOString(),
      source: "local-transcript-analysis",
      freshness: "live",
      partiality: { partial: false },
      coverage: { horizonDate: null, uncoveredDays: 0, analysisOffDays: 0 },
    },
    cost: {
      kind: "available",
      range: "today",
      bounds: {
        start: new Date(NOW - 12 * 3_600_000).toISOString(),
        end: new Date(NOW).toISOString(),
      },
      usd: 12.4,
      basis: "list-prices",
      priceTableDate: "2026-09-01",
      excludedModelCount: 0,
      observedAt: new Date(NOW).toISOString(),
      source: "claude-code-estimates-and-list-prices",
      freshness: "live",
      partiality: { partial: false },
    },
  };
  return {
    capacity: { kind: "unavailable", reason: "wrapper-not-installed", version: null },
    ranges: { today, "last-7-days": today, "this-month": today },
    analysis: { enabled: true, firstScanPending: false },
    observedAt: new Date(NOW).toISOString(),
  } as UsageSummary;
})();

/** Seeds the Agent runs signals for one visual-matrix case (UI-SPEC S3). */
function seedAgentRunsCase(agentRunsCase: AgentRunsCase): ConnectionState {
  const waiting = syntheticSession({
    runId: "0mfk1a2b3c4d5e6f7a8b9c0d1" as SessionView["runId"],
    name: "Refactor the parser",
    state: "waiting-for-approval",
  });
  const stale = syntheticSession({
    runId: "0mfk1a2b3c4d5e6f7a8b9c0d2" as SessionView["runId"],
    name: "Investigate the flaky test",
    state: "stale",
    lastActivityAt: new Date(NOW - 20 * 60_000).toISOString(),
  });
  const running = syntheticSession({
    runId: "0mfk1a2b3c4d5e6f7a8b9c0d3" as SessionView["runId"],
    name: "Draft the release notes",
    state: "running",
  });

  const sessions = new Map<string, SessionView>([
    [waiting.runId, waiting],
    [stale.runId, stale],
    [running.runId, running],
  ]);
  sessionsById.value = sessions;
  usageSummary.value = SYNTHETIC_USAGE_SUMMARY;

  switch (agentRunsCase) {
    case "selected-waiting":
      selectedRunId.value = waiting.runId;
      return { kind: "live" };
    case "selected-stale":
      selectedRunId.value = stale.runId;
      return { kind: "live" };
    case "narrow-detail":
      selectedRunId.value = running.runId;
      return { kind: "live" };
    case "disconnected":
      selectedRunId.value = running.runId;
      return { kind: "disconnected", reason: "connect ECONNREFUSED" };
  }
}

function AgentRunsCell({ agentRunsCase }: { readonly agentRunsCase: AgentRunsCase }) {
  connectionState.value = seedAgentRunsCase(agentRunsCase);

  const body = (
    <div className="ccc-content">
      <h2>Agent runs</h2>
      <AgentRuns now={NOW} onQuickAction={() => {}} />
    </div>
  );

  if (agentRunsCase === "narrow-detail") {
    // Harness-only: a fixed pixel width stands in for the `48rem` container
    // query threshold the production CSS reads (UI-SPEC S3 "Layout"). This
    // is test infrastructure in `test-fixtures`, not plugin production code,
    // so it does not fall under the plugin's own "no inline style" rule.
    return (
      <Root motion={motionMode.value}>
        <div style={{ width: "24rem" }}>{body}</div>
      </Root>
    );
  }

  return <Root motion={motionMode.value}>{body}</Root>;
}

function HarnessCell() {
  const params = new URLSearchParams(location.search);
  const view = params.get("view") ?? "";
  const widget = params.get("widget") ?? "";
  const state = params.get("state") ?? "ready";
  const motion = params.get("motion") ?? "full";

  if (motion !== "full" && motion !== "reduced") {
    return <HarnessError message={`Unknown motion "${motion}" — expected full or reduced.`} />;
  }
  motionMode.value = motion;

  if (view === "agent-runs") {
    const agentRunsCase = params.get("case") ?? "";
    if (!isAgentRunsCase(agentRunsCase)) {
      return <HarnessError message={`Unknown agent-runs case "${agentRunsCase}".`} />;
    }
    return <AgentRunsCell agentRunsCase={agentRunsCase} />;
  }

  if (widget === BACKGROUND) {
    return (
      <Root motion={motionMode.value}>
        <Twinkle />
      </Root>
    );
  }

  if (!isWidgetId(widget)) {
    return <HarnessError message={`Unknown widget "${widget}".`} />;
  }
  if (!isPresentation(state)) {
    return <HarnessError message={`Unknown state "${state}".`} />;
  }
  const panel = FIXTURES.panels.find((candidate) => candidate.id === widget);
  if (panel === undefined) {
    return <HarnessError message={`No fixture panel for "${widget}".`} />;
  }

  const definition: AnyWidgetDefinition = WIDGETS[widget];
  const cell = cellFor(widget, panel, state);
  connectionState.value = cell.connection;

  // The cell IS a production `.ccc-overview-grid`, so the card is sized by
  // the real grid rules (16rem-minimum columns, `wide` spanning two and
  // collapsing to one below 34rem) rather than by a harness-fixed width that
  // clips on a narrow page (03-09 visual audit MINOR).
  return (
    <Root motion={motionMode.value}>
      <div className="ccc-overview-grid ccc-harness-cell">
        <WidgetHostContext.Provider value={HARNESS_WIDGET_HOST}>
          {/* A no-op dispatcher: the frame hands it to the body only for ready
              and stale, so those cells draw the S1 launch toolbars and S8's
              live buttons exactly as the real card does (RR-05). */}
          <WidgetFrame
            definition={definition}
            state={cell.state}
            connection={connectionState.value}
            size={definition.preferredSize}
            now={NOW}
            onQuickAction={() => {}}
          />
        </WidgetHostContext.Provider>
      </div>
    </Root>
  );
}

const root = document.getElementById("root");
if (root !== null) render(<HarnessCell />, root);
