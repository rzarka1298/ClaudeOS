/**
 * The Research cells of the visual harness (plan 07-16; Phase 7 UI-SPEC "Visual
 * regression and fixtures", ADR-0023).
 *
 *   index.html?view=research&case=research-report-full&width=narrow&motion=full
 *
 * Every cell mounts the REAL `ResearchDestination` from `@ccc/plugin` against
 * the production stylesheet, with a fixture-backed `ResearchApi` and the frozen
 * fixture `now`, so a baseline regresses when the shipped markup, copy or CSS
 * does and not when a copy of it drifts. The destination decides what each
 * state draws; this module only hands it the connection, the API and (for the
 * report cells) presses the one row button the owner would press.
 *
 * PRIVACY (PRIV-04 layer 1, T-03-03, T-07-43). This module may import exactly
 * three modules: `preact`, `@ccc/plugin` and the synthetic
 * `research-fixtures.json` (plus the tolerated signals package).
 * `src/harness-purity.test.ts` enforces that set by source scan, and
 * `src/research-fixtures-privacy.test.ts` pins what the fixture file may say.
 * Every value on screen therefore comes from that fixture file or from a
 * literal in this file. No cell reaches a socket: the API object answers from
 * memory.
 *
 * DETERMINISM. `now` is the fixture's own frozen `now`. Pane widths are fixed
 * boxes (the narrow pane is 24rem, the full pane 64rem); the boxes are test
 * infrastructure, not plugin code, so the plugin's "no inline style" rule does
 * not apply to them. The document is marked ready only once the state the case
 * names is on screen.
 */

import type {
  ConnectionState,
  ResearchApi,
  ResearchListRow,
  ResearchReportHeader,
  ResearchReportItem,
  ResearchReportResponse,
  ResearchReportSource,
  ResearchStatusResponse,
} from "@ccc/plugin";
import {
  configureResearch,
  connectionState,
  DestinationTabs,
  motionMode,
  ResearchApiError,
  ResearchDestination,
} from "@ccc/plugin";
import type { VNode } from "preact";
import fixtureFile from "./research-fixtures.json";

// ---------------------------------------------------------------------------
// The fixture file's shape. Declared here rather than inferred so the cells
// read named fields, not a deep JSON literal union.
// ---------------------------------------------------------------------------

interface ReportFixture {
  readonly header: ResearchReportHeader;
  readonly items: readonly ResearchReportItem[];
  readonly sources: readonly ResearchReportSource[];
}

interface CaseFixture {
  /** A named status in `statuses`; absent for the behaviour cells. */
  readonly status?: string;
  /** A named row list in `lists`. */
  readonly list?: string;
  /** The note id of the report the cell opens by pressing its (first) row. */
  readonly open?: string;
  readonly connection: "live" | "disconnected";
  /** `loading` never answers; `error` rejects every call with `errorCode`. */
  readonly behaviour?: "loading" | "error";
  readonly errorCode?: ConstructorParameters<typeof ResearchApiError>[0];
}

interface FixtureFile {
  readonly now: string;
  readonly zone: string;
  readonly cases: Readonly<Record<string, CaseFixture>>;
  readonly statuses: Readonly<Record<string, ResearchStatusResponse>>;
  readonly lists: Readonly<Record<string, readonly ResearchListRow[]>>;
  readonly reports: Readonly<Record<string, ReportFixture>>;
}

const FIXTURES = fixtureFile as unknown as FixtureFile;
const NOW = Date.parse(FIXTURES.now);

const LIVE: ConnectionState = { kind: "live" };
const DISCONNECTED: ConnectionState = { kind: "disconnected", reason: "connect ECONNREFUSED" };

/** The two pane widths every cell renders at (UI-SPEC: narrow <= 24rem, full >= 64rem). */
const PANE_WIDTH = { narrow: "24rem", full: "64rem" } as const;
type Width = keyof typeof PANE_WIDTH;

function isWidth(value: string): value is Width {
  return Object.hasOwn(PANE_WIDTH, value);
}

/** The findings per items page the service serves (RESEARCH_ITEMS_PAGE_SIZE). */
const ITEMS_PAGE_SIZE = 10;

function HarnessError({ message }: { readonly message: string }): VNode {
  // Harness-only: a typo in the spec must never produce a blank baseline.
  return <p className="ccc-harness-error">{message}</p>;
}

// ---------------------------------------------------------------------------
// The fixture-backed API: answers from memory, pages exactly as the service
// does (10 findings per page, then the sources page), never touches a socket.
// ---------------------------------------------------------------------------

function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

function reportFor(noteId: string): ReportFixture | undefined {
  return Object.values(FIXTURES.reports).find((report) => report.header.noteId === noteId);
}

