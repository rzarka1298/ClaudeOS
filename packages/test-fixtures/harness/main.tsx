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
  TechIntelData,
  TodayData,
  WidgetId,
  WidgetState,
} from "@ccc/plugin";
import {
  connectionState,
  isWidgetId,
  motionMode,
  serviceHealthStateFor,
  WIDGETS,
  WidgetFrame,
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
function quantity(value: unknown): number {
  const match = /(\d+(?:\.\d+)?)\s*([KM])?/i.exec(text(value));
  if (match === null) return 0;
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

const SESSION_STATUS: Readonly<Record<string, ActiveSessionsData["rows"][number]["status"]>> = {
  Running: "running",
  "Waiting for approval": "waiting-for-approval",
  "Recently completed": "recently-completed",
  Failed: "failed",
};

function adaptActiveSessions(data: Fields): ActiveSessionsData {
  return {
    rows: list(data.rows).map((row) => ({
      id: `${text(row.project)}-${text(row.name)}`,
      project: text(row.project),
      name: text(row.name),
      model: typeof row.model === "string" ? row.model : null,
      elapsed: text(row.elapsed),
      // No prototype counterpart; stated rather than invented.
      lastActivity: "last activity not reported",
      // "Stale or unknown" and anything unrecognised map to `unknown` — never
      // an invented terminal state (project data-integrity constraint).
      status: SESSION_STATUS[text(row.status)] ?? "unknown",
    })),
  };
}

function adaptProjectShortcuts(data: Fields): ProjectShortcutsData {
  return {
    projects: list(data.rows).map((row) => ({
      id: text(row.project),
      name: text(row.project),
      pinned: true,
      branch: text(row.branch),
      dirty: text(row.dirty) !== "Clean",
      openItems: quantity(row.openIssues),
      sessionCount: quantity(row.sessions),
      nextTask: null,
    })),
  };
}

function adaptClaudeUsage(data: Fields): ClaudeUsageData {
  const tokens = data.tokens as Fields | null | undefined;
  const estimate = data.estimate as Fields | null | undefined;
  return {
    // The fixture's capacity note says account capacity is unavailable, so
    // every limit is `null` — rendered "Capacity unavailable", never zero.
    bars: list(data.bars).map((bar) => ({
      label: text(bar.label),
      used: quantity(bar.valueText),
      limit: null,
    })),
    tokens:
      tokens === null || tokens === undefined
        ? { input: 0, output: 0, cache: 0 }
        : {
            input: quantity(tokens.input),
            output: quantity(tokens.output),
            cache: quantity(tokens.cache),
          },
    estimate: estimate === null || estimate === undefined ? null : text(estimate.value),
  };
}

function adaptTechIntel(data: Fields): TechIntelData {
  return {
    stories: list(data.rows).map((row) => ({
      id: text(row.headline),
      headline: text(row.headline),
      category: text(row.category),
      summary: text(row.summary),
      sourceCount: quantity(row.sourceCount),
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
  // The panel's content IS its declared quick actions, rendered by the frame.
  return {};
}

const ADAPTERS: { readonly [K in WidgetId]: (data: Fields) => unknown } = {
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

function readyFrom(id: WidgetId, variant: FixtureVariant, isEmpty: boolean): WidgetState<unknown> {
  return {
    kind: "ready",
    data: ADAPTERS[id](variant.data),
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
      return { state: readyFrom(id, states.live, false), connection: LIVE };
    case "stale":
      return { state: readyFrom(id, states.stale, false), connection: LIVE };
    case "empty":
      return { state: readyFrom(id, states.empty, true), connection: LIVE };
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
      return { state: readyFrom(id, states.live, false), connection };
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

function HarnessCell() {
  const params = new URLSearchParams(location.search);
  const widget = params.get("widget") ?? "";
  const state = params.get("state") ?? "ready";
  const motion = params.get("motion") ?? "full";

  if (motion !== "full" && motion !== "reduced") {
    return <HarnessError message={`Unknown motion "${motion}" — expected full or reduced.`} />;
  }
  motionMode.value = motion;

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

  return (
    <Root motion={motionMode.value}>
      <div className="ccc-harness-cell" data-size={definition.preferredSize}>
        <WidgetFrame
          definition={definition}
          state={cell.state}
          connection={connectionState.value}
          size={definition.preferredSize}
          now={NOW}
          onQuickAction={() => {}}
        />
      </div>
    </Root>
  );
}

const root = document.getElementById("root");
if (root !== null) render(<HarnessCell />, root);
