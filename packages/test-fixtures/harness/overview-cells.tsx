/**
 * The Overview slice cells of the visual harness (plan 08-21; Phase 8 UI-SPEC "Contrast pages" and
 * "Visual regression and fixtures", D-22).
 *
 *   index.html?view=overview&case=overview-slice-ready&host=dark
 *
 * Every cell mounts the REAL `Overview` grid from `@ccc/plugin` with the five slice widgets
 * (Today, Active Claude sessions, Project shortcuts, Technology and market intelligence, Quick
 * actions) against the production stylesheet. The Today and Technology states are not hand-drawn:
 * they come out of the plugin's own mappings (`todayStateFor`, `techIntelStateFor`) fed with the
 * synthetic feed answers in `overview-fixtures.json`, so the strings on those cards are the shipped
 * ones. The other three cards get a typed `WidgetState` built from the same file.
 *
 * PRIVACY (PRIV-04 layer 1, T-03-03, T-08-52). This module may import exactly three modules:
 * `preact`, `@ccc/plugin` and the synthetic `overview-fixtures.json` (plus the tolerated signals
 * package). `src/harness-purity.test.ts` enforces that set by source scan; every value on screen
 * comes from that file or from a literal here. Nothing here is reachable from a production build
 * (D-22): the harness bundle is the only place this module is bundled.
 *
 * DETERMINISM. `now` is the fixture's own frozen `now`; the feeds' `fetchedAt` is that same value
 * minus the case's age, so `live` and `stale` follow from the case and never from the wall clock.
 */

import type {
  ActiveSessionsData,
  ConnectionState,
  FeedSnapshot,
  LatestReportAnswer,
  LayoutResolution,
  ProjectShortcutsData,
  QuickActionsData,
  ResearchStatusResponse,
  WidgetId,
  WidgetState,
} from "@ccc/plugin";
import {
  connectionState,
  DestinationTabs,
  motionMode,
  Overview,
  techIntelStateFor,
  todayStateFor,
  WIDGETS,
  WidgetHostContext,
} from "@ccc/plugin";
import { type ReadonlySignal, signal } from "@preact/signals";
import type { VNode } from "preact";
import fixtureFile from "./overview-fixtures.json";

// ---------------------------------------------------------------------------
// The fixture file's shape.
// ---------------------------------------------------------------------------

type DueTodayAnswer = NonNullable<Parameters<typeof todayStateFor>[0]["tasks"]["value"]>;

type OtherState = "ready" | "empty" | "stale" | "loading" | "error";

/** The two data sets the three non-feed cards have. */
type CardKind = "ready" | "empty";

interface TodaySpec {
  readonly tasks: string;
  readonly automation: string;
  /** How long before `now` the feeds answered. */
  readonly ageMs: number;
}

interface TechSpec {
  readonly reports: string;
  readonly ageMs: number;
}

interface CaseSpec {
  readonly connection: "live" | "disconnected";
  /** `null` for the loading case: the feeds have not answered yet. */
  readonly today: TodaySpec | null;
  readonly tech: TechSpec | null;
  readonly others: OtherState;
}

interface FixtureFile {
  readonly now: string;
  readonly zone: string;
  readonly feeds: {
    readonly dueToday: Readonly<Record<string, DueTodayAnswer>>;
    readonly automation: Readonly<Record<string, ResearchStatusResponse>>;
    readonly reports: Readonly<Record<string, LatestReportAnswer>>;
  };
  readonly cards: {
    readonly projectShortcuts: Readonly<Record<CardKind, ProjectShortcutsData>>;
    readonly quickActions: QuickActionsData;
    readonly activeSessions: Readonly<Record<CardKind, Omit<ActiveSessionsData, "nowMs">>>;
  };
  readonly cases: Readonly<Record<string, CaseSpec>>;
}

const FIXTURES = fixtureFile as unknown as FixtureFile;
const NOW = Date.parse(FIXTURES.now);

const LIVE: ConnectionState = { kind: "live" };
const DISCONNECTED: ConnectionState = { kind: "disconnected", reason: "connect ECONNREFUSED" };

/** The slice widgets, in the PRD panel order. */
const SLICE_WIDGETS = [
  "today",
  "active-sessions",
  "project-shortcuts",
  "tech-intel",
  "quick-actions",
] as const satisfies readonly WidgetId[];

/** What the harness renders the Overview inside: the production content width. */
const PANE_WIDTH = "64rem";

function HarnessError({ message }: { readonly message: string }): VNode {
  // Harness-only: a typo in the spec must never produce a blank baseline.
  return <p className="ccc-harness-error">{message}</p>;
}

function answered<T>(value: T | null, ageMs: number): FeedSnapshot<T> {
  return { settled: true, value, fetchedAt: NOW - ageMs, failed: false };
}

const UNANSWERED: FeedSnapshot<never> = {
  settled: false,
  value: null,
  fetchedAt: null,
  failed: false,
};

