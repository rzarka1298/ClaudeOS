import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type ReadonlySignal, signal } from "@preact/signals";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionState, lastEvent } from "../connection-state.js";
import { clearDiagnostics, diagnostics } from "../diagnostics.js";
import { nowTick } from "../widgets/clock.js";
import type { WidgetState } from "../widgets/contract.js";
import { setLayoutOverride } from "../widgets/layout.js";
import { WIDGET_IDS, type WidgetId } from "../widgets/registry.js";
import { Overview } from "./overview.js";
import { Shell } from "./shell.js";

/** Audit of plan 03-07: gaps the plan's own suites leave open. */

const OBSERVED = "2026-09-25T11:58:00Z";

function ready(data: unknown): WidgetState<unknown> {
  return {
    kind: "ready",
    data,
    observedAt: OBSERVED,
    freshness: "cached",
    partiality: { partial: false },
    isEmpty: false,
  };
}

function loadingStates(): Record<WidgetId, ReadonlySignal<WidgetState<unknown>>> {
  const states = {} as Record<WidgetId, ReadonlySignal<WidgetState<unknown>>>;
  for (const id of WIDGET_IDS) states[id] = signal<WidgetState<unknown>>({ kind: "loading" });
  return states;
}

function cardTitle(card: Element): string {
  const id = card.getAttribute("aria-labelledby") ?? "";
  return document.getElementById(id)?.textContent ?? "";
}

function cards(container: Element): Element[] {
  return Array.from(container.querySelectorAll(".ccc-overview-grid > section.ccc-card"));
}

function cardNamed(container: Element, title: string): Element {
  const card = cards(container).find((c) => cardTitle(c) === title);
  if (!card) throw new Error(`no card titled ${title}`);
  return card;
}

beforeEach(() => {
  connectionState.value = { kind: "live" };
  lastEvent.value = undefined;
  clearDiagnostics();
});
afterEach(() => {
  cleanup();
  setLayoutOverride(undefined);
  clearDiagnostics();
  connectionState.value = { kind: "connecting" };
});

describe("an override with unknown, duplicate and module-like ids reaches the real Shell (D-13, T-03-02)", () => {
  it("renders only the resolvable cards, no placeholder, and records each skip", () => {
    setLayoutOverride({
      schemaVersion: 1,
      entries: [
        { widgetId: "./evil.js" },
        { widgetId: "today" },
        { widgetId: "constructor" },
        { widgetId: "today", size: "small" },
        { widgetId: "quick-actions" },
      ],
    });
    const { container } = render(<Shell stateFor={(id) => loadingStates()[id]} />);

    expect(cards(container).map(cardTitle)).toEqual(["Today", "Quick actions"]);
    expect(container.textContent).not.toContain("evil");
    expect(container.textContent).not.toContain("constructor");
    expect(container.querySelector(".ccc-layout-empty")).toBeNull();
    expect(diagnostics.value.map((d) => d.code)).toEqual([
      "unknown-widget",
      "unknown-widget",
      "duplicate",
    ]);
  });

  it("an override of only unknown ids shows the single Nothing here yet card", () => {
    setLayoutOverride({ schemaVersion: 1, entries: [{ widgetId: "nope" }] });
    const { container } = render(<Shell stateFor={(id) => loadingStates()[id]} />);
    expect(cards(container)).toHaveLength(1);
    expect(container.querySelector(".ccc-layout-empty")?.textContent).toContain("Nothing here yet");
  });
});

describe("PERF-03: a slow source settling later changes only its own card", () => {
  it("siblings stay terminal and unchanged while the slow card goes loading -> ready", () => {
    const states = loadingStates();
    for (const id of WIDGET_IDS) {
      (states[id] as ReturnType<typeof signal<WidgetState<unknown>>>).value = {
        kind: "unavailable",
      } as unknown as WidgetState<unknown>;
    }
    const slow = signal<WidgetState<unknown>>({ kind: "loading" });
    states["github-discoveries"] = slow;
    const { container } = render(<Shell stateFor={(id) => states[id]} />);

    const before = cards(container)
      .filter((c) => cardTitle(c) !== "GitHub discoveries")
      .map((c) => c.getAttribute("data-presentation"));
    expect(cardNamed(container, "GitHub discoveries").getAttribute("data-presentation")).toBe(
      "loading",
    );

    act(() => {
      slow.value = ready({ repos: [] });
    });

    expect(cardNamed(container, "GitHub discoveries").getAttribute("data-presentation")).not.toBe(
      "loading",
    );
    const after = cards(container)
      .filter((c) => cardTitle(c) !== "GitHub discoveries")
      .map((c) => c.getAttribute("data-presentation"));
    expect(after).toEqual(before);
    expect(after).not.toContain("loading");
  });
});

