import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DestinationId } from "../view/destinations.js";
import { ACTION_ROW_BUDGET, ListBody, ROW_BUDGET } from "./list-body.js";

/**
 * The E4 list-bearing-panel contract (UI-SPEC "UI Considerations" rows empty,
 * populated, overflow, zero-one-many, long-text).
 *
 * Every row here is CONSTRUCTED IN THE TEST, never imported from a fixture:
 * fixtures feed the screenshot harness and the prototypes only, because a card
 * that looks real must be real (`D-17`). These rows exist to measure the row
 * budget and the overflow affordance, and they never reach a plugin card.
 */

interface Row {
  readonly id: string;
  readonly primary: string;
  readonly meta: string;
}

function rows(n: number): readonly Row[] {
  return Array.from({ length: n }, (_, index) => ({
    id: `row-${index}`,
    primary: `Row ${index}`,
    meta: `Meta ${index}`,
  }));
}

afterEach(cleanup);

function renderList(
  count: number,
  size: Parameters<typeof ListBody<Row>>[0]["size"],
  onMore?: (destination: DestinationId) => void,
) {
  return render(
    <ListBody<Row>
      rows={rows(count)}
      size={size}
      keyOf={(row) => row.id}
      renderPrimary={(row) => row.primary}
      renderMeta={(row) => row.meta}
      moreDestination="tasks"
      {...(onMore === undefined ? {} : { onMore })}
    />,
  );
}

describe("the row budget (UI-SPEC overflow row)", () => {
  it("fixes a budget per size hint: 3 small, 6 medium, 6 wide, 10 tall", () => {
    expect(ROW_BUDGET).toEqual({ small: 3, medium: 6, wide: 6, tall: 10 });
  });

  it("renders no list at all for zero rows — the frame's empty state owns that case", () => {
    const { container } = renderList(0, "medium");
    expect(container.querySelector("ul.ccc-list")).toBeNull();
    expect(container.querySelectorAll("li")).toHaveLength(0);
  });

  it("renders one row with no count chrome for a single row", () => {
    const { container } = renderList(1, "medium");
    expect(container.querySelectorAll("li.ccc-list-row")).toHaveLength(1);
    expect(container.querySelector(".ccc-list-more")).toBeNull();
    expect(container.textContent).not.toContain("more");
  });

  it("renders exactly the budget with no overflow row when rows equal the budget", () => {
    const { container } = renderList(6, "medium");
    expect(container.querySelectorAll("li.ccc-list-row")).toHaveLength(6);
    expect(container.querySelector(".ccc-list-more")).toBeNull();
  });

  it("caps a medium card at six rows and ends with +3 more", () => {
    const { container } = renderList(9, "medium");
    expect(container.querySelectorAll("li.ccc-list-row")).toHaveLength(6);
    expect(screen.getByRole("button", { name: "+3 more" })).toBeTruthy();
  });

  it("caps a tall card at ten rows and ends with +2 more", () => {
    const { container } = renderList(12, "tall");
    expect(container.querySelectorAll("li.ccc-list-row")).toHaveLength(10);
    expect(screen.getByRole("button", { name: "+2 more" })).toBeTruthy();
  });

  it("caps a small card at three rows", () => {
    const { container } = renderList(5, "small");
    expect(container.querySelectorAll("li.ccc-list-row")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "+2 more" })).toBeTruthy();
  });

  it("says +1 more, never 1 mores, for a single hidden row", () => {
    renderList(7, "medium");
    expect(screen.getByRole("button", { name: "+1 more" })).toBeTruthy();
    expect(screen.queryByText(/mores/)).toBeNull();
  });
});

describe("the overflow row focuses the owning destination", () => {
  it("calls onMore once with the destination, and nothing else", () => {
    const onMore = vi.fn();
    renderList(9, "medium", onMore);

    fireEvent.click(screen.getByRole("button", { name: "+3 more" }));

    expect(onMore).toHaveBeenCalledTimes(1);
    expect(onMore).toHaveBeenCalledWith("tasks");
  });

  it("is a real button, so it is keyboard-reachable with the shared focus ring", () => {
    const { container } = renderList(9, "medium");
    const more = container.querySelector("button.ccc-list-more");
    expect(more?.getAttribute("type")).toBe("button");
  });
});

