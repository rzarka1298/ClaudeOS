import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionChangedAt, connectionState, lastEvent } from "../connection-state.js";
import type { QuickActionDescriptor, WidgetDefinition, WidgetState } from "./contract.js";
import { WidgetFrame } from "./frame.js";
import { serviceHealthState, serviceHealthWidget } from "./service-health.js";

/**
 * The tracer test for plan 03-05: one real widget, rendered through the shared
 * frame, from the live connection signals — contract → derivation → frame →
 * footer, end to end. Every other widget and every other presentation expands
 * from this proven path without an architectural change.
 *
 * Module-level signals leak across tests unless reset in BOTH hooks — the same
 * discipline `view/shell.test.tsx` already keeps.
 */

const CHANGED_AT = "2026-09-15T00:00:00.000Z";
const EVENT_AT = "2026-09-15T00:10:00.000Z";
const TWO_MINUTES_LATER = Date.parse(EVENT_AT) + 2 * 60 * 1000;

function reset(): void {
  connectionState.value = { kind: "connecting" };
  lastEvent.value = undefined;
  connectionChangedAt.value = CHANGED_AT;
}

afterEach(() => {
  cleanup();
  reset();
});

beforeEach(reset);

function renderServiceHealth(now: number) {
  return render(
    <WidgetFrame
      definition={serviceHealthWidget}
      state={serviceHealthState.value}
      connection={connectionState.value}
      size="medium"
      now={now}
    />,
  );
}

