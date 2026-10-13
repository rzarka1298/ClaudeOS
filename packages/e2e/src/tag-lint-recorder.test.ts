import { describe, expect, it } from "vitest";
import { itemNumberOf } from "./results.js";
import {
  expectedTitlesByItem,
  extractSpecTitles,
  findOnlyTests,
  groupTitles,
  LINT_CODES,
  lintTags,
} from "./tag-lint.js";
import { parseUatScript } from "./uat-tags.js";

/**
 * Wave 2 review MEDIUM-6. The result recorder sees only `it` titles (mocha's `test.title`), so
 * the lint must count exactly those and nothing else.
 */

const SCRIPT = [
  "---",
  "status: complete",
  "phase: 06-demo",
  "---",
  "",
  "## Tests",
  "",
  "### 5. Deny",
  "run: auto",
  "via: dom",
  "spec: packages/e2e/specs/x.e2e.ts::[06-UAT#05]",
  "expected: |",
  "  Deny works.",
  "result: [pending]",
  "",
].join("\n");

function lint(source: string) {
  const items = parseUatScript(SCRIPT).items;
  const titles = extractSpecTitles("packages/e2e/specs/x.e2e.ts", source, "06");
  // The spec file exists even when it holds no tagged `it` title.
  const specTitles = new Map<string, readonly string[]>([
    ["packages/e2e/specs/x.e2e.ts", []],
    ...groupTitles(titles),
  ]);
  return lintTags({ items, specTitles, phasePrefix: "06" });
}

describe("tag-lint counts the titles the recorder sees (MEDIUM-6)", () => {
  it("a describe-only prefix does not satisfy the item: TAGGED_NO_TEST", () => {
    const found = lint(
      ['describe("[06-UAT#05] deny", () => {', '  it("deny works", () => {});', "});"].join("\n"),
    );
    expect(found.map((entry) => entry.code)).toContain(LINT_CODES.taggedNoTest);
  });

  it("the prefix on both describe and it is not a duplicate", () => {
    const found = lint(
      [
        'describe("[06-UAT#05] deny", () => {',
        '  it("[06-UAT#05] deny works", () => {});',
        "});",
      ].join("\n"),
    );
    expect(found.map((entry) => entry.code)).not.toContain(LINT_CODES.duplicateTitle);
    expect(found).toEqual([]);
  });

  it("extractSpecTitles keeps it/test calls (with skip and only) and drops describe", () => {
    const titles = extractSpecTitles(
      "f",
      [
        'describe("[06-UAT#05] group", () => {',
        '  it("[06-UAT#05] a", () => {});',
        "  it.skip('[06-UAT#05] b', () => {});",
        '  test.only("[06-UAT#05] c", () => {});',
        "});",
      ].join("\n"),
      "06",
    );
    expect(titles.map((entry) => entry.title)).toEqual([
      "[06-UAT#05] a",
      "[06-UAT#05] b",
      "[06-UAT#05] c",
    ]);
  });

  it("every extracted title resolves to an item the way the recorder resolves it", () => {
    const titles = extractSpecTitles("f", 'it("[06-UAT#05] a", () => {});', "06");
    expect(titles.map((entry) => itemNumberOf(entry.title, "06"))).toEqual([5]);
  });

  it("flags an .only test as its own finding", () => {
    const titles = extractSpecTitles(
      "packages/e2e/specs/x.e2e.ts",
      'it.only("[06-UAT#05] a", () => {});\nit("[06-UAT#06] b", () => {});',
      "06",
    );
    const found = findOnlyTests(titles);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ code: LINT_CODES.onlyTest, item: 5 });
  });

  it("expectedTitlesByItem groups the it/test titles per item for the results resolver", () => {
    const titles = extractSpecTitles(
      "f",
      [
        'describe("[06-UAT#05] g", () => {',
        '  it("[06-UAT#05] a", () => {});',
        '  it("[06-UAT#05] b", () => {});',
        "});",
        'it("[06-UAT#06] c", () => {});',
      ].join("\n"),
      "06",
    );
    const grouped = expectedTitlesByItem(titles, "06");
    expect(grouped.get(5)).toEqual(["[06-UAT#05] a", "[06-UAT#05] b"]);
    expect(grouped.get(6)).toEqual(["[06-UAT#06] c"]);
  });
});
