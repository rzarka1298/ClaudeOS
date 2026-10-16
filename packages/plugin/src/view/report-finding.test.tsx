import { HOSTILE_CORPUS } from "@ccc/domain/approval-corpus.js";
import { cleanup, render } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reportItem } from "../test-support/research-report-fixtures.js";
import { ReportFinding } from "./report-finding.js";

/**
 * The downgrade marker (plan 07-15; wave 3/4 carried item, 07-14 "no marker for a downgraded
 * finding"): a finding whose stored quote failed the service's read-time re-verification is served
 * as an inference with no quote and `quoteUnverified: true`; the reader says so in fixed copy, in
 * words, beside the finding. This file is pure ASCII: hostile text comes from the shared corpus.
 */

afterEach(cleanup);

const MARKER = "The saved quote couldn't be checked against its source, so it isn't shown.";

function mount(overrides = {}) {
  const { container } = render(
    <ul>
      <ReportFinding
        item={reportItem(1, {
          kind: "inference",
          quote: null,
          quoteSourceNumber: null,
          quoteUnverified: true,
          ...overrides,
        })}
        onCite={vi.fn()}
      />
    </ul>,
  );
  return container;
}

describe("the marker for a finding whose quote was withheld", () => {
  it("says so in words, keeps the inference label and shows no quote", () => {
    const root = mount();
    const item = root.querySelector("li.ccc-report-item") as HTMLElement;
    expect(item.getAttribute("data-kind")).toBe("inference");
    expect(item.getAttribute("data-quote-unverified")).toBe("true");
    expect(item.querySelector(".ccc-report-kind")?.textContent).toBe(`${String.fromCodePoint(0x2234)} Model inference`);
    expect(item.querySelector("blockquote")).toBeNull();
    expect(item.textContent).toContain(MARKER);
    const note = [...item.querySelectorAll("p")].find((p) => p.textContent === MARKER);
    expect(note).toBeDefined();
  });

  it("is not carried by colour alone: the sentence is text, and it sits before the citations", () => {
    const root = mount();
    const paragraphs = [...root.querySelectorAll("li > p")].map((p) => p.className);
    const noteAt = [...root.querySelectorAll("li > p")].findIndex((p) => p.textContent === MARKER);
    const citationsAt = paragraphs.indexOf("ccc-report-citations");
    expect(noteAt).toBeGreaterThan(-1);
    expect(noteAt).toBeLessThan(citationsAt);
  });

  it("is absent from an authored inference, a verified quote and an older service's finding", () => {
    for (const overrides of [
      { quoteUnverified: undefined },
      {
        kind: "source-fact",
        quote: "a verified passage",
        quoteSourceNumber: 1,
        quoteUnverified: undefined,
      },
    ]) {
      const root = mount(overrides);
      const item = root.querySelector("li.ccc-report-item") as HTMLElement;
      expect(item.hasAttribute("data-quote-unverified")).toBe(false);
      expect(item.textContent).not.toContain(MARKER);
      cleanup();
    }
  });

  it("stays fixed copy whatever the finding says: hostile text is literal and the marker unchanged", () => {
    for (const entry of HOSTILE_CORPUS) {
      const root = mount({ text: entry.text });
      const item = root.querySelector("li.ccc-report-item") as HTMLElement;
      expect(item.querySelector("a, img, iframe, script, form, style"), entry.name).toBeNull();
      const notes = [...item.querySelectorAll("p")].filter((p) => p.textContent === MARKER);
      expect(notes, entry.name).toHaveLength(1);
      cleanup();
    }
  });
});
