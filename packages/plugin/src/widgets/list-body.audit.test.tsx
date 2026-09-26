import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import { ListBody } from "./list-body.js";

/** Test-audit additions for plan 03-06: the ListBody gaps the original suite left open. */

const STYLES = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "styles.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

afterEach(cleanup);

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(STYLES);
  return match?.[2] ?? "";
}

describe("ListBody audit", () => {
  it("caps a wide card at six rows and reports the rest", () => {
    const rows = Array.from({ length: 11 }, (_, i) => `row ${i}`);
    const { container } = render(
      <ListBody<string>
        rows={rows}
        size="wide"
        keyOf={(r) => r}
        renderPrimary={(r) => r}
        renderMeta={() => "meta"}
        moreDestination="tasks"
      />,
    );
    expect(container.querySelectorAll(".ccc-list-row")).toHaveLength(6);
    expect(container.querySelector(".ccc-list-more")?.textContent).toBe("+5 more");
    expect(container.textContent).not.toContain("row 6");
  });

  it("keeps the first rows in order rather than any other slice", () => {
    const { container } = render(
      <ListBody<string>
        rows={["a", "b", "c", "d", "e"]}
        size="small"
        keyOf={(r) => r}
        renderPrimary={(r) => r}
        renderMeta={() => "m"}
        moreDestination="tasks"
      />,
    );
    const primaries = [...container.querySelectorAll(".ccc-list-primary")].map(
      (p) => p.textContent,
    );
    expect(primaries).toEqual(["a", "b", "c"]);
  });

  it("a card clips rather than scrolls sideways, and rows wrap long text", () => {
    expect(rule(".ccc-card")).toMatch(/overflow:\s*hidden/);
    expect(rule(".ccc-list-row")).toMatch(/min-width:\s*0/);
    expect(rule(".ccc-list-primary")).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule(".ccc-list-meta")).toMatch(/overflow-wrap:\s*anywhere/);
    expect(STYLES).not.toMatch(/overflow-x:\s*(auto|scroll)/);
  });

  it("rows are Body size and meta is Label size", () => {
    expect(rule(".ccc-list-primary")).toMatch(/font-size:\s*var\(--ccc-text-body\)/);
    expect(rule(".ccc-list-meta")).toMatch(/font-size:\s*var\(--ccc-text-label\)/);
  });
});