describe("row anatomy (UI-SPEC populated and long-text rows)", () => {
  it("gives every row one primary line and one meta line", () => {
    const { container } = renderList(2, "medium");
    const first = container.querySelector("li.ccc-list-row");
    expect(first?.querySelectorAll(".ccc-list-primary")).toHaveLength(1);
    expect(first?.querySelectorAll(".ccc-list-meta")).toHaveLength(1);
    expect(first?.querySelector(".ccc-list-primary")?.textContent).toBe("Row 0");
    expect(first?.querySelector(".ccc-list-meta")?.textContent).toBe("Meta 0");
  });

  it("clamps a long primary line in CSS while keeping the full text readable", () => {
    const long = "A".repeat(400);
    const { container } = render(
      <ListBody<Row>
        rows={[{ id: "long", primary: long, meta: "Meta" }]}
        size="medium"
        keyOf={(row) => row.id}
        renderPrimary={(row) => row.primary}
        renderMeta={(row) => row.meta}
        moreDestination="tasks"
      />,
    );

    const primary = container.querySelector(".ccc-list-primary");
    // The clamp is CSS-only (`-webkit-line-clamp`), so the FULL text stays in
    // the DOM and therefore in the accessible name; `title` surfaces it on
    // hover. No `aria-label` on a paragraph — assistive technology ignores it
    // on a role=paragraph element, and biome rejects it (03-05 deviation 3).
    expect(primary?.classList.contains("ccc-clamp-2")).toBe(true);
    expect(primary?.textContent).toBe(long);
    expect(primary?.getAttribute("title")).toBe(long);
  });
});

describe("the optional row action (UI-SPEC S1 row action, C-11, A11Y floor 6)", () => {
  interface ActionRow {
    readonly id: string;
    readonly primary: string;
    readonly meta: string;
    readonly canAct: boolean;
  }

  const ACTION_ROWS: readonly ActionRow[] = [
    { id: "r1", primary: "alpha", meta: "meta 1", canAct: true },
    { id: "r2", primary: "beta", meta: "meta 2", canAct: false },
  ];

  it("Test 5: renders one action button per row whose renderAction returns a descriptor, none for a null row", () => {
    const onAction = vi.fn();
    const { container } = render(
      <ListBody<ActionRow>
        rows={ACTION_ROWS}
        size="medium"
        keyOf={(row) => row.id}
        renderPrimary={(row) => row.primary}
        renderMeta={(row) => row.meta}
        moreDestination="agent-runs"
        renderAction={(row) =>
          row.canAct
            ? {
                id: `focus-${row.id}`,
                label: "Focus",
                capability: "session:focus",
                target: { runId: row.id },
              }
            : null
        }
        renderActionLabel={(row) => `Focus terminal for ${row.primary}`}
        onAction={onAction}
      />,
    );

    const buttons = container.querySelectorAll("button.ccc-row-action");
    expect(buttons).toHaveLength(1);
    const button = screen.getByRole("button", { name: "Focus terminal for alpha" });
    expect(button.textContent).toBe("Focus");

    fireEvent.click(button);
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith({
      id: "focus-r1",
      label: "Focus",
      capability: "session:focus",
      target: { runId: "r1" },
    });
  });

  it("keeps ROW_BUDGET and the +{n} more control when a row action is present", () => {
    const rowsPastBudget = Array.from({ length: 9 }, (_, i) => ({
      id: `row-${i}`,
      primary: `Row ${i}`,
      meta: "meta",
      canAct: true,
    }));
    const { container } = render(
      <ListBody<ActionRow>
        rows={rowsPastBudget}
        size="medium"
        keyOf={(row) => row.id}
        renderPrimary={(row) => row.primary}
        renderMeta={(row) => row.meta}
        moreDestination="agent-runs"
        renderAction={(row) => ({
          id: `focus-${row.id}`,
          label: "Focus",
          capability: "session:focus",
        })}
        renderActionLabel={(row) => `Focus terminal for ${row.primary}`}
      />,
    );
    expect(container.querySelectorAll("li.ccc-list-row")).toHaveLength(6);
    expect(container.querySelectorAll("button.ccc-row-action")).toHaveLength(6);
    expect(screen.getByRole("button", { name: "+3 more" })).toBeTruthy();
  });
});