describe("quick actions move focus to the owning destination (C-11 focus)", () => {
  it("focuses the Settings tab, not the unmounted button, after a connect action", () => {
    render(<Shell notify={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Connect Google Calendar and Gmail" });
    button.focus();
    fireEvent.click(button);

    const settings = screen.getByRole("tab", { name: "Settings" });
    expect(document.activeElement).toBe(settings);
    expect(button.isConnected).toBe(false);
  });
});

describe("the relative-time footer follows the one clock signal (T-03-07)", () => {
  it("re-renders a footer when nowTick advances, with no other input", () => {
    const states = loadingStates();
    states["github-discoveries"] = signal(ready({ repos: [] }));
    act(() => {
      nowTick.value = Date.parse(OBSERVED) + 60_000;
    });
    const { container } = render(<Shell stateFor={(id) => states[id]} />);
    const time = () =>
      cardNamed(container, "GitHub discoveries").querySelector(".ccc-footer-time")?.textContent;
    const first = time();

    act(() => {
      nowTick.value = Date.parse(OBSERVED) + 3 * 60 * 60_000;
    });

    expect(first).toBeTruthy();
    expect(time()).not.toBe(first);
  });
});

describe("the grid CSS is the one auto-placement contract (D-12, UI-SPEC E3)", () => {
  const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

  it("declares auto-fill 16rem columns, dense flow, wide/tall spans and a 34rem wide collapse", () => {
    const grid = /\.ccc-overview-grid\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(grid).toMatch(
      /grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(min\(100%,\s*16rem\),\s*1fr\)\)/,
    );
    expect(grid).toMatch(/grid-auto-flow:\s*dense/);
    expect(css).toMatch(/\.ccc-card\[data-size="wide"\]\s*\{\s*grid-column:\s*span 2;/);
    expect(css).toMatch(/\.ccc-card\[data-size="tall"\]\s*\{\s*grid-row:\s*span 2;/);
    const collapse = /@container\s*\(max-width:\s*34rem\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(collapse).toMatch(/\[data-size="wide"\]\s*\{\s*grid-column:\s*span 1;/);
    expect(css).not.toMatch(/grid-(row|column)-start|grid-area:/);
    expect(css).not.toMatch(/@media[^{]*width/);
  });
});

describe("honest data: an unavailable count never reads as zero", () => {
  // AUDIT-BUG: ProjectRow.openItems is `number`; an unknown count renders as "null open items" / cannot be expressed, so the wave-6 MAJOR ("0 open items") still reproduces.
  it.skip("a project whose open-item count is unavailable does not render a number", () => {
    const states = loadingStates();
    const { container } = render(
      <Overview
        layout={{ entries: [{ widgetId: "project-shortcuts", size: "medium" }], skipped: [] }}
        stateFor={(id) =>
          id === "project-shortcuts"
            ? signal(
                ready({
                  projects: [
                    {
                      id: "p",
                      name: "P",
                      pinned: false,
                      branch: "main",
                      dirty: false,
                      openItems: null,
                      sessionCount: 0,
                      nextTask: null,
                    },
                  ],
                }),
              )
            : states[id]
        }
        connection={{ kind: "live" }}
        now={Date.parse(OBSERVED)}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/\b0 open items|null open items|undefined open items/);
    expect(text).toMatch(/open items unavailable|unavailable/i);
  });
});

describe("main.ts wires the one clock through the seam", () => {
  it("calls startClock with the host registry and never a bare timer", () => {
    const src = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");
    expect(src.match(/startClock\(/g)).toHaveLength(1);
    expect(src).toMatch(/startClock\(this\.hostRegistry\)/);
    expect(src).not.toMatch(/\bset(Interval|Timeout)\(|registerInterval\(/);
  });
});
