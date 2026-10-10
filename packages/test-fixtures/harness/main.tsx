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
  ApprovalDetailResponse,
  ApprovalSummary,
  ApprovalsApi,
  ApprovalsSnapshot,
  ClaudeUsageData,
  CodexCardData,
  ConnectionState,
  GithubDiscoveriesData,
  MotionMode,
  ProjectShortcutsData,
  QuickActionsData,
  ServiceHealthData,
  SessionView,
  TaskActionsPort,
  TasksApi,
  TechIntelData,
  TodayData,
  UsageSummary,
  WidgetId,
  WidgetState,
} from "@ccc/plugin";
import {
  AgentRuns,
  adoptApprovalsSnapshot,
  approvalChip,
  approvalDetailFocusRequested,
  approvalsMissedSync,
  configureApprovalsApi,
  configureTaskActionsPort,
  configureTasksApi,
  connectionState,
  createProjectTasksContext,
  createTasksContext,
  createTasksViewState,
  DestinationTabs,
  isWidgetId,
  motionMode,
  ProjectTasksPanel,
  parseTaskContent,
  pendingApprovalCount,
  resetApprovalsState,
  resetApprovalsView,
  selectedProposalId,
  selectedRunId,
  serviceHealthStateFor,
  sessionsById,
  TasksApiError,
  TasksDestination,
  tasksAttention,
  tasksRebuilding,
  usageSummary,
  WIDGETS,
  WidgetFrame,
  WidgetHostContext,
} from "@ccc/plugin";
import type { ComponentChildren } from "preact";
import { render } from "preact";
import fixtureFile from "../src/widget-fixtures.json";
import approvalFixtureFile from "./approval-fixtures.json";
import taskFixtureFile from "./task-fixtures.json";

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
 * refresh failed (`◷ Stale`), a branch git could not name, and a project
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

