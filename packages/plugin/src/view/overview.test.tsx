import { createSocketApiClient } from "@ccc/service-api-client";
import { type ReadonlySignal, type Signal, signal } from "@preact/signals";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { options } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionState, lastEvent } from "../connection-state.js";
import { motionMode } from "../motion.js";
import type { WidgetState } from "../widgets/contract.js";
import { ENABLED_FLAGS } from "../widgets/feature-flags.js";
import { WidgetFrame } from "../widgets/frame.js";
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

/**
 * The one seam a client is reached through is the `@ccc/service-api-client`
 * package, so every factory it exports is replaced by a recorder that also
 * throws: if anything the Overview renders ever constructs a client — directly
 * or through a module it imports — `clientSpy` sees it and the "never reaches
 * for a client" test below fails (wave-6 review: the old spy was never wired).
 */
const clientSpy = vi.hoisted(() => vi.fn());
vi.mock("@ccc/service-api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ccc/service-api-client")>();
  const recorder =
    (name: string) =>
    (..._args: unknown[]): never => {
      clientSpy(name);
      throw new Error(`${name} reached from the Overview render path`);
    };
  return {
    ...actual,
    createEventClient: recorder("createEventClient"),
    createAuthenticatedClient: recorder("createAuthenticatedClient"),
    createSocketApiClient: recorder("createSocketApiClient"),
    requestVaultSetupPlan: recorder("requestVaultSetupPlan"),
    requestVaultSetup: recorder("requestVaultSetup"),
  };
});

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
    // SC-6 (plan 04-08): the Projects destination now renders the real S3
    // view (Shell's no-op `projectsActions`/`pickFolder` defaults let it
    // render with no host, D-24) instead of the placeholder description this
    // test used to assert.
    expect(screen.getByRole("heading", { level: 3, name: "Registered projects" })).toBeTruthy();

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
  "project-shortcuts": {
    projects: [],
    launchers: {
      antigravity: "set-up",
      "claude-code": { status: "set-up", terminalLabel: "Terminal" },
      "claude-desktop": "set-up",
    },
  },
  "claude-usage": { bars: [], tokens: { input: 0, output: 0, cache: 0 }, estimate: null },
  "tech-intel": { stories: [], marketSummary: null },
  "github-discoveries": { repos: [] },
  "quick-actions": {
    launchers: {
      antigravity: "set-up",
      "claude-code": { status: "set-up", terminalLabel: "Terminal" },
      "claude-desktop": "set-up",
    },
  },
};

function cachedReady(id: WidgetId): WidgetState<unknown> {
  return cachedReadyWith(MINIMAL_DATA[id]);
}