describe("the optional onSelectRow primary-line link (UI-SPEC S1 primary line)", () => {
  interface SelectRow {
    readonly id: string;
    readonly primary: string;
    readonly meta: string;
  }

  const SELECT_ROWS: readonly SelectRow[] = [
    { id: "r1", primary: "alpha", meta: "meta 1" },
    { id: "r2", primary: "beta", meta: "meta 2" },
  ];

  it("Test 6: with onSelectRow, the primary line is a button that calls it with that row", () => {
    const onSelectRow = vi.fn();
    const { container } = render(
      <ListBody<SelectRow>
        rows={SELECT_ROWS}
        size="medium"
        keyOf={(row) => row.id}
        renderPrimary={(row) => row.primary}
        renderMeta={(row) => row.meta}
        moreDestination="agent-runs"
        onSelectRow={onSelectRow}
      />,
    );

    const link = container.querySelector("button.ccc-session-row-link");
    expect(link?.textContent).toBe("alpha");
    expect(link?.getAttribute("title")).toBe("alpha");
    expect(container.querySelector("p.ccc-list-primary")).toBeNull();

    fireEvent.click(link as Element);
    expect(onSelectRow).toHaveBeenCalledTimes(1);
    expect(onSelectRow).toHaveBeenCalledWith(SELECT_ROWS[0]);
  });

  it("Test 6: without onSelectRow, the primary line stays the existing <p>, unchanged", () => {
    const { container } = render(
      <ListBody<SelectRow>
        rows={SELECT_ROWS}
        size="medium"
        keyOf={(row) => row.id}
        renderPrimary={(row) => row.primary}
        renderMeta={(row) => row.meta}
        moreDestination="agent-runs"
      />,
    );
    expect(container.querySelector("button.ccc-session-row-link")).toBeNull();
    const primary = container.querySelector("p.ccc-list-primary");
    expect(primary?.textContent).toBe("alpha");
    expect(primary?.classList.contains("ccc-clamp-2")).toBe(true);
  });
});

describe("renderMetaSegments (UI-SPEC S1 structured meta, plan 04-07, A11Y-04)", () => {
  it("renders one span per glyph segment, aria-hidden with a non-empty text sibling", () => {
    const { container } = render(
      <ListBody<Row>
        rows={[{ id: "r", primary: "Row", meta: "unused" }]}
        size="medium"
        keyOf={(row) => row.id}
        renderPrimary={(row) => row.primary}
        renderMeta={(row) => row.meta}
        renderMetaSegments={() => [
          { glyph: "⎇", text: "main" },
          { glyph: "✓", text: "Clean" },
        ]}
        moreDestination="tasks"
      />,
    );
    const meta = container.querySelector(".ccc-list-meta");
    const glyphs = meta?.querySelectorAll(".ccc-meta-glyph") ?? [];
    expect(glyphs).toHaveLength(2);
    for (const glyph of Array.from(glyphs)) {
      expect(glyph.getAttribute("aria-hidden")).toBe("true");
      expect(glyph.textContent?.length).toBeGreaterThan(0);
    }
    expect(meta?.textContent).toContain("main");
    expect(meta?.textContent).toContain("Clean");
    expect(meta?.textContent).toContain(" · ");
  });

  it("renders a segment with no glyph as text only, still inside the meta line", () => {
    const { container } = render(
      <ListBody<Row>
        rows={[{ id: "r", primary: "Row", meta: "unused" }]}
        size="medium"
        keyOf={(row) => row.id}
        renderPrimary={(row) => row.primary}
        renderMeta={(row) => row.meta}
        renderMetaSegments={() => [{ text: "Checking Git status…" }]}
        moreDestination="tasks"
      />,
    );
    const meta = container.querySelector(".ccc-list-meta");
    expect(meta?.querySelectorAll(".ccc-meta-glyph")).toHaveLength(0);
    expect(meta?.textContent).toBe("Checking Git status…");
  });

  it("existing callers with no renderMetaSegments prop are unaffected — a plain string meta renders as before", () => {
    const { container } = renderList(1, "medium");
    const meta = container.querySelector(".ccc-list-meta");
    expect(meta?.classList.contains("ccc-meta-segments")).toBe(false);
    expect(meta?.textContent).toBe("Meta 0");
  });
});

