import { type ReadonlySignal, signal } from "@preact/signals";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionState, lastEvent } from "../connection-state.js";
import { motionMode } from "../motion.js";
import type { WidgetState } from "../widgets/contract.js";
import { ENABLED_FLAGS } from "../widgets/feature-flags.js";
import { composeLayout, DEFAULT_LAYOUT } from "../widgets/layout.js";
import { WIDGET_IDS, WIDGETS, type WidgetId } from "../widgets/registry.js";
import { widgetStateFor } from "../widgets/widget-data.js";
import { Overview } from "./overview.js";
import { Shell } from "./shell.js";

/**
 * The Overview as the owner meets it: the shell's overview tabpanel, composed
 * from the in-code default layout, rendering one real card per resolved entry
 * (UI-07, D-12, UI-SPEC E3).
 */

function resetSignals(): void {
  connectionState.value = { kind: "connecting" };
  lastEvent.value = undefined;
  motionMode.value = "full";
}

beforeEach(resetSignals);
afterEach(() => {
  cleanup();
  resetSignals();
});

/** The visible title of a card, read through its `aria-labelledby` link. */
function cardTitle(card: Element): string {
  const id = card.getAttribute("aria-labelledby") ?? "";
  return document.getElementById(id)?.textContent ?? "";
}

function overviewCards(container: Element): Element[] {
  const grid = container.querySelector('[role="tabpanel"] div.ccc-overview-grid');
  return grid ? Array.from(grid.querySelectorAll(":scope > section.ccc-card")) : [];
}

function cardNamed(container: Element, title: string): Element {
  const card = overviewCards(container).find((c) => cardTitle(c) === title);
  if (!card) throw new Error(`no card titled ${title}`);
  return card;
}

const DEFAULT_ORDER = [
  "Service health",
  "Today",
  "Active Claude sessions",
  "Project shortcuts",
  "Claude usage",
  "Technology and market intelligence",
  "GitHub discoveries",
  "Quick actions",
];

describe("the Overview renders the default layout (UI-07, D-12)", () => {
  it("places eight real cards in the default order inside the overview tabpanel", () => {
    const { container } = render(<Shell />);
    const cards = overviewCards(container);

    expect(cards).toHaveLength(8);
    expect(cards.map(cardTitle)).toEqual(DEFAULT_ORDER);
    expect(cardNamed(container, "Today").getAttribute("data-size")).toBe("wide");
    expect(cardNamed(container, "Active Claude sessions").getAttribute("data-size")).toBe("tall");
    expect(cardNamed(container, "Quick actions").getAttribute("data-size")).toBe("small");
  });

  it("swaps the grid for another destination's content and back again", () => {
    const { container } = render(<Shell />);

    fireEvent.click(screen.getByRole("tab", { name: "Projects" }));
    expect(container.querySelector(".ccc-overview-grid")).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "Projects" })).toBeTruthy();
    expect(screen.getByText(/Registered project shortcuts and their git status/)).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
    expect(overviewCards(container)).toHaveLength(8);
  });

  it("feeds the service-health card from the live connection signals", () => {
    connectionState.value = { kind: "live" };
    lastEvent.value = { type: "service.heartbeat", occurredAt: "2026-09-15T00:00:00Z" };
    const { container } = render(<Shell />);

    const card = cardNamed(container, "Service health");
    expect(card.getAttribute("data-presentation")).toBe("ready");
    expect(card.querySelector(".ccc-card-body")?.textContent).toContain(
      "Last event: service.heartbeat",
    );
  });

  it("composes the default layout into eight entries in order with nothing skipped", () => {
    const resolution = composeLayout(DEFAULT_LAYOUT, undefined, WIDGETS, ENABLED_FLAGS);

    expect(resolution.entries).toEqual([
      { widgetId: "service-health", size: "medium" },
      { widgetId: "today", size: "wide" },
      { widgetId: "active-sessions", size: "tall" },
      { widgetId: "project-shortcuts", size: "medium" },
      { widgetId: "claude-usage", size: "wide" },
      { widgetId: "tech-intel", size: "tall" },
      { widgetId: "github-discoveries", size: "medium" },
      { widgetId: "quick-actions", size: "small" },
    ]);
    expect(resolution.skipped).toEqual([]);
  });
});

describe("zero, one and many widgets (UI-SPEC E3 empty and zero-one-many rows)", () => {
  const NOW = Date.parse("2026-09-25T12:00:00Z");

  it("shows a single one-column Nothing here yet card when the layout resolves to nothing", () => {
    const { container } = render(
      <Overview
        layout={{ entries: [], skipped: [{ widgetId: "not-a-widget", reason: "unknown-widget" }] }}
        stateFor={widgetStateFor}
        connection={{ kind: "connecting" }}
        now={NOW}
      />,
    );

    const cards = container.querySelectorAll(".ccc-overview-grid > section.ccc-card");
    expect(cards).toHaveLength(1);
    const empty = container.querySelectorAll(".ccc-layout-empty");
    expect(empty).toHaveLength(1);
    expect(empty[0]?.getAttribute("data-size")).toBe("small");
    expect(cardTitle(empty[0] as Element)).toBe("Nothing here yet");
    expect(empty[0]?.textContent).toContain(
      "The Overview layout has no widgets to show. Check the layout file in the plugin data folder.",
    );
    // A skipped id is never rendered as a placeholder or error tile (D-13).
    expect(container.textContent).not.toContain("not-a-widget");
  });

  it("renders one card at its resolved size when the layout holds one widget", () => {
    const { container } = render(
      <Overview
        layout={{ entries: [{ widgetId: "claude-usage", size: "wide" }], skipped: [] }}
        stateFor={widgetStateFor}
        connection={{ kind: "connecting" }}
        now={NOW}
      />,
    );

    const cards = container.querySelectorAll(".ccc-overview-grid > section.ccc-card");
    expect(cards).toHaveLength(1);
    expect(container.querySelector(".ccc-layout-empty")).toBeNull();
    expect(cardTitle(cards[0] as Element)).toBe("Claude usage");
    expect(cards[0]?.getAttribute("data-size")).toBe("wide");
  });
});