function cachedReadyWith(data: unknown): WidgetState<unknown> {
  return {
    kind: "ready",
    data,
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
      pending.value = cachedReadyWith(data);
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

describe("per-card signal isolation: one widget's update re-renders only its card", () => {
  it("re-renders the updated card and no sibling", () => {
    const states: Record<WidgetId, Signal<WidgetState<unknown>>> = {} as Record<
      WidgetId,
      Signal<WidgetState<unknown>>
    >;
    for (const id of WIDGET_IDS) states[id] = signal(cachedReady(id));

    // Every WidgetFrame diff, by widget id — Preact's own post-diff hook,
    // chained so @preact/signals' hook keeps running.
    const renders: string[] = [];
    const original = Object.getOwnPropertyDescriptor(options, "diffed");
    const chained = options.diffed?.bind(options);
    options.diffed = (vnode) => {
      if (vnode.type === WidgetFrame) {
        renders.push((vnode.props as unknown as { definition: { id: string } }).definition.id);
      }
      chained?.(vnode);
    };
    try {
      const { container } = render(
        <Overview
          layout={composeLayout(DEFAULT_LAYOUT, undefined, WIDGETS, ENABLED_FLAGS)}
          stateFor={(id) => states[id]}
          connection={{ kind: "live" }}
          now={Date.parse("2026-09-25T12:00:00Z")}
        />,
      );
      expect(renders).toHaveLength(8);
      renders.length = 0;

      void act(() => {
        states["tech-intel"].value = { kind: "error", message: "boom" };
      });

      expect(renders).toEqual(["tech-intel"]);
      const updated = Array.from(container.querySelectorAll(".ccc-overview-grid > section")).find(
        (card) => cardTitle(card) === "Technology and market intelligence",
      );
      expect(updated?.getAttribute("data-presentation")).toBe("error");
    } finally {
      if (original === undefined) delete options.diffed;
      else Object.defineProperty(options, "diffed", original);
    }
  });
});

describe("the Overview path never reaches for a client (PERF-01 extended)", () => {
  beforeEach(() => clientSpy.mockClear());

  it("the spy is wired: constructing a client through the package is recorded", () => {
    // The control that makes the next test able to fail: every client
    // factory in this file IS the spy (see the `vi.mock` above).
    expect(() => createSocketApiClient({} as never)).toThrow(/Overview render path/);
    expect(clientSpy).toHaveBeenCalledWith("createSocketApiClient");
  });

  it("renders every card, navigates and refreshes without constructing a client", () => {
    const { container, rerender } = render(<Shell />);
    expect(overviewCards(container)).toHaveLength(8);
    fireEvent.click(screen.getByRole("tab", { name: "Projects" }));
    fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
    rerender(<Shell />);
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

// ---------------------------------------------------------------------------
// Wave-5 review carry-forwards: the `+{n} more` channel (MAJOR 1) and the
// layout, not the panel, deciding a list body's row budget (MAJOR 2).
// ---------------------------------------------------------------------------

function sessions(n: number): unknown {
  return {
    rows: Array.from({ length: n }, (_, i) => ({
      id: `s-${i}`,
      project: "Example project",
      name: `Session ${i}`,
      model: null,
      elapsed: "5 min",
      lastActivity: "just now",
      status: "running",
    })),
  };
}

function stories(n: number): unknown {
  return {
    stories: Array.from({ length: n }, (_, i) => ({
      id: `story-${i}`,
      headline: `Headline ${i}`,
      category: "Tools",
      summary: "A synthetic summary.",
      sourceCount: 2,
    })),
    marketSummary: null,
  };
}

function projects(n: number): unknown {
  return {
    projects: Array.from({ length: n }, (_, i) => ({
      id: `p-${i}`,
      name: `Project ${i}`,
      pinned: false,
      git: {
        kind: "repo",
        branch: "main",
        detached: false,
        dirty: false,
        commits: [],
        remote: null,
      },
      gitReadFailed: false,
      github: { kind: "none" },
      observedAt: null,
      openItems: null,
      sessionCount: null,
      nextTask: null,
    })),
    launchers: {
      antigravity: "set-up",
      "claude-code": { status: "set-up", terminalLabel: "Terminal" },
      "claude-desktop": "set-up",
    },
  };
}

describe("+{n} more focuses the destination that owns the full list (review MAJOR 1)", () => {
  it("selects and focuses Agent runs when an over-budget sessions card's more control is used", () => {
    const states = cachedStates();
    states["active-sessions"] = signal(cachedReadyWith(sessions(12)));
    const { container } = render(<Shell stateFor={(id) => states[id]} />);

    const card = cardNamed(container, "Active Claude sessions");
    const more = card.querySelector<HTMLButtonElement>("button.ccc-list-more");
    expect(more?.textContent).toBe("+2 more");
    fireEvent.click(more as HTMLButtonElement);

    const agentRuns = screen.getByRole("tab", { name: "Agent runs" });
    expect(agentRuns.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(agentRuns);
  });
});

describe("the layout decides each list body's row budget (review MAJOR 2)", () => {
  const NOW = Date.parse("2026-09-25T12:00:00Z");

  function renderPlaced(entries: { widgetId: WidgetId; size: "small" | "medium" | "tall" }[]) {
    const states = cachedStates();
    states["active-sessions"] = signal(cachedReadyWith(sessions(12)));
    states["tech-intel"] = signal(cachedReadyWith(stories(12)));
    states["project-shortcuts"] = signal(cachedReadyWith(projects(12)));
    return render(
      <Overview
        layout={{ entries, skipped: [] }}
        stateFor={(id) => states[id]}
        connection={{ kind: "live" }}
        now={NOW}
      />,
    );
  }

  function rowsAndMore(container: Element, title: string): [number, string | undefined] {
    // A bare Overview has no tabpanel around it, so look the card up by grid.
    const card = Array.from(
      container.querySelectorAll(".ccc-overview-grid > section.ccc-card"),
    ).find((c) => cardTitle(c) === title);
    if (!card) throw new Error(`no card titled ${title}`);
    return [
      card.querySelectorAll(".ccc-list-row").length,
      card.querySelector(".ccc-list-more")?.textContent ?? undefined,
    ];
  }

  it("caps a tall-preferring list at the medium budget when the layout places it medium", () => {
    const { container } = renderPlaced([
      { widgetId: "active-sessions", size: "medium" },
      { widgetId: "tech-intel", size: "medium" },
    ]);

    expect(rowsAndMore(container, "Active Claude sessions")).toEqual([6, "+6 more"]);
    expect(rowsAndMore(container, "Technology and market intelligence")).toEqual([6, "+6 more"]);
  });

  it("grants a medium-preferring list the tall budget when the layout places it tall", () => {
    const { container } = renderPlaced([{ widgetId: "project-shortcuts", size: "tall" }]);
    expect(rowsAndMore(container, "Project shortcuts")).toEqual([10, "+2 more"]);
  });
});
