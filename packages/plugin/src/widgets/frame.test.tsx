import { cleanup, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectionChangedAt, connectionState, lastEvent } from "../connection-state.js";
import type { WidgetDefinition } from "./contract.js";
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