describe("primaryBadge (UI-SPEC S1 pinned marker, plan 04-07)", () => {
  it("prepends a visually hidden label and an aria-hidden glyph before the primary text", () => {
    const { container } = render(
      <ListBody<Row>
        rows={[{ id: "r", primary: "example-project", meta: "unused" }]}
        size="medium"
        keyOf={(row) => row.id}
        renderPrimary={(row) => row.primary}
        renderMeta={(row) => row.meta}
        primaryBadge={() => ({ hiddenLabel: "Pinned: ", glyph: "★" })}
        moreDestination="tasks"
      />,
    );
    const primary = container.querySelector(".ccc-list-primary");
    const hidden = primary?.querySelector(".ccc-visually-hidden");
    const glyph = primary?.querySelector(".ccc-meta-glyph");
    expect(hidden?.textContent).toBe("Pinned: ");
    expect(glyph?.getAttribute("aria-hidden")).toBe("true");
    expect(glyph?.textContent).toBe("★");
    expect(primary?.textContent).toBe("Pinned: ★ example-project");
  });

  it("renders no badge when the callback returns null", () => {
    const { container } = render(
      <ListBody<Row>
        rows={[{ id: "r", primary: "example-project", meta: "unused" }]}
        size="medium"
        keyOf={(row) => row.id}
        renderPrimary={(row) => row.primary}
        renderMeta={(row) => row.meta}
        primaryBadge={() => null}
        moreDestination="tasks"
      />,
    );
    const primary = container.querySelector(".ccc-list-primary");
    expect(primary?.querySelector(".ccc-visually-hidden")).toBeNull();
    expect(primary?.textContent).toBe("example-project");
  });
});

describe("renderActions / renderStatus (UI-SPEC S1, S2 toolbar slot, plan 04-10)", () => {
  it("fixes ACTION_ROW_BUDGET at small 2, medium 3, wide 3, tall 5 (RR-06)", () => {
    expect(ACTION_ROW_BUDGET).toEqual({ small: 2, medium: 3, wide: 3, tall: 5 });
  });

  it("uses ACTION_ROW_BUDGET instead of ROW_BUDGET once renderActions is present", () => {
    const { container } = render(
      <ListBody<Row>
        rows={rows(5)}
        size="medium"
        keyOf={(row) => row.id}
        renderPrimary={(row) => row.primary}
        renderMeta={(row) => row.meta}
        renderActions={() => <div className="ccc-test-actions">A</div>}
        moreDestination="tasks"
      />,
    );
    expect(container.querySelectorAll("li.ccc-list-row")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "+2 more" })).toBeTruthy();
  });

  it.each([
    ["small", 2],
    ["wide", 3],
    ["tall", 5],
  ] as const)("budgets rows to the action budget at size=%s (%i)", (size, expected) => {
    const { container, unmount } = render(
      <ListBody<Row>
        rows={rows(expected + 2)}
        size={size}
        keyOf={(row) => row.id}
        renderPrimary={(row) => row.primary}
        renderMeta={(row) => row.meta}
        renderActions={() => <span>A</span>}
        moreDestination="tasks"
      />,
    );
    expect(container.querySelectorAll("li.ccc-list-row")).toHaveLength(expected);
    unmount();
  });

  it("with no renderActions the ordinary ROW_BUDGET still applies (existing callers unaffected)", () => {
    const { container } = renderList(9, "medium");
    expect(container.querySelectorAll("li.ccc-list-row")).toHaveLength(ROW_BUDGET.medium);
  });

  it("renders the actions slot after the meta line, and the status slot after the actions", () => {
    const { container } = render(
      <ListBody<Row>
        rows={[{ id: "r", primary: "Row", meta: "Meta" }]}
        size="medium"
        keyOf={(row) => row.id}
        renderPrimary={(row) => row.primary}
        renderMeta={(row) => row.meta}
        renderActions={() => <div className="ccc-test-actions">A</div>}
        renderStatus={() => <p className="ccc-test-status">S</p>}
        moreDestination="tasks"
      />,
    );
    const row = container.querySelector("li.ccc-list-row");
    const classes = Array.from(row?.children ?? []).map((el) => el.className);
    expect(classes).toEqual([
      "ccc-list-primary ccc-clamp-2",
      "ccc-list-meta",
      "ccc-test-actions",
      "ccc-test-status",
    ]);
  });

  it("renders no actions or status slot when neither prop is given", () => {
    const { container } = renderList(1, "medium");
    const row = container.querySelector("li.ccc-list-row");
    expect(row?.children).toHaveLength(2);
  });
});
