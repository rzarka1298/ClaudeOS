import type { ViewChange, ViewDiffLine } from "@ccc/domain/approval-view.js";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalDiff } from "./approval-diff.js";

afterEach(cleanup);

function line(kind: ViewDiffLine["kind"], text: string, count: number | null = null): ViewDiffLine {
  return { kind, text, count };
}

function diff(lines: readonly ViewDiffLine[]): ViewChange {
  return { type: "diff", origin: "engine", lines: [...lines] };
}

/** The text a sighted reader sees: the hidden prefixes removed. */
function visibleText(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  for (const hidden of clone.querySelectorAll(".ccc-visually-hidden")) hidden.remove();
  return clone.textContent ?? "";
}

describe("the diff list (Test 3)", () => {
  it("is an ordered list labelled Changes with one item per line and a data-kind on each", () => {
    render(
      <ApprovalDiff
        change={diff([
          line("context", "unchanged text"),
          line("removed", "state: running"),
          line("added", "state: cancelled"),
          line("omitted", "", 14),
        ])}
      />,
    );
    const list = screen.getByRole("list", { name: "Changes" });
    expect(list.tagName).toBe("OL");
    const items = within(list).getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("data-kind"))).toEqual([
      "context",
      "removed",
      "added",
      "omitted",
    ]);
  });

  it("marks changed lines with a visible glyph and word in the gutter, as text", () => {
    render(
      <ApprovalDiff
        change={diff([line("removed", "state: running"), line("added", "state: cancelled")])}
      />,
    );
    const [removed, added] = screen.getAllByRole("listitem");
    expect(visibleText(removed as Element)).toContain("− Removed");
    expect(visibleText(removed as Element)).toContain("state: running");
    expect(visibleText(added as Element)).toContain("+ Added");
    expect(visibleText(added as Element)).toContain("state: cancelled");
    expect(removed?.querySelector(".ccc-diff-gutter")?.textContent).toBe("− Removed");
    expect(added?.querySelector(".ccc-diff-gutter")?.textContent).toBe("+ Added");
  });

  it("gives a context line an empty visible gutter with a hidden Unchanged prefix", () => {
    render(<ApprovalDiff change={diff([line("context", "same")])} />);
    const item = screen.getByRole("listitem");
    const gutter = item.querySelector(".ccc-diff-gutter") as Element;
    expect(visibleText(gutter)).toBe("");
    expect(gutter.querySelector(".ccc-visually-hidden")?.textContent).toContain("Unchanged");
  });

  it("collapses a run to a line naming how many lines it holds", () => {
    render(<ApprovalDiff change={diff([line("omitted", "", 14), line("omitted", "", 1)])} />);
    const [many, one] = screen.getAllByRole("listitem");
    expect(many?.textContent).toContain("… 14 unchanged lines");
    expect(one?.textContent).toContain("… 1 unchanged line");
    expect(one?.textContent).not.toContain("1 unchanged lines");
  });

  it("applies no colour, no inline style and no class beyond its own hooks", () => {
    const { container } = render(
      <ApprovalDiff change={diff([line("added", "x"), line("removed", "y")])} />,
    );
    expect(container.querySelector("[style]")).toBeNull();
    for (const element of container.querySelectorAll("[class]")) {
      expect(element.getAttribute("class")).toMatch(/^ccc-/);
    }
  });
});

describe("the cap and the disclosure (Test 4)", () => {
  const many = Array.from({ length: 45 }, (_, index) => line("context", `line ${index}`));

  it("renders the first forty lines, then offers to show all of them", () => {
    render(<ApprovalDiff change={diff(many)} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(40);
    const toggle = screen.getByRole("button", { name: "Show all 45 lines" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("expands in place and becomes Show fewer lines", () => {
    render(<ApprovalDiff change={diff(many)} />);
    fireEvent.click(screen.getByRole("button", { name: "Show all 45 lines" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(45);
    const toggle = screen.getByRole("button", { name: "Show fewer lines" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(screen.getAllByRole("listitem")).toHaveLength(40);
  });

  it("is a plain button in the tab order, and absent when everything already fits", () => {
    const { rerender } = render(<ApprovalDiff change={diff(many)} />);
    const toggle = screen.getByRole("button", { name: "Show all 45 lines" });
    expect(toggle.getAttribute("type")).toBe("button");
    expect(toggle.getAttribute("tabindex")).toBeNull();
    rerender(<ApprovalDiff change={diff(many.slice(0, 40))} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("the payload form and the empty change (Test 5)", () => {
  it("renders one added line per field as key and value", () => {
    render(
      <ApprovalDiff
        change={{
          type: "payload",
          origin: "requester",
          fields: [
            { label: "title", value: "Weekly review" },
            { label: "priority", value: "high" },
          ],
        }}
      />,
    );
    const items = screen.getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("data-kind"))).toEqual(["added", "added"]);
    expect(visibleText(items[0] as Element)).toContain("+ Added");
    expect(visibleText(items[0] as Element)).toContain("title: Weekly review");
    expect(visibleText(items[1] as Element)).toContain("priority: high");
  });

  it("says plainly that an empty change does nothing", () => {
    render(<ApprovalDiff change={{ type: "none", origin: "engine" }} />);
    expect(screen.getByText("No change. Approving this does nothing.")).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });
});