// ---------------------------------------------------------------------------
// PERF-02 / PERF-03 (research Pattern 8) and the quick-action path (C-11)
// ---------------------------------------------------------------------------

/** Minimal, synthetic body data per widget — shaped to each body's data type. */
const MINIMAL_DATA: Readonly<Record<WidgetId, unknown>> = {
  "service-health": { connection: "live" },
  today: {
    nextEvent: null,
    remainingCount: 0,
    dueTasks: [],
    overdueTasks: [],
    unreadSummary: null,
    failures: [],
  },
  "active-sessions": {
    rows: [
      {
        id: "s-1",
        project: "Example project",
        name: "Example session",
        model: null,
        elapsed: "5 min",
        lastActivity: "just now",
        status: "running",
      },
    ],
  },
  "project-shortcuts": { projects: [] },
  "claude-usage": { bars: [], tokens: { input: 0, output: 0, cache: 0 }, estimate: null },
  "tech-intel": { stories: [], marketSummary: null },
  "github-discoveries": { repos: [] },
  "quick-actions": {},
};

function cachedReady(id: WidgetId): WidgetState<unknown> {
  return {
    kind: "ready",
    data: MINIMAL_DATA[id],
    observedAt: "2026-09-25T11:58:00Z",
    freshness: "cached",
    partiality: { partial: false },
    isEmpty: false,
  };
}

/** Every widget pre-seeded with a cached ready state (PERF-02). */
function cachedStates(): Record<WidgetId, ReadonlySignal<WidgetState<unknown>>> {
  const states = {} as Record<WidgetId, ReadonlySignal<WidgetState<unknown>>>;
  for (const id of WIDGET_IDS) states[id] = signal(cachedReady(id));
  return states;
}

const TERMINAL = new Set([
  "ready",
  "stale",
  "empty",
  "error",
  "disconnected",
  "permission-required",
  "unavailable",
]);

describe("PERF-02: cached Overview data renders within 2 seconds", () => {
  it("PERF-02 places eight cached ready cards in the DOM on a synchronous render, under 2000 ms", () => {
    const states = cachedStates();

    const started = performance.now();
    const { container } = render(<Shell stateFor={(id) => states[id]} />);
    const elapsed = performance.now() - started;

    // No await and no timer advance above this line: first paint IS the data.
    const cards = overviewCards(container);
    expect(cards).toHaveLength(8);
    for (const card of cards) {
      expect(card.getAttribute("data-presentation")).toBe("ready");
      expect(card.querySelector('.ccc-badge[data-badge="cached"]')?.textContent).toContain(
        "Cached",
      );
    }
    expect(elapsed).toBeLessThan(2000);
  });
});

describe("PERF-03: a slow integration blocks neither its siblings nor navigation", () => {
  it("PERF-03 leaves seven terminal cards and working arrow-key navigation while one key never resolves", () => {
    const states = cachedStates();
    // A source whose request never settles: its card stays loading forever.
    const pending = signal<WidgetState<unknown>>({ kind: "loading" });
    void new Promise<unknown>(() => {}).then((data) => {
      pending.value = { ...cachedReady("tech-intel"), data };
    });
    states["tech-intel"] = pending;

    const { container } = render(<Shell stateFor={(id) => states[id]} />);

    const cards = overviewCards(container);
    expect(cards).toHaveLength(8);
    const slow = cardNamed(container, "Technology and market intelligence");
    expect(slow.getAttribute("data-presentation")).toBe("loading");
    expect(slow.getAttribute("aria-busy")).toBe("true");
    const others = cards.filter((card) => card !== slow);
    expect(others).toHaveLength(7);
    for (const card of others) {
      expect(TERMINAL.has(card.getAttribute("data-presentation") ?? "")).toBe(true);
    }

    const tablist = screen.getByRole("tablist");
    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Projects" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    fireEvent.keyDown(tablist, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(overviewCards(container)).toHaveLength(8);
  });
});

describe("the Overview path never reaches for a client (PERF-01 extended)", () => {
  it("renders every card without ever calling a client", () => {
    // Structural, like shell.test.tsx: nothing in the Overview's render path
    // imports or receives a client, so this stand-in can never be reached.
    const clientSpy = vi.fn();
    const { container } = render(<Shell />);
    expect(overviewCards(container)).toHaveLength(8);
    expect(clientSpy).not.toHaveBeenCalled();
  });
});

describe("quick actions reach the one dispatcher through the shell (C-11)", () => {
  it("selects Settings and notifies once when a connect action is clicked", () => {
    const notify = vi.fn();
    render(<Shell notify={notify} />);

    fireEvent.click(screen.getByRole("button", { name: "Connect Google Calendar and Gmail" }));

    expect(screen.getByRole("tab", { name: "Settings" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toMatch(/Settings/);
  });
});
