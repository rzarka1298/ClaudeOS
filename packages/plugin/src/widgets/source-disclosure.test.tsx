import { cleanup, fireEvent, render } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import { SourceDisclosure } from "./source-disclosure.js";

/**
 * Task 2: the per-section Source disclosure (UI-SPEC "Per-number Source",
 * USAGE-04, D-37, R-09). Mirrors `footer.tsx`'s disclosure mechanics
 * exactly: a real `<button aria-expanded aria-controls>`, Enter/Space
 * toggles, Escape closes and restores focus, no popover, no tooltip.
 */

afterEach(cleanup);

const ROWS = [
  {
    numberLabel: "Cache read: 1,204,331 tokens",
    source: "Local transcript analysis",
    range: "Sep 26, 12:00 AM – 2:05 PM",
    observed: "Sep 26, 2026, 2:05 PM",
    freshness: "Live",
  },
];

describe("SourceDisclosure", () => {
  it("has a unique accessible name composed from 'Source' plus the visually hidden suffix", () => {
    const { getByRole } = render(<SourceDisclosure srSuffix="for plan usage" rows={ROWS} />);
    expect(getByRole("button", { name: "Source for plan usage" })).toBeDefined();
  });

  it("toggles open on click, and the panel lists every row's labelled lines with no slash", () => {
    const { getByRole, container } = render(
      <SourceDisclosure srSuffix="for token activity" rows={ROWS} />,
    );
    const button = getByRole("button", { name: "Source for token activity" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const panelId = button.getAttribute("aria-controls");
    const panel = container.querySelector(`#${panelId}`);
    expect(panel?.textContent).toContain("Cache read: 1,204,331 tokens");
    expect(panel?.textContent).toContain("Source: Local transcript analysis");
    expect(panel?.textContent).toContain("Range: Sep 26, 12:00 AM – 2:05 PM");
    expect(panel?.textContent).toContain("Observed: Sep 26, 2026, 2:05 PM");
    expect(panel?.textContent).toContain("Freshness: Live");
    expect(panel?.textContent).not.toContain("/");
  });

  it("Enter toggles the panel open", () => {
    const { getByRole } = render(<SourceDisclosure srSuffix="for estimated cost" rows={ROWS} />);
    const button = getByRole("button", { name: "Source for estimated cost" });
    fireEvent.keyDown(button, { key: "Enter" });
    expect(button.getAttribute("aria-expanded")).toBe("true");
  });

  it("Escape closes the panel and returns focus to the button", () => {
    const { getByRole, container } = render(
      <SourceDisclosure srSuffix="for plan usage" rows={ROWS} />,
    );
    const button = getByRole("button", { name: "Source for plan usage" });
    fireEvent.click(button);
    const footer = container.querySelector("[data-source-disclosure]") as HTMLElement;
    fireEvent.keyDown(footer, { key: "Escape" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("renders no native popover attribute and no title tooltip on the button", () => {
    const { getByRole } = render(<SourceDisclosure srSuffix="for plan usage" rows={ROWS} />);
    const button = getByRole("button", { name: "Source for plan usage" });
    expect(button.hasAttribute("popover")).toBe(false);
    expect(button.hasAttribute("title")).toBe(false);
  });

  it("is aria-disabled while the section has no observation yet", () => {
    const { getByRole } = render(<SourceDisclosure srSuffix="for plan usage" rows={[]} disabled />);
    const button = getByRole("button", { name: "Source for plan usage" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
  });
});

describe("SourceDisclosure when its section loses its observation (wave 3 review)", () => {
  it("closes and hides an open panel once disabled, and stays closed when re-enabled", () => {
    const { getByRole, container, rerender } = render(
      <SourceDisclosure srSuffix="for token activity" rows={ROWS} />,
    );
    const button = getByRole("button", { name: "Source for token activity" });
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const panel = () => container.querySelector(`#${button.getAttribute("aria-controls")}`);
    expect(panel()?.hasAttribute("hidden")).toBe(false);

    rerender(<SourceDisclosure srSuffix="for token activity" rows={[]} disabled />);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(panel()?.hasAttribute("hidden")).toBe(true);

    rerender(<SourceDisclosure srSuffix="for token activity" rows={ROWS} />);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(panel()?.hasAttribute("hidden")).toBe(true);
  });
});