describe("WidgetFrame rendering the service-health widget", () => {
  it("renders a ready card with the live event, its relative time and a Source disclosure", () => {
    connectionState.value = { kind: "live" };
    lastEvent.value = { type: "service.heartbeat", occurredAt: EVENT_AT };

    const { container } = renderServiceHealth(TWO_MINUTES_LATER);
    const card = container.querySelector("section.ccc-card");

    expect(card).toBeTruthy();
    expect(card?.getAttribute("data-presentation")).toBe("ready");
    expect(card?.getAttribute("data-size")).toBe("medium");
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("Service health");
    expect(card?.querySelector(".ccc-card-body")?.textContent).toContain("service.heartbeat");

    const time = card?.querySelector("time.ccc-footer-time");
    expect(time?.getAttribute("datetime")).toBe(EVENT_AT);
    expect(time?.textContent).toBe("2 minutes ago");

    const badge = card?.querySelector('.ccc-badge[data-badge="live"]');
    expect(badge?.textContent).toContain("Live");

    const source = screen.getByRole("button", { name: "Source" });
    expect(source.getAttribute("aria-expanded")).toBe("false");
  });

  it("renders the connecting state as a busy skeleton with an em-dash time and a disabled Source button", () => {
    connectionState.value = { kind: "connecting" };

    const { container } = renderServiceHealth(TWO_MINUTES_LATER);
    const card = container.querySelector("section.ccc-card");

    expect(card?.getAttribute("data-presentation")).toBe("loading");
    expect(card?.getAttribute("aria-busy")).toBe("true");
    expect(card?.querySelector("time.ccc-footer-time")?.textContent).toBe("—");
    expect(card?.querySelector(".ccc-badge")).toBeNull();
    expect(screen.getByRole("button", { name: "Source" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
  });

  it("keeps the disconnected service-health card ready, because its data IS the connection", () => {
    connectionState.value = { kind: "disconnected", reason: "connect ECONNREFUSED" };

    const { container } = renderServiceHealth(TWO_MINUTES_LATER);
    const card = container.querySelector("section.ccc-card");

    // ADR-0023 "Panel state assignment": a card cannot be disconnected from the
    // fact that it is disconnected — its single data key is `local`, so the
    // D-15 transport flip never reaches it.
    expect(card?.getAttribute("data-presentation")).toBe("ready");
    expect(screen.getByText(/Service disconnected — connect ECONNREFUSED/)).toBeTruthy();
  });
});

describe("WidgetFrame ownership of the footer", () => {
  const EMPTY_BODY_WIDGET: WidgetDefinition<null> = {
    id: "test-widget",
    title: "Test widget",
    dataKeys: [{ key: "test.key", transport: "local", sourceLabel: "Test source" }],
    refresh: { kind: "manual" },
    minSize: "small",
    preferredSize: "small",
    featureFlag: "widget.test-widget",
    quickActions: [],
    renderBody: () => null,
    renderEmpty: () => null,
  };

  it("renders the footer even when a widget's body renders nothing at all", () => {
    const { container } = render(
      <WidgetFrame
        definition={EMPTY_BODY_WIDGET}
        state={{
          kind: "ready",
          data: null,
          observedAt: EVENT_AT,
          freshness: "live",
          partiality: { partial: false },
          isEmpty: false,
        }}
        connection={{ kind: "live" }}
        size="small"
        now={TWO_MINUTES_LATER}
      />,
    );

    expect(container.querySelector(".ccc-card-body")?.textContent).toBe("");
    expect(container.querySelector(".ccc-card-footer")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Source" })).toBeTruthy();
  });
});

/**
 * Every presentation's copy, verbatim from the UI-SPEC Copywriting Contract,
 * plus the A11Y-04 floor: the accessible text of the card differs across all
 * eight presentations, so no two states are distinguishable only by colour.
 */
describe("the eight presentations", () => {
  const PANEL: WidgetDefinition<string> = {
    id: "test-panel",
    title: "Test panel",
    dataKeys: [{ key: "github.discoveries", transport: "service", sourceLabel: "GitHub" }],
    refresh: { kind: "manual" },
    minSize: "small",
    preferredSize: "small",
    featureFlag: "widget.test-panel",
    quickActions: [],
    renderBody: ({ data }) => <p className="ccc-body-value">{data}</p>,
    renderEmpty: () => null,
  };

  const READY: WidgetState<string> = {
    kind: "ready",
    data: "payload",
    observedAt: EVENT_AT,
    freshness: "live",
    partiality: { partial: false },
    isEmpty: false,
  };

  function renderPanel(
    state: WidgetState<string>,
    connection: Parameters<typeof renderCard>[1] = { kind: "live" },
    onQuickAction?: (descriptor: QuickActionDescriptor) => void,
  ) {
    return renderCard(state, connection, onQuickAction);
  }

  function renderCard(
    state: WidgetState<string>,
    connection:
      | { kind: "connecting" }
      | { kind: "live" }
      | { kind: "disconnected"; reason: string },
    onQuickAction?: (descriptor: QuickActionDescriptor) => void,
  ) {
    return render(
      <WidgetFrame
        definition={PANEL}
        state={state}
        connection={connection}
        size="small"
        now={TWO_MINUTES_LATER}
        onQuickAction={onQuickAction}
      />,
    );
  }

  function focusableCount(container: HTMLElement): number {
    return container.querySelectorAll("button, a[href], input, select, textarea, [tabindex]")
      .length;
  }

  it("loading: a busy card with three skeleton lines and a hidden Loading line", () => {
    const { container } = renderPanel({ kind: "loading" });
    const card = container.querySelector("section.ccc-card");
    expect(card?.getAttribute("aria-busy")).toBe("true");
    expect(container.querySelectorAll(".ccc-skeleton-line")).toHaveLength(3);
    expect(container.querySelector(".ccc-visually-hidden")?.textContent).toBe("Loading test panel");
  });

  it("empty: the contract copy, a footer that stays, and exactly one focusable control", () => {
    const { container } = renderPanel({ ...READY, isEmpty: true });
    expect(screen.getByText("Nothing here yet")).toBeTruthy();
    expect(
      screen.getByText("Test panel has no items right now. New items appear as they arrive."),
    ).toBeTruthy();
    expect(container.querySelector(".ccc-card-footer")).toBeTruthy();
    expect(focusableCount(container)).toBe(1);
  });

  it("stale: the last-good values stay readable, the header mutes, the badge reads Stale", () => {
    const { container } = renderPanel({ ...READY, freshness: "stale" });
    const card = container.querySelector("section.ccc-card");
    expect(card?.getAttribute("data-presentation")).toBe("stale");
    expect(container.querySelector(".ccc-body-value")?.textContent).toBe("payload");
    expect(container.querySelector(".ccc-badge")?.textContent).toContain("Stale");
  });

  it("disconnected: both lines, a dimmed body and an Unavailable badge", () => {
    const { container } = renderPanel(READY, {
      kind: "disconnected",
      reason: "connect ECONNREFUSED",
    });
    expect(screen.getByText("Service disconnected")).toBeTruthy();
    expect(
      screen.getByText("Showing the last values received 2 minutes ago. They may be out of date."),
    ).toBeTruthy();
    expect(container.querySelector(".ccc-card-body")?.getAttribute("data-dimmed")).toBe("true");
    expect(container.querySelector(".ccc-badge")?.textContent).toContain("Unavailable");
  });

  it("error: the contract copy with a decorative glyph, and a failed source in the panel", () => {
    const { container } = renderPanel({ kind: "error", message: "HTTP 500" });
    expect(screen.getByText("Couldn't load test panel.")).toBeTruthy();
    expect(
      screen.getByText("Check the service in Settings → Diagnostics, then refresh."),
    ).toBeTruthy();
    const glyph = container.querySelector(".ccc-error-glyph");
    expect(glyph?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".ccc-badge")?.textContent).toContain("Unavailable");

    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(container.querySelector(".ccc-source-panel")?.textContent).toContain("GitHub — failed");
  });

  it("permission-required: a Connect button that precedes Source and only emits a descriptor", () => {
    const onQuickAction = vi.fn();
    const { container } = renderPanel(
      { kind: "permission-required", capability: "github", sourceLabel: "GitHub" },
      { kind: "live" },
      onQuickAction,
    );

    expect(screen.getByText("GitHub isn't connected")).toBeTruthy();
    expect(screen.getByText("Connect GitHub to see test panel here.")).toBeTruthy();

    const buttons = [...container.querySelectorAll("button")].map((b) => b.textContent);
    expect(buttons).toEqual(["Connect GitHub", "Source"]);

    fireEvent.click(screen.getByRole("button", { name: "Connect GitHub" }));
    expect(onQuickAction).toHaveBeenCalledTimes(1);
    expect(onQuickAction).toHaveBeenCalledWith({
      id: "connect-github",
      label: "Connect GitHub",
      capability: "connect:github",
    });
  });

  it("unavailable: the no-source-yet copy and an Unavailable badge", () => {
    const { container } = renderPanel({ kind: "unavailable" });
    expect(screen.getByText("No source yet")).toBeTruthy();
    expect(
      screen.getByText(
        "Test panel has no data source in this build. It fills in once its source is available.",
      ),
    ).toBeTruthy();
    expect(container.querySelector(".ccc-badge")?.textContent).toContain("Unavailable");
  });

  it("A11Y-04: the accessible text differs across all eight presentations", () => {
    const cases: [string, WidgetState<string>, Parameters<typeof renderCard>[1]][] = [
      ["loading", { kind: "loading" }, { kind: "live" }],
      ["empty", { ...READY, isEmpty: true }, { kind: "live" }],
      ["ready", READY, { kind: "live" }],
      ["stale", { ...READY, freshness: "stale" }, { kind: "live" }],
      ["disconnected", READY, { kind: "disconnected", reason: "connect ECONNREFUSED" }],
      ["error", { kind: "error", message: "HTTP 500" }, { kind: "live" }],
      [
        "permission-required",
        { kind: "permission-required", capability: "github", sourceLabel: "GitHub" },
        { kind: "live" },
      ],
      ["unavailable", { kind: "unavailable" }, { kind: "live" }],
    ];

    const texts = cases.map(([, state, connection]) => {
      const { container, unmount } = renderCard(state, connection);
      const text = container.querySelector("section.ccc-card")?.textContent ?? "";
      unmount();
      return text;
    });

    expect(new Set(texts).size).toBe(8);
    for (const text of texts) expect(text.length).toBeGreaterThan(0);
  });
});
