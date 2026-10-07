import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Wave-5 audit (06-19): the detail pane's visual contracts that jsdom cannot
 * compute are pinned in the stylesheet: Unsaved changes in weight 600, the
 * Provided by block dashed, the source link and the ids in monospace.
 */
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "styles.css"), "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.[\]"=]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  expect(match, `rule ${selector}`).not.toBeNull();
  return match?.[1] ?? "";
}

describe("task detail pane style contracts", () => {
  it("renders Unsaved changes in weight 600", () => {
    expect(rule(".ccc-task-dirty")).toMatch(/font-weight:\s*var\(--ccc-weight-strong\)/);
    expect(css).toMatch(/--ccc-weight-strong:\s*600\s*;/);
  });

  it("draws the Provided by block with a dashed border", () => {
    expect(rule('.ccc-task-block[data-origin="requester"]')).toMatch(/border:[^;]*\bdashed\b/);
  });

  it("sets the monospace class used by the source link, task id and note path", () => {
    expect(rule(".ccc-text-input--mono")).toMatch(/font-family:\s*var\(--ccc-font-mono\)/);
  });
});
