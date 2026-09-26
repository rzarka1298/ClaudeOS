import { act, cleanup, fireEvent, render, screen } from "@testing-library/preact";
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

/**
 * One press of Tab: moves focus to the next element in sequential focus
 * order, the way a browser does for elements without a positive tabindex —
 * document order over everything that is focusable, not disabled, not inside
 * a `hidden` subtree and not given `tabindex="-1"`. jsdom performs no focus
 * navigation of its own, and user-event is not a dependency here, so this is
 * the smallest faithful stand-in: a `<time>` without a tabindex is skipped by
 * it exactly as a browser skips it (judge-r1 finding 2).
 */
function pressTab(): Element | null {
  const candidates = [
    ...document.querySelectorAll<HTMLElement>(
      "a[href], button, input, select, textarea, [tabindex]",
    ),
  ].filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.hasAttribute("disabled") &&
      element.closest("[hidden]") === null,
  );
  const current = document.activeElement;
  const from = current instanceof HTMLElement ? candidates.indexOf(current) : -1;
  const next = candidates[from + 1];
  current?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
  // jsdom's focus() and blur() fire the focus/blur events a real Tab would;
  // act() flushes the render those events schedule, as fireEvent does. The
  // callback is synchronous, so the flush completes before act returns and
  // its thenable carries nothing to await.
  void act(() => {
    if (next !== undefined) {
      next.focus();
    } else if (current instanceof HTMLElement) {
      current.blur();
    }
  });
  return document.activeElement;
}

describe("the absolute timestamp is reachable by keyboard (D-16, A11Y-01; judge-r1 finding 2)", () => {
  function renderAfterAnchor(overrides: Partial<FooterModel> = {}) {
    return render(
      <div>
        <button type="button">Before</button>
        <WidgetFooter model={model(overrides)} panelTitle="test panel" now={NOW} />
      </div>,
    );
  }

  it("takes focus on Tab, straight after the control before the footer", () => {
    const { container } = renderAfterAnchor();
    screen.getByRole("button", { name: "Before" }).focus();

    const focused = pressTab();

    expect(focused).toBe(container.querySelector("time.ccc-footer-time"));
  });

  it("reveals the absolute time visibly while focused, and hides it again on the next Tab", () => {
    const { container } = renderAfterAnchor();
    const absolute = formatAbsoluteTime(OBSERVED_AT);
    const time = container.querySelector("time.ccc-footer-time");
    const target = () => container.querySelector(`#${time?.getAttribute("aria-describedby")}`);

    expect(target()?.classList.contains("ccc-visually-hidden")).toBe(true);

    screen.getByRole("button", { name: "Before" }).focus();
    pressTab();
    expect(document.activeElement).toBe(time);
    expect(target()?.textContent).toBe(absolute);
    expect(target()?.classList.contains("ccc-visually-hidden")).toBe(false);
    expect(target()?.classList.contains("ccc-footer-absolute")).toBe(true);

    expect(pressTab()).toBe(screen.getByRole("button", { name: "Source" }));
    expect(target()?.classList.contains("ccc-visually-hidden")).toBe(true);
  });

  it("stays out of the tab order when there is no timestamp to reveal", () => {
    const { container } = renderAfterAnchor({ observedAt: null, freshness: null });
    screen.getByRole("button", { name: "Before" }).focus();

    expect(pressTab()).toBe(screen.getByRole("button", { name: "Source" }));
    expect(container.querySelector("time.ccc-footer-time")?.hasAttribute("tabindex")).toBe(false);
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