function fixtureApi(fixture: CaseFixture): ResearchApi {
  if (fixture.behaviour === "loading") {
    return { run: never, status: never, list: never, report: never };
  }
  if (fixture.behaviour === "error") {
    const code = fixture.errorCode ?? "timeout";
    const fail = <T,>(): Promise<T> => Promise.reject(new ResearchApiError(code));
    return { run: fail, status: fail, list: fail, report: fail };
  }
  const status = FIXTURES.statuses[fixture.status ?? ""];
  const rows = FIXTURES.lists[fixture.list ?? ""] ?? [];
  return {
    run: () => Promise.reject(new ResearchApiError("service-disconnected")),
    status: () =>
      status === undefined
        ? Promise.reject(new ResearchApiError("unrecognised-response"))
        : Promise.resolve(status),
    list: () => Promise.resolve({ rows: [...rows], nextCursor: null }),
    report: (noteId, page, cursor): Promise<ResearchReportResponse> => {
      const report = reportFor(noteId);
      if (report === undefined) return Promise.reject(new ResearchApiError("not-found"));
      if (page === "sources") {
        return Promise.resolve({
          page: "sources",
          sources: [...report.sources],
          nextCursor: null,
          truncated: false,
        });
      }
      // Cursors are `p<page number>`, URL-safe and opaque to the view.
      const pageNumber = cursor === undefined ? 1 : Number(cursor.slice(1));
      const start = (pageNumber - 1) * ITEMS_PAGE_SIZE;
      const items = report.items.slice(start, start + ITEMS_PAGE_SIZE);
      const more = start + ITEMS_PAGE_SIZE < report.items.length;
      return Promise.resolve({
        page: "items",
        header: report.header,
        items: [...items],
        nextCursor: more ? `p${pageNumber + 1}` : null,
        truncated: false,
      });
    },
  };
}

let configured = false;

function configureOnce(fixture: CaseFixture): void {
  if (configured) return;
  configured = true;
  configureResearch({
    api: fixtureApi(fixture),
    notify: () => undefined,
    openNote: () => true,
    copyText: () => true,
    requestRunNow: () => undefined,
  });
}

// ---------------------------------------------------------------------------
// Readiness: the document is marked ready only when the state the case names
// is on screen, after the one row press a report cell needs.
// ---------------------------------------------------------------------------

function count(selector: string): number {
  return document.querySelectorAll(selector).length;
}

function stateIsOnScreen(fixture: CaseFixture, width: Width): boolean {
  if (fixture.behaviour === "loading") {
    return document.querySelector(".ccc-report-list-region[aria-busy='true']") !== null;
  }
  if (fixture.behaviour === "error") {
    return document.querySelector(".ccc-report-list-error") !== null;
  }
  const layout = document.querySelector(".ccc-research-layout")?.getAttribute("data-layout");
  if (layout !== (width === "narrow" ? "stacked" : "side")) return false;
  // The status section has answered and the list has been drawn (rows or the empty state).
  if (count(".ccc-research-run-status .ccc-skeleton-line") > 0) return false;
  if (document.querySelector(".ccc-report-list-region[aria-busy='true']") !== null) return false;
  if (count(".ccc-report-row, .ccc-report-list-empty") === 0) return false;
  if (fixture.open === undefined) return true;
  const report = reportFor(fixture.open);
  if (report === undefined) return false;
  return (
    count("ol.ccc-report-items > li") === report.items.length &&
    count(".ccc-report-source") === report.sources.length
  );
}

let readyStarted = false;

function startReady(fixture: CaseFixture, width: Width): void {
  if (readyStarted) return;
  readyStarted = true;
  let pressed = false;
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    if (fixture.open !== undefined && !pressed) {
      const row = document.querySelector<HTMLElement>("button.ccc-report-row-button");
      if (row !== null) {
        pressed = true;
        row.click();
      }
    } else if (stateIsOnScreen(fixture, width) || tries > 1500) {
      clearInterval(timer);
      // One beat for the last paint (focus moves, container-query layout) to settle.
      setTimeout(() => document.documentElement.setAttribute("data-harness-ready", "true"), 120);
    }
  }, 10);
}

// ---------------------------------------------------------------------------
// The entry the harness delegates to.
// ---------------------------------------------------------------------------

/** The `view` value this module owns; `main.tsx` delegates exactly this. */
export function isResearchView(view: string): boolean {
  return view === "research";
}

/**
 * Renders one Research cell from the page's query parameters: `case`, `width`
 * (narrow or full). `motion` is validated and applied by the harness entry
 * before it delegates here.
 */
export function ResearchCell({ params }: { readonly params: URLSearchParams }): VNode {
  const caseId = params.get("case") ?? "";
  const width = params.get("width") ?? "full";
  if (!isWidth(width)) {
    return <HarnessError message={`Unknown width "${width}" - expected narrow or full.`} />;
  }
  const fixture = FIXTURES.cases[caseId];
  if (fixture === undefined) {
    return <HarnessError message={`Unknown research case "${caseId}".`} />;
  }
  const connection = fixture.connection === "disconnected" ? DISCONNECTED : LIVE;
  connectionState.value = connection;
  configureOnce(fixture);
  startReady(fixture, width);
  // `nav=1` adds the real tab strip above the destination (the contrast guard reads it). No
  // baseline sets it, so the committed images are unchanged.
  const withNav = params.get("nav") === "1";
  return (
    <div className="ccc-command-center" data-motion={motionMode.value}>
      <div data-harness-width={width} style={{ width: PANE_WIDTH[width] }}>
        {withNav ? <DestinationTabs activeId="research" pendingCount={0} /> : null}
        <div className="ccc-content">
          <ResearchDestination connection={connection} now={NOW} zone={FIXTURES.zone} />
        </div>
      </div>
    </div>
  );
}
