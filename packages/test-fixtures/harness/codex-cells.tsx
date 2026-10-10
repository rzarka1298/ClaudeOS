/**
 * The Codex cells of the visual harness (plan 05.1-27; UI-SPEC "Visual
 * regression", ADR-0023).
 *
 *   index.html?view=codex&case=ready-mixed&pane=narrow&motion=full
 *
 * Every cell mounts the REAL registered Codex widget through the REAL
 * `WidgetFrame`, built by the plugin's own `codexStateFor`, against the
 * production stylesheet, so a baseline regresses when the shipped markup, copy
 * or CSS does and not when a copy of it drifts. The frame itself decides what
 * each state draws; this module only hands it the state and the connection.
 *
 * PRIVACY (PRIV-04 layer 1, T-03-03, T-05.1-39). This module may import exactly
 * three modules: `preact`, `@ccc/plugin` and the synthetic
 * `codex-visual-fixtures.json` (plus the tolerated signals package).
 * `src/harness-purity.test.ts` enforces that set by source scan. Every value on
 * screen therefore comes from that fixture file or from a literal in this file.
 *
 * DETERMINISM. `now` is the fixture's own frozen `now` for every relative and
 * absolute time. Pane widths are fixed boxes (the narrow pane is 24rem, the
 * full pane 64rem); the boxes are test infrastructure, not plugin code, so the
 * plugin's own "no inline style" rule does not apply to them.
 */

import type { CodexCardData, CodexParts, ConnectionState, WidgetState } from "@ccc/plugin";
import { codexStateFor, connectionState, motionMode, WIDGETS, WidgetFrame } from "@ccc/plugin";
import type { VNode } from "preact";
import fixtureFile from "../src/codex-visual-fixtures.json";

// ---------------------------------------------------------------------------
// The fixture file's shape. Declared here rather than inferred so the cells
// read named fields, not a deep JSON literal union.
// ---------------------------------------------------------------------------

interface CaseFixture {
  readonly parts: CodexParts;
  /** `disconnected` swaps the connection; absent means live. */
  readonly connection?: "disconnected";
  /** `loading` and `error` hand the frame the widget state directly. */
  readonly override?: "loading" | "error";
}

interface FixtureFile {
  readonly now: string;
  readonly cases: Readonly<Record<string, CaseFixture>>;
}

const FIXTURES = fixtureFile as unknown as FixtureFile;
const NOW = Date.parse(FIXTURES.now);

const LIVE: ConnectionState = { kind: "live" };
const DISCONNECTED: ConnectionState = { kind: "disconnected", reason: "connect ECONNREFUSED" };

/** The two pane widths every cell renders at (UI-SPEC: narrow <= 24rem, full >= 64rem). */
const PANE_WIDTH = { narrow: "24rem", full: "64rem" } as const;
type Pane = keyof typeof PANE_WIDTH;

function isPane(value: string): value is Pane {
  return Object.hasOwn(PANE_WIDTH, value);
}

function HarnessError({ message }: { readonly message: string }): VNode {
  // Harness-only: a typo in the spec must never produce a blank baseline.
  return <p className="ccc-harness-error">{message}</p>;
}

/**
 * The cell shell: the production `.ccc-command-center` root, then the same
 * `.ccc-overview-grid .ccc-harness-cell` wrapper the generic card cells use,
 * bounded by a harness-only fixed-width box. The grid is single-column so the
 * card is laid out in the whole pane (the box IS the pane); the production
 * grid, card and container-query rules still decide everything inside it.
 * `data-pane` lets a spec resize the box (the 200 percent zoom cell keeps the
 * pane at its pixel width while the font grows).
 */
function PaneCell({ pane, children }: { readonly pane: Pane; readonly children: VNode }): VNode {
  return (
    <div className="ccc-command-center" data-motion={motionMode.value}>
      <div
        className="ccc-overview-grid ccc-harness-cell"
        data-pane={pane}
        style={{ width: PANE_WIDTH[pane], maxWidth: "none", gridTemplateColumns: "minmax(0, 1fr)" }}
      >
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The Codex card cells.
// ---------------------------------------------------------------------------

function cardState(fixture: CaseFixture): {
  readonly state: WidgetState<CodexCardData>;
  readonly connection: ConnectionState;
} {
  const connection = fixture.connection === "disconnected" ? DISCONNECTED : LIVE;
  if (fixture.override === "loading") return { state: { kind: "loading" }, connection };
  if (fixture.override === "error") {
    return { state: { kind: "error", message: "The source failed." }, connection };
  }
  return { state: codexStateFor(connection, fixture.parts, NOW), connection };
}

function CodexCardCell({ caseId, pane }: { readonly caseId: string; readonly pane: Pane }): VNode {
  const fixture = FIXTURES.cases[caseId];
  if (fixture === undefined) return <HarnessError message={`Unknown codex case "${caseId}".`} />;
  const definition = WIDGETS.codex;
  const cell = cardState(fixture);
  connectionState.value = cell.connection;
  return (
    <PaneCell pane={pane}>
      {/* A no-op dispatcher and navigator: the frame hands the dispatcher to the
          body only for ready and stale, so those cells draw the row actions and
          enable pills exactly as the real card does (RR-05), and the setup
          button of a permission-required card is live. Nothing runs on click. */}
      <WidgetFrame
        definition={definition}
        state={cell.state}
        connection={connectionState.value}
        size={definition.preferredSize}
        now={NOW}
        onQuickAction={() => {}}
        onNavigate={() => {}}
      />
    </PaneCell>
  );
}

// ---------------------------------------------------------------------------
// The entry the harness delegates to.
// ---------------------------------------------------------------------------

/** The `view` values this module owns; `main.tsx` delegates exactly these. */
export function isCodexView(view: string): boolean {
  return view === "codex";
}

/**
 * Renders one Codex cell from the page's query parameters: `view`, `case`,
 * `pane` (narrow or full). `motion` is validated and applied by the harness
 * entry before it delegates here.
 */
export function CodexCell({ params }: { readonly params: URLSearchParams }): VNode {
  const view = params.get("view") ?? "";
  const caseId = params.get("case") ?? "";
  const pane = params.get("pane") ?? "full";
  if (!isPane(pane)) {
    return <HarnessError message={`Unknown pane "${pane}" — expected narrow or full.`} />;
  }
  if (view === "codex") return <CodexCardCell caseId={caseId} pane={pane} />;
  return <HarnessError message={`Unknown codex view "${view}".`} />;
}
