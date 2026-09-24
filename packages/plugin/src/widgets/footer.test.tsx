import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import { WidgetFooter } from "./footer.js";
import type { FooterModel } from "./presentation.js";
import { formatAbsoluteTime } from "./relative-time.js";

/**
 * The Source affordance is the phase's most-repeated control, so its keyboard
 * contract is asserted rather than assumed: Tab reaches it, Enter and Space
 * toggle it, Escape closes it and gives focus back (A11Y-01 floor 5). A
 * tooltip could satisfy none of this, which is why the UI-SPEC forbids one.
 */

const OBSERVED_AT = "2026-09-15T00:10:00.000Z";
const NOW = Date.parse(OBSERVED_AT) + 2 * 60 * 1000;

function model(overrides: Partial<FooterModel> = {}): FooterModel {
  return {
    observedAt: OBSERVED_AT,
    freshness: "live",
    partiality: { partial: false },
    sources: [{ label: "GitHub", status: "ok" }],
    ...overrides,
  };
}

function renderFooter(overrides: Partial<FooterModel> = {}, disabled = false) {
  return render(
    <WidgetFooter model={model(overrides)} panelTitle="test panel" now={NOW} disabled={disabled} />,
  );
}

afterEach(cleanup);

describe("the Source disclosure (A11Y-01)", () => {
  it("controls a panel whose id is exactly the button's aria-controls", () => {
    const { container } = renderFooter();
    const button = screen.getByRole("button", { name: "Source" });
    const panelId = button.getAttribute("aria-controls");
    expect(panelId).toBeTruthy();
    expect(container.querySelector(`#${panelId}`)?.classList.contains("ccc-source-panel")).toBe(
      true,
    );
  });

  it("is reachable by Tab — a real button in the document's tab order", () => {
    renderFooter();
    const button = screen.getByRole("button", { name: "Source" });
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("tabindex")).toBeNull();
    expect(button.hasAttribute("disabled")).toBe(false);
  });

  it("toggles on Enter and on Space", () => {
    const { container } = renderFooter();
    const button = screen.getByRole("button", { name: "Source" });
    const panel = container.querySelector(".ccc-source-panel");

    fireEvent.keyDown(button, { key: "Enter" });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(panel?.hasAttribute("hidden")).toBe(false);

    fireEvent.keyDown(button, { key: "Enter" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(panel?.hasAttribute("hidden")).toBe(true);

    fireEvent.keyDown(button, { key: " " });
    expect(button.getAttribute("aria-expanded")).toBe("true");
  });

  it("closes on Escape and returns focus to the button", () => {
    const { container } = renderFooter();
    const button = screen.getByRole("button", { name: "Source" });
    const panel = container.querySelector(".ccc-source-panel");

    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");

    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(panel as Element, { key: "Escape" });

    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(panel?.hasAttribute("hidden")).toBe(true);
    expect(document.activeElement).toBe(button);
  });

  it("does nothing on Enter while the card is still loading", () => {
    renderFooter({ observedAt: null, freshness: null }, true);
    const button = screen.getByRole("button", { name: "Source" });
    expect(button.getAttribute("aria-disabled")).toBe("true");

    fireEvent.keyDown(button, { key: "Enter" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("the absolute timestamp (D-16, A11Y-01)", () => {
  it("is available on hover AND on focus — a title plus an aria-describedby target", () => {
    const { container } = renderFooter();
    const time = container.querySelector("time.ccc-footer-time");
    const absolute = formatAbsoluteTime(OBSERVED_AT);

    expect(time?.getAttribute("title")).toBe(absolute);
    const describedBy = time?.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const description = container.querySelector(`#${describedBy}`);
    expect(description?.textContent).toBe(absolute);
    expect(description?.classList.contains("ccc-visually-hidden")).toBe(true);
  });
});

describe("the partial badge (ADR-0002, UI-SPEC partial row)", () => {
  it("renders as its own element beside the freshness badge, never merged into it", () => {
    const { container } = renderFooter({
      partiality: { partial: true, missingSources: ["GitHub"] },
    });
    const badges = container.querySelectorAll(".ccc-badge");
    expect(badges).toHaveLength(2);
    expect(badges[0]?.textContent).toContain("Freshness:");
    expect(badges[1]?.getAttribute("data-badge")).toBe("partial");
    expect(badges[1]?.querySelector(".ccc-badge-label")?.textContent).toBe("Partial");
    expect(badges[1]?.textContent).toContain("Partial — 1 source didn't respond: GitHub");
  });

  it("pluralises the source count, never 1 sources", () => {
    const { container } = renderFooter({
      partiality: { partial: true, missingSources: ["GitHub", "Google Calendar"] },
    });
    const partial = container.querySelector('.ccc-badge[data-badge="partial"]');
    expect(partial?.textContent).toContain(
      "Partial — 2 sources didn't respond: GitHub, Google Calendar",
    );
  });

  it("renders no partial badge when nothing is missing", () => {
    const { container } = renderFooter();
    expect(container.querySelector('.ccc-badge[data-badge="partial"]')).toBeNull();
  });
});

describe("footer part order (UI-06 ordering edge)", () => {
  it("renders time, then the freshness badge, then the partial badge, then Source", () => {
    const { container } = renderFooter({
      partiality: { partial: true, missingSources: ["GitHub"] },
    });
    const parts = [
      ...container.querySelectorAll(
        ".ccc-footer-time, .ccc-badge[data-badge='live'], .ccc-badge[data-badge='partial'], .ccc-source-button",
      ),
    ].map((element) => element.className.split(" ")[0]);

    expect(parts).toEqual(["ccc-footer-time", "ccc-badge", "ccc-badge", "ccc-source-button"]);
    expect(container.querySelectorAll(".ccc-badge")[1]?.getAttribute("data-badge")).toBe("partial");
  });
});