function adaptCodex(data: Fields): CodexCardData {
  const sessions = (data.sessions as CodexCardData["sessions"] | undefined) ?? null;
  return {
    sessions,
    usage: (data.usage as CodexCardData["usage"] | undefined) ?? null,
    headroom: (data.headroom as CodexCardData["headroom"] | undefined) ?? null,
    tokens: (data.tokens as CodexCardData["tokens"] | undefined) ?? null,
    integration: (data.integration as CodexCardData["integration"] | undefined) ?? null,
    nowMs: NOW,
    analysisOn: sessions?.kind === "available" && sessions.analysisOn,
  };
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
  codex: adaptCodex,
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

// ---------------------------------------------------------------------------
// The Approvals cells (UI-SPEC "Visual regression and fixtures", plan 06-17).
//
// `view=agent-runs&case=approvals-*&width=full|narrow&motion=full|reduced` and
// `case=shell-nav-count`. They render the REAL Agent runs destination (the
// Approvals section and the request pane) or the REAL shell from `@ccc/plugin`,
// against the production stylesheet. Every value comes from
// `approval-fixtures.json` (synthetic: projects example-project, sample-notes,
// demo-api; session Refactor parser; PID 4242; hostile text on example.invalid)
// or from a literal here. The service is a fake `ApprovalsApi` over that file:
// nothing here can reach a client, a vault or the network.
// ---------------------------------------------------------------------------

type ApprovalFilterName = "pending" | "decided" | "expired";

interface ApprovalFixtureFile {
  readonly now: string;
  readonly ids: Readonly<Record<string, string>>;
  readonly inbox: Readonly<Record<ApprovalFilterName, readonly string[]>>;
  readonly alternateHash: string;
  readonly details: Readonly<Record<string, ApprovalDetailResponse>>;
}

const APPROVAL_FIXTURES = approvalFixtureFile as unknown as ApprovalFixtureFile;
const APPROVAL_NOW = Date.parse(APPROVAL_FIXTURES.now);

/** The inbox a case starts from. */
type ApprovalInboxKind = "full" | "empty" | "loading" | "error";

interface ApprovalCaseSpec {
  readonly chip: ApprovalFilterName;
  /** A key of the fixture `ids`, or `null` for no selection. */
  readonly selected: string | null;
  readonly inbox: ApprovalInboxKind;
  readonly connection: ConnectionState;
  /** The list may have missed a change (the stale state). */
  readonly missedSync?: boolean;
  /** Press Approve once on arrival; the fake service answers with a changed fingerprint. */
  readonly mismatch?: boolean;
  /** The element that must exist before the cell is ready to capture. */
  readonly readyWhen: string;
}

const APPROVAL_LIVE: ConnectionState = { kind: "live" };

/** The decision group of a pane that has finished loading (the loading form carries a Deny too). */
const LOADED_DENY = '.ccc-approval-detail:not([aria-busy]) [data-decision="deny"]';

const APPROVAL_CASES: Readonly<Record<string, ApprovalCaseSpec>> = {
  "approvals-pending-destructive": {
    chip: "pending",
    selected: "forceTerminate",
    inbox: "full",
    connection: APPROVAL_LIVE,
    readyWhen: LOADED_DENY,
  },
  "approvals-pending-requester": {
    chip: "pending",
    selected: "requesterSkill",
    inbox: "full",
    connection: APPROVAL_LIVE,
    readyWhen: LOADED_DENY,
  },
  "approvals-pending-test": {
    chip: "pending",
    selected: "testApproval",
    inbox: "full",
    connection: APPROVAL_LIVE,
    readyWhen: LOADED_DENY,
  },
  "approvals-executing": {
    chip: "decided",
    selected: "executing",
    inbox: "full",
    connection: APPROVAL_LIVE,
    readyWhen: '.ccc-approval-detail[data-state="executing"]',
  },
  "approvals-executed": {
    chip: "decided",
    selected: "executed",
    inbox: "full",
    connection: APPROVAL_LIVE,
    readyWhen: '.ccc-approval-detail[data-state="executed"]',
  },
  "approvals-failed": {
    chip: "decided",
    selected: "failed",
    inbox: "full",
    connection: APPROVAL_LIVE,
    readyWhen: '.ccc-approval-detail[data-state="failed"]',
  },
  "approvals-unknown": {
    chip: "decided",
    selected: "unknown",
    inbox: "full",
    connection: APPROVAL_LIVE,
    readyWhen: '.ccc-approval-detail[data-state="unknown"]',
  },
  "approvals-expired": {
    chip: "expired",
    selected: "expired",
    inbox: "full",
    connection: APPROVAL_LIVE,
    readyWhen: '.ccc-approval-detail[data-state="expired"]',
  },
  "approvals-hash-mismatch": {
    chip: "pending",
    selected: "forceTerminate",
    inbox: "full",
    connection: APPROVAL_LIVE,
    mismatch: true,
    readyWhen: ".ccc-approval-changed",
  },
  "approvals-too-large": {
    chip: "pending",
    selected: "tooLarge",
    inbox: "full",
    connection: APPROVAL_LIVE,
    readyWhen: ".ccc-approval-too-large",
  },
  "approvals-empty": {
    chip: "pending",
    selected: null,
    inbox: "empty",
    connection: APPROVAL_LIVE,
    readyWhen: ".ccc-approvals-empty",
  },
  "approvals-loading": {
    chip: "pending",
    selected: null,
    inbox: "loading",
    connection: APPROVAL_LIVE,
    readyWhen: ".ccc-approvals-loading",
  },
  "approvals-error": {
    chip: "pending",
    selected: null,
    inbox: "error",
    connection: APPROVAL_LIVE,
    readyWhen: ".ccc-approvals-empty .ccc-error-glyph",
  },
  "approvals-stale": {
    chip: "pending",
    selected: "forceTerminate",
    inbox: "full",
    connection: APPROVAL_LIVE,
    missedSync: true,
    readyWhen:
      '.ccc-approval-detail:not([aria-busy]) [data-decision="approve"][aria-disabled="true"]',
  },
  "approvals-disconnected": {
    chip: "pending",
    selected: "forceTerminate",
    inbox: "full",
    connection: { kind: "disconnected", reason: "connect ECONNREFUSED" },
    readyWhen: '.ccc-approval-detail[data-dimmed="true"]:not([aria-busy]) [data-decision="deny"]',
  },
  "shell-nav-count": {
    chip: "pending",
    selected: null,
    inbox: "full",
    connection: APPROVAL_LIVE,
    readyWhen: ".ccc-nav-count",
  },
};

function isApprovalsCase(value: string): boolean {
  return Object.hasOwn(APPROVAL_CASES, value);
}

const APPROVAL_WIDTHS = ["full", "narrow"] as const;
type ApprovalWidth = (typeof APPROVAL_WIDTHS)[number];

function isApprovalWidth(value: string): value is ApprovalWidth {
  return (APPROVAL_WIDTHS as readonly string[]).includes(value);
}

function approvalDetailOf(id: string): ApprovalDetailResponse {
  const detail = APPROVAL_FIXTURES.details[id];
  if (detail === undefined) throw new Error(`No approval fixture for ${id}.`);
  return detail;
}

function approvalSnapshot(kind: ApprovalInboxKind): ApprovalsSnapshot {
  const summaries = (ids: readonly string[]): ApprovalSummary[] =>
    kind === "empty" ? [] : ids.map((id) => approvalDetailOf(id).summary);
  const pending = summaries(APPROVAL_FIXTURES.inbox.pending);
  const decided = summaries(APPROVAL_FIXTURES.inbox.decided);
  const expired = summaries(APPROVAL_FIXTURES.inbox.expired);
  return {
    ready: true,
    pending,
    decided,
    expired,
    counts: { pending: pending.length, decided: decided.length, expired: expired.length },
    truncated: false,
  };
}

/** The fake service: the fixture file behind the four functions the plugin's views reach. */
function fakeApprovalsApi(spec: ApprovalCaseSpec): ApprovalsApi {
  let gets = 0;
  return {
    list: () => {
      if (spec.inbox === "loading") return new Promise<ApprovalsSnapshot>(() => {});
      if (spec.inbox === "error") return Promise.reject(new Error("fixture: service unavailable"));
      return Promise.resolve(approvalSnapshot(spec.inbox));
    },
    get: (proposalId) => {
      gets += 1;
      const detail = approvalDetailOf(proposalId);
      if (spec.mismatch !== true || gets === 1 || detail.view === null) {
        return Promise.resolve(detail);
      }
      // After a mismatch the service shows the changed request: a new fingerprint.
      const hash = APPROVAL_FIXTURES.alternateHash;
      return Promise.resolve({
        ...detail,
        payloadHash: hash,
        view: {
          ...detail.view,
          record: { ...detail.view.record, payloadHash: hash, fingerprint: hash.slice(0, 12) },
        },
      });
    },
    decide: () =>
      spec.mismatch === true
        ? Promise.resolve({ outcome: "hash-mismatch" as const })
        : Promise.reject(new Error("fixture: decide was not expected")),
    test: () => Promise.reject(new Error("fixture: test was not expected")),
  };
}

/** The sessions the destination shows beside the Approvals section; the first is the request's Run. */
function seedApprovalSessions(): void {
  const at = (minutes: number): string => new Date(APPROVAL_NOW + minutes * 60_000).toISOString();
  const refactor = syntheticSession({
    runId: "0mfk1a2b3c4d5e6f7a8b9c0d1" as SessionView["runId"],
    name: "Refactor parser",
    projectName: "example-project",
    state: "running",
    startedAt: at(-60),
    lastActivityAt: at(-1),
  });
  const notes = syntheticSession({
    runId: "0mfk1a2b3c4d5e6f7a8b9c0d3" as SessionView["runId"],
    name: "Draft the release notes",
    projectName: "sample-notes",
    state: "running",
    startedAt: at(-30),
    lastActivityAt: at(-2),
  });
  sessionsById.value = new Map([
    [refactor.runId, refactor],
    [notes.runId, notes],
  ]);
  usageSummary.value = null;
  selectedRunId.value = null;
}

let approvalsSeeded = false;

/**
 * Seeds the signals for one case, once per page load. Seeding writes signals a
 * rendered child reads, so running it on every render would feed itself.
 */
function seedApprovalsCase(spec: ApprovalCaseSpec): void {
  if (approvalsSeeded) return;
  approvalsSeeded = true;
  resetApprovalsState();
  resetApprovalsView();
  configureApprovalsApi(fakeApprovalsApi(spec));
  seedApprovalSessions();
  connectionState.value = spec.connection;
  if (spec.inbox === "full" || spec.inbox === "empty") {
    adoptApprovalsSnapshot(approvalSnapshot(spec.inbox));
  }
  approvalChip.value = spec.chip;
  approvalsMissedSync.value = spec.missedSync === true;
  if (spec.selected !== null) {
    const id = APPROVAL_FIXTURES.ids[spec.selected];
    if (id === undefined) throw new Error(`No approval fixture named ${spec.selected}.`);
    selectedProposalId.value = id;
    approvalDetailFocusRequested.value = true;
  }
}

let readyMarkerStarted = false;

/**
 * Marks the document ready once the cell shows what its case exists to show,
 * and, for the hash-mismatch case, presses Approve once as soon as it is
 * available. Started once per page load: a harness page renders one cell.
 */
function startReadyMarker(selector: string, mismatch: boolean): void {
  if (readyMarkerStarted) return;
  readyMarkerStarted = true;
  let tries = 0;
  let pressed = false;
  const timer = setInterval(() => {
    tries += 1;
    if (mismatch && !pressed) {
      const approve = document.querySelector<HTMLButtonElement>(
        '[data-decision="approve"]:not([aria-disabled="true"])',
      );
      if (approve !== null) {
        pressed = true;
        approve.click();
      }
    }
    if (document.querySelector(selector) !== null || tries > 300) {
      clearInterval(timer);
      // One more beat: focus moves in an effect after the pane has painted.
      setTimeout(() => document.documentElement.setAttribute("data-harness-ready", "true"), 60);
    }
  }, 10);
}

function ApprovalsCell({
  caseName,
  width,
}: {
  readonly caseName: string;
  readonly width: ApprovalWidth;
}) {
  const spec = APPROVAL_CASES[caseName];
  if (spec === undefined) return <HarnessError message={`Unknown approvals case "${caseName}".`} />;
  seedApprovalsCase(spec);
  startReadyMarker(spec.readyWhen, spec.mismatch === true);

  const narrow = width === "narrow";
  if (caseName === "shell-nav-count") {
    // The real tab strip the shell renders, with the Agent runs count chip.
    const tabs = (
      <DestinationTabs activeId="agent-runs" pendingCount={pendingApprovalCount.value} />
    );
    // Harness-only: a fixed width stands in for the narrow side pane the
    // container queries read. Test infrastructure, not plugin production code.
    return (
      <Root motion={motionMode.value}>
        {narrow ? (
          <div data-harness-width="narrow" style={{ width: "22rem" }}>
            {tabs}
          </div>
        ) : (
          <div data-harness-width="full">{tabs}</div>
        )}
      </Root>
    );
  }

  const body = (
    <div className="ccc-content">
      <h2>Agent runs</h2>
      <AgentRuns now={APPROVAL_NOW} onQuickAction={() => {}} />
    </div>
  );
  return (
    <Root motion={motionMode.value}>
      {narrow ? (
        <div data-harness-width="narrow" style={{ width: "22rem" }}>
          {body}
        </div>
      ) : (
        <div data-harness-width="full">{body}</div>
      )}
    </Root>
  );
}

// ---------------------------------------------------------------------------
// The Tasks cells (UI-SPEC "Visual regression and fixtures", plan 06-22).
//
// `view=tasks&case=tasks-*&width=full|narrow&motion=full|reduced` render the
// REAL Tasks destination; `view=projects&case=project-tasks` renders the REAL
// project tasks panel. Every value comes from `task-fixtures.json` (synthetic:
// projects example-project, sample-notes, demo-api; workspace Example
// workspace; vault-relative paths; times from the frozen `now`; hostile text on
// example.invalid) or from a literal here. The service and the note port are
// fakes over that file: nothing here can reach a client, a vault or the network.
// ---------------------------------------------------------------------------

interface TaskFixtureFile {
  readonly now: string;
  readonly zone: string;
  readonly projects: readonly { readonly id: string; readonly name: string }[];
  readonly workspaces: readonly { readonly id: string; readonly name: string }[];
  readonly rows: Readonly<Record<string, Record<string, unknown>>>;
  readonly lists: Readonly<Record<string, readonly string[]>>;
  readonly counts: unknown;
  readonly zeroCounts: unknown;
  readonly details: Readonly<Record<string, Record<string, unknown>>>;
  readonly notes: Readonly<Record<string, string>>;
  readonly attention: unknown;
}

const TASK_FIXTURES = taskFixtureFile as unknown as TaskFixtureFile;
const TASK_NOW = Date.parse(TASK_FIXTURES.now);
const TASK_ROWS_BY_ID = new Map(
  Object.values(TASK_FIXTURES.rows).map((row) => [row.id as string, row]),
);
const TASK_WIDTHS = ["full", "narrow"] as const;

type TaskFilterName = ReturnType<typeof createTasksContext>["filter"]["value"];

/** One scripted interaction a case performs once its element exists. */
interface TaskStep {
  readonly click?: string;
  readonly input?: readonly [selector: string, value: string];
}

interface TasksCaseSpec {
  readonly view: "tasks" | "projects";
  readonly filter: TaskFilterName;
  readonly list: "full" | "empty" | "loading" | "error";
  readonly counts: "full" | "zero";
  readonly connection: ConnectionState;
  readonly rebuilding?: boolean;
  /** The row selected before the destination mounts (its detail loads). */
  readonly selected?: string;
  readonly attention?: boolean;
  readonly saveConflict?: boolean;
  readonly createNever?: boolean;
  readonly steps?: readonly TaskStep[];
  readonly readyWhen: string;
}

const TASK_LIVE: ConnectionState = { kind: "live" };
const CREATE_BUTTON =
  ".ccc-tasks-header .ccc-connect-button, .ccc-project-tasks-header .ccc-connect-button";
const PANE_READY = ".ccc-tasks-pane .ccc-task-detail h3";
const TITLE_FIELD = '.ccc-task-detail input[type="text"], .ccc-task-detail input:not([type])';
const FIRST_ID = (TASK_FIXTURES.lists.today ?? [])[0] ?? "";
const FOURTH_ID = (TASK_FIXTURES.lists.overdue ?? [])[0] ?? "";
const PROPOSED_ID = (TASK_FIXTURES.lists.proposed ?? [])[0] ?? "";
const HOSTILE_ID = (Object.values(TASK_FIXTURES.rows).find((row) =>
  String(row.title).startsWith("<script>"),
)?.id ?? "") as string;

const DIRTY_STEPS: readonly TaskStep[] = [
  { input: [TITLE_FIELD, "Draft the weekly review, revised"] },
];

const TASKS_CASES: Readonly<Record<string, TasksCaseSpec>> = {
  "tasks-today": {
    view: "tasks",
    filter: "today",
    list: "full",
    counts: "full",
    connection: TASK_LIVE,
    selected: FIRST_ID,
    readyWhen: PANE_READY,
  },
  "tasks-overdue-blocked": {
    view: "tasks",
    filter: "overdue",
    list: "full",
    counts: "full",
    connection: TASK_LIVE,
    readyWhen: ".ccc-task-row",
  },
  "tasks-proposed": {
    view: "tasks",
    filter: "proposed",
    list: "full",
    counts: "full",
    connection: TASK_LIVE,
    readyWhen: ".ccc-task-row [data-action='accept']",
  },
  "tasks-create-form": {
    view: "tasks",
    filter: "today",
    list: "full",
    counts: "full",
    connection: TASK_LIVE,
    steps: [{ click: CREATE_BUTTON }],
    readyWhen: ".ccc-task-form",
  },
  "tasks-create-form-error": {
    view: "tasks",
    filter: "today",
    list: "full",
    counts: "full",
    connection: TASK_LIVE,
    steps: [{ click: CREATE_BUTTON }, { click: '.ccc-task-form button[type="submit"]' }],
    readyWhen: ".ccc-task-form .ccc-field-error",
  },
  "tasks-create-form-busy": {
    view: "tasks",
    filter: "today",
    list: "full",
    counts: "full",
    connection: TASK_LIVE,
    createNever: true,
    steps: [
      { click: CREATE_BUTTON },
      {
        input: [
          '.ccc-task-form input[type="text"], .ccc-task-form input:not([type])',
          "Plan the offsite",
        ],
      },
      { click: '.ccc-task-form button[type="submit"]' },
    ],
    readyWhen: '.ccc-task-form [aria-busy="true"]',
  },
  "tasks-create-form-disconnected": {
    view: "tasks",
    filter: "today",
    list: "full",
    counts: "full",
    connection: { kind: "disconnected", reason: "fixture" },
    readyWhen: ".ccc-task-row",
  },
  "tasks-detail-clean": {
    view: "tasks",
    filter: "today",
    list: "full",
    counts: "full",
    connection: TASK_LIVE,
    selected: FIRST_ID,
    readyWhen: PANE_READY,
  },
  "tasks-detail-dirty": {
    view: "tasks",
    filter: "today",
    list: "full",
    counts: "full",
    connection: TASK_LIVE,
    selected: FIRST_ID,
    steps: DIRTY_STEPS,
    readyWhen: ".ccc-tasks-pane .ccc-task-dirty",
  },
  "tasks-detail-confirm": {
    view: "tasks",
    filter: "today",
    list: "full",
    counts: "full",
    connection: TASK_LIVE,
    selected: FIRST_ID,
    steps: [
      ...DIRTY_STEPS,
      {
        click: `.ccc-task-row[data-task-id="${(TASK_FIXTURES.lists.today ?? [])[1] ?? ""}"] .ccc-task-title`,
      },
    ],
    readyWhen: ".ccc-tasks-pane .ccc-task-confirm",
  },
  "tasks-detail-conflict": {
    view: "tasks",
    filter: "today",
    list: "full",
    counts: "full",
    connection: TASK_LIVE,
    selected: FIRST_ID,
    saveConflict: true,
    steps: [...DIRTY_STEPS, { click: '.ccc-tasks-pane button[data-variant="primary"]' }],
    readyWhen: ".ccc-tasks-pane .ccc-task-note",
  },
  "tasks-detail-blocked": {
    view: "tasks",
    filter: "overdue",
    list: "full",
    counts: "full",
    connection: TASK_LIVE,
    selected: FOURTH_ID,
    readyWhen: PANE_READY,
  },
  "tasks-detail-suggested": {
    view: "tasks",
    filter: "proposed",
    list: "full",
    counts: "full",
    connection: TASK_LIVE,
    selected: PROPOSED_ID,
    readyWhen: ".ccc-tasks-pane .ccc-task-block",
  },
  "tasks-detail-hostile": {
    view: "tasks",
    filter: "today",
    list: "full",
    counts: "full",
    connection: TASK_LIVE,
    selected: HOSTILE_ID,
    readyWhen: PANE_READY,
  },
  "tasks-attention": {
    view: "tasks",
    filter: "today",
    list: "full",
    counts: "full",
    connection: TASK_LIVE,
    attention: true,
    readyWhen: ".ccc-attention-row",
  },
  "tasks-empty": {
    view: "tasks",
    filter: "upcoming",
    list: "empty",
    counts: "full",
    connection: TASK_LIVE,
    readyWhen: ".ccc-task-list-empty, .ccc-state-heading",
  },
  "tasks-none": {
    view: "tasks",
    filter: "today",
    list: "empty",
    counts: "zero",
    connection: TASK_LIVE,
    readyWhen: ".ccc-task-list-empty, .ccc-state-heading",
  },
  "tasks-loading": {
    view: "tasks",
    filter: "today",
    list: "loading",
    counts: "full",
    connection: TASK_LIVE,
    readyWhen: ".ccc-task-skeleton",
  },
  "tasks-stale": {
    view: "tasks",
    filter: "today",
    list: "full",
    counts: "full",
    connection: TASK_LIVE,
    rebuilding: true,
    readyWhen: ".ccc-task-row",
  },
  "tasks-error": {
    view: "tasks",
    filter: "today",
    list: "error",
    counts: "full",
    connection: TASK_LIVE,
    readyWhen: ".ccc-task-list-error",
  },
  "tasks-disconnected": {
    view: "tasks",
    filter: "today",
    list: "full",
    counts: "full",
    connection: { kind: "disconnected", reason: "fixture" },
    readyWhen: ".ccc-task-row",
  },
  "project-tasks": {
    view: "projects",
    filter: "all",
    list: "full",
    counts: "full",
    connection: TASK_LIVE,
    readyWhen: ".ccc-task-row",
  },
};

function isTasksCase(name: string): boolean {
  return Object.hasOwn(TASKS_CASES, name);
}

const TASK_NOTE_UNREADABLE = { kind: "unreadable", reason: "read-failed" } as const;

function rowsForFilter(filter: string, projectId?: string): readonly Record<string, unknown>[] {
  return (TASK_FIXTURES.lists[filter] ?? [])
    .map((id) => TASK_ROWS_BY_ID.get(id))
    .filter((row): row is Record<string, unknown> => row !== undefined)
    .filter((row) => projectId === undefined || row.projectId === projectId);
}

/** Chip counts for one project, from the same fixture lists the rows come from. */
function projectCounts(projectId: string): unknown {
  const count = (filter: string): number => rowsForFilter(filter, projectId).length;
  const closed = new Set(["done", "cancelled", "proposed"]);
  const open = rowsForFilter("all", projectId).filter((row) => !closed.has(String(row.status)));
  return {
    counts: {
      all: count("all"),
      today: count("today"),
      upcoming: count("upcoming"),
      overdue: count("overdue"),
      project: count("all"),
      proposed: count("proposed"),
      blocked: count("blocked"),
      completed: count("completed"),
    },
    open: open.length,
  };
}

function fakeTasksApi(spec: TasksCaseSpec): TasksApi {
  const unused = (): Promise<never> => Promise.reject(new TasksApiError("service-disconnected"));
  return {
    create: () =>
      spec.createNever === true
        ? new Promise<never>(() => {})
        : Promise.reject(new TasksApiError("timeout")),
    list: (request) => {
      if (spec.list === "loading") return new Promise<never>(() => {});
      if (spec.list === "error") return Promise.reject(new TasksApiError("timeout"));
      const rows =
        spec.list === "empty" ? [] : rowsForFilter(request.filter, request.context.projectId);
      return Promise.resolve({
        rows,
        total: rows.length,
        nextCursor: null,
        chooseProject: false,
      } as never);
    },
    counts: (request) =>
      Promise.resolve(
        (request.context.projectId !== undefined
          ? projectCounts(request.context.projectId)
          : spec.counts === "zero"
            ? TASK_FIXTURES.zeroCounts
            : TASK_FIXTURES.counts) as never,
      ),
    get: (request) => {
      const detail = TASK_FIXTURES.details[request.taskId];
      return detail === undefined
        ? Promise.reject(new TasksApiError("not-found"))
        : Promise.resolve({ task: detail } as never);
    },
    changed: () => Promise.resolve({ accepted: 1, generation: 1 }),
    rebuild: unused,
    attention: () =>
      Promise.resolve(
        (spec.attention === true
          ? TASK_FIXTURES.attention
          : { items: [], total: 0, nextCursor: null }) as never,
      ),
    dueToday: unused,
  };
}

function fakeTaskPort(spec: TasksCaseSpec): TaskActionsPort {
  const applied = () =>
    Promise.resolve({ kind: "applied", content: "", task: {}, notified: true } as never);
  return {
    complete: applied,
    reopen: applied,
    accept: applied,
    dismiss: applied,
    save: () =>
      spec.saveConflict === true ? Promise.resolve({ kind: "conflict" } as const) : applied(),
    readForEdit: (path) => {
      const content = TASK_FIXTURES.notes[path];
      return Promise.resolve(
        content === undefined ? TASK_NOTE_UNREADABLE : parseTaskContent(content),
      );
    },
    openNote: () => {},
  };
}

function setNativeValue(element: HTMLInputElement, value: string): void {
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

let tasksReadyStarted = false;

/** Runs the case's scripted steps in order, then marks the document ready once its element shows. */
function startTasksReady(spec: TasksCaseSpec): void {
  if (tasksReadyStarted) return;
  tasksReadyStarted = true;
  const steps = [...(spec.steps ?? [])];
  let tries = 0;
  let lastStepAt = 0;
  const timer = setInterval(() => {
    tries += 1;
    const step = steps[0];
    // One step per beat: effects (the dirty flag, focus) settle between presses.
    if (step !== undefined && Date.now() - lastStepAt < 80) return;
    if (step !== undefined) {
      const selector = step.click ?? step.input?.[0] ?? "";
      const target = document.querySelector<HTMLElement>(selector);
      if (target !== null) {
        steps.shift();
        lastStepAt = Date.now();
        if (step.click !== undefined) target.click();
        else if (step.input !== undefined && target instanceof HTMLInputElement) {
          setNativeValue(target, step.input[1]);
        }
      }
    } else if (document.querySelector(spec.readyWhen) !== null || tries > 400) {
      clearInterval(timer);
      setTimeout(() => document.documentElement.setAttribute("data-harness-ready", "true"), 60);
    }
    if (tries > 400) clearInterval(timer);
  }, 10);
}

let tasksSeeded: {
  readonly context: ReturnType<typeof createTasksContext>;
  readonly view: ReturnType<typeof createTasksViewState>;
} | null = null;

function seedTasksCase(spec: TasksCaseSpec) {
  if (tasksSeeded !== null) return tasksSeeded;
  configureTasksApi(fakeTasksApi(spec));
  configureTaskActionsPort(fakeTaskPort(spec));
  connectionState.value = spec.connection;
  tasksRebuilding.value = spec.rebuilding === true;
  tasksAttention.items.value = [];
  tasksAttention.total.value = 0;
  const zone = () => TASK_FIXTURES.zone;
  const projectId = TASK_FIXTURES.projects[0]?.id ?? "";
  const context =
    spec.view === "projects"
      ? createProjectTasksContext(projectId, { zone })
      : createTasksContext("global", { zone });
  if (spec.view === "tasks") context.filter.value = spec.filter;
  if (spec.selected !== undefined) context.select(spec.selected);
  tasksSeeded = { context, view: createTasksViewState() };
  return tasksSeeded;
}

function TasksCell({ caseName, width }: { readonly caseName: string; readonly width: string }) {
  const spec = TASKS_CASES[caseName];
  if (spec === undefined) return <HarnessError message={`Unknown tasks case "${caseName}".`} />;
  const seeded = seedTasksCase(spec);
  startTasksReady(spec);
  const connection = spec.connection;
  const body =
    spec.view === "projects" ? (
      <div className="ccc-content">
        <h2>Projects</h2>
        <div className="ccc-projects-section">
          <ProjectTasksPanel
            projectId={TASK_FIXTURES.projects[0]?.id ?? ""}
            projectName={TASK_FIXTURES.projects[0]?.name ?? ""}
            connection={connection}
            now={TASK_NOW}
            zone={TASK_FIXTURES.zone}
            context={seeded.context}
            view={seeded.view}
            projects={TASK_FIXTURES.projects}
            workspaces={TASK_FIXTURES.workspaces}
            onClose={() => {}}
          />
        </div>
      </div>
    ) : (
      <div className="ccc-content">
        <h2>Tasks</h2>
        <TasksDestination
          connection={connection}
          now={TASK_NOW}
          zone={TASK_FIXTURES.zone}
          context={seeded.context}
          view={seeded.view}
          projects={TASK_FIXTURES.projects}
          workspaces={TASK_FIXTURES.workspaces}
        />
      </div>
    );
  return (
    <Root motion={motionMode.value}>
      {width === "narrow" ? (
        <div data-harness-width="narrow" style={{ width: "22rem" }}>
          {body}
        </div>
      ) : (
        <div data-harness-width="full">{body}</div>
      )}
    </Root>
  );
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

  if ((view === "tasks" || view === "projects") && isTasksCase(params.get("case") ?? "")) {
    const width = params.get("width") ?? "full";
    if (!(TASK_WIDTHS as readonly string[]).includes(width)) {
      return <HarnessError message={`Unknown width "${width}" — expected full or narrow.`} />;
    }
    return <TasksCell caseName={params.get("case") ?? ""} width={width} />;
  }

  if (view === "agent-runs") {
    const agentRunsCase = params.get("case") ?? "";
    if (isApprovalsCase(agentRunsCase)) {
      const width = params.get("width") ?? "full";
      if (!isApprovalWidth(width)) {
        return <HarnessError message={`Unknown width "${width}" — expected full or narrow.`} />;
      }
      return <ApprovalsCell caseName={agentRunsCase} width={width} />;
    }
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