function todayState(spec: TodaySpec | null, connection: ConnectionState): WidgetState<unknown> {
  const feeds =
    spec === null
      ? { tasks: UNANSWERED, automation: UNANSWERED }
      : {
          tasks: answered(FIXTURES.feeds.dueToday[spec.tasks] ?? null, spec.ageMs),
          automation: answered(FIXTURES.feeds.automation[spec.automation] ?? null, spec.ageMs),
        };
  return todayStateFor(feeds, connection, NOW, FIXTURES.zone);
}

function techState(spec: TechSpec | null, connection: ConnectionState): WidgetState<unknown> {
  const feed =
    spec === null ? UNANSWERED : answered(FIXTURES.feeds.reports[spec.reports] ?? null, spec.ageMs);
  return techIntelStateFor(feed, connection, NOW);
}

/** A typed `ready` state for the three cards the feeds do not drive. */
function readyOf<T>(data: T, kind: OtherState): WidgetState<unknown> {
  if (kind === "loading") return { kind: "loading" };
  if (kind === "error") return { kind: "error", message: "The source failed." };
  const stale = kind === "stale";
  return {
    kind: "ready",
    data,
    observedAt: new Date(NOW - (stale ? 600_000 : 90_000)).toISOString(),
    freshness: stale ? "stale" : "live",
    partiality: { partial: false },
    isEmpty: kind === "empty",
  };
}

function stateFor(id: WidgetId, spec: CaseSpec, connection: ConnectionState): WidgetState<unknown> {
  const others = spec.others;
  const card: CardKind = others === "empty" ? "empty" : "ready";
  switch (id) {
    case "today":
      return todayState(spec.today, connection);
    case "tech-intel":
      return techState(spec.tech, connection);
    case "project-shortcuts":
      return readyOf(FIXTURES.cards.projectShortcuts[card], others);
    case "active-sessions":
      return readyOf(
        { ...FIXTURES.cards.activeSessions[card], nowMs: NOW } satisfies ActiveSessionsData,
        others,
      );
    case "quick-actions":
      // The launcher summary has no empty look of its own: it stays ready when the rest are empty.
      return readyOf(FIXTURES.cards.quickActions, others === "empty" ? "ready" : others);
    default:
      return { kind: "unavailable" };
  }
}

/** The five cards at their preferred sizes, as the resolved layout the grid takes. */
const LAYOUT: LayoutResolution = {
  entries: SLICE_WIDGETS.map((widgetId) => ({
    widgetId,
    size: WIDGETS[widgetId].preferredSize,
  })),
  skipped: [],
};

/** The host the real shell provides: a quick switcher is wired, so the launch pair renders live. */
const HARNESS_WIDGET_HOST = { switcherAvailable: true } as const;

// ---------------------------------------------------------------------------
// Readiness: the grid renders synchronously from the signals, so the cell is ready once all five
// cards are on screen; one beat for the last paint to settle.
// ---------------------------------------------------------------------------

let readyStarted = false;

function startReady(): void {
  if (readyStarted) return;
  readyStarted = true;
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    if (document.querySelectorAll(".ccc-card").length === SLICE_WIDGETS.length || tries > 1500) {
      clearInterval(timer);
      setTimeout(() => document.documentElement.setAttribute("data-harness-ready", "true"), 120);
    }
  }, 10);
}

// ---------------------------------------------------------------------------
// The entry the harness delegates to.
// ---------------------------------------------------------------------------

/** The `view` value this module owns; `main.tsx` delegates exactly this. */
export function isOverviewView(view: string): boolean {
  return view === "overview";
}

/**
 * Renders one Overview slice cell from the page's query parameters: `case`
 * (`overview-slice-<state>`) and `nav=1` for the tab strip. `motion` is validated and applied by
 * the harness entry before it delegates here.
 */
export function OverviewCell({ params }: { readonly params: URLSearchParams }): VNode {
  const caseId = params.get("case") ?? "";
  const spec = FIXTURES.cases[caseId];
  if (spec === undefined) {
    return <HarnessError message={`Unknown overview case "${caseId}".`} />;
  }
  const connection = spec.connection === "disconnected" ? DISCONNECTED : LIVE;
  connectionState.value = connection;
  const states = new Map<WidgetId, ReadonlySignal<WidgetState<unknown>>>(
    SLICE_WIDGETS.map((id) => [id, signal<WidgetState<unknown>>(stateFor(id, spec, connection))]),
  );
  startReady();
  return (
    <div className="ccc-command-center" data-motion={motionMode.value}>
      <div data-harness-width="full" style={{ width: PANE_WIDTH }}>
        {params.get("nav") === "1" ? (
          <DestinationTabs activeId="overview" pendingCount={0} />
        ) : null}
        <div className="ccc-content">
          <WidgetHostContext.Provider value={HARNESS_WIDGET_HOST}>
            <Overview
              layout={LAYOUT}
              stateFor={(id) =>
                states.get(id) ?? signal<WidgetState<unknown>>({ kind: "unavailable" })
              }
              connection={connection}
              now={NOW}
              onNavigate={() => {}}
              onQuickAction={() => {}}
            />
          </WidgetHostContext.Provider>
        </div>
      </div>
    </div>
  );
}
