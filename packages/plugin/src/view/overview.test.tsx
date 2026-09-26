import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectionState, lastEvent } from "../connection-state.js";
import { motionMode } from "../motion.js";
import { ENABLED_FLAGS } from "../widgets/feature-flags.js";
import { composeLayout, DEFAULT_LAYOUT } from "../widgets/layout.js";
import { WIDGETS } from "../widgets/registry.js";
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
