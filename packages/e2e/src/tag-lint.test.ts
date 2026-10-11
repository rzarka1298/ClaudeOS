import { describe, expect, it } from "vitest";
import { LINT_CODES, lintTags } from "./tag-lint.js";
import { parseUatScript } from "./uat-tags.js";

const LOOK_SPEC = "packages/e2e/specs/notification-look.e2e.ts";
const CORE_SPEC = "packages/e2e/specs/approvals-core.e2e.ts";

function script(blocks: string[]): string {
  const items = blocks.map(
    (block, index) => `### ${index + 1}. Item ${index + 1}\n${block}\nresult: [pending]\n`,
  );
  return `---\nphase: 06-demo\n---\n\n## Tests\n\n${items.join("\n")}`;
}

const GOOD_BLOCKS = [
  `run: auto+look\nvia: spy, shot\nspec: ${LOOK_SPEC}::[06-UAT#01]`,
  "run: owner\nowner-why: banner-click\nauto-part: the handler opens Approvals",
  `run: auto\nvia: dom\nspec: ${CORE_SPEC}::[06-UAT#03]`,
];

function titles(entries: Record<string, string[]>): Map<string, string[]> {
  return new Map(Object.entries(entries));
}

const GOOD_TITLES = {
  [LOOK_SPEC]: ["[06-UAT#01] banner appears"],
  [CORE_SPEC]: ["[06-UAT#02] handler opens approvals", "[06-UAT#03] deny"],
};

function lint(blocks: string[], map: Record<string, string[]> = GOOD_TITLES) {
  return lintTags({
    items: parseUatScript(script(blocks)).items,
    specTitles: titles(map),
    phasePrefix: "06",
  });
}

function codes(findings: ReadonlyArray<{ code: string }>): string[] {
  return findings.map((finding) => finding.code);
}

describe("lintTags (Test 3)", () => {
  it("returns an empty list for a fully consistent fixture", () => {
    expect(lint(GOOD_BLOCKS)).toEqual([]);
  });

  it("flags an auto item with no via", () => {
    const blocks = [...GOOD_BLOCKS];
    blocks[2] = `run: auto\nspec: ${CORE_SPEC}::[06-UAT#03]`;
    expect(lint(blocks)).toEqual([
      { code: LINT_CODES.autoNoVia, item: 3, message: expect.any(String) },
    ]);
  });

  it("flags an auto+look item with no spec", () => {
    const blocks = [...GOOD_BLOCKS];
    blocks[0] = "run: auto+look\nvia: spy, shot";
    expect(codes(lint(blocks))).toContain(LINT_CODES.autoNoSpec);
  });

  it("flags a spec file that is not in the map", () => {
    const found = lint(GOOD_BLOCKS, { [CORE_SPEC]: GOOD_TITLES[CORE_SPEC] ?? [] });
    expect(found).toEqual([
      {
        code: LINT_CODES.specFileMissing,
        item: 1,
        message: expect.stringContaining("notification-look"),
      },
    ]);
  });

  it("flags a tagged item with no matching test title", () => {
    const found = lint(GOOD_BLOCKS, {
      [LOOK_SPEC]: ["[06-UAT#01] banner appears"],
      [CORE_SPEC]: ["[06-UAT#02] handler opens approvals"],
    });
    expect(found).toEqual([
      { code: LINT_CODES.taggedNoTest, item: 3, message: expect.any(String) },
    ]);
  });

  it("flags a test title with no item", () => {
    const found = lint(GOOD_BLOCKS, {
      ...GOOD_TITLES,
      [CORE_SPEC]: [...(GOOD_TITLES[CORE_SPEC] ?? []), "[06-UAT#09] ghost"],
    });
    expect(found).toEqual([{ code: LINT_CODES.testNoItem, item: 9, message: expect.any(String) }]);
  });

  it("flags a test for an owner item that has no auto-part line", () => {
    const blocks = [...GOOD_BLOCKS];
    blocks[1] = "run: owner\nowner-why: banner-click";
    expect(lint(blocks)).toEqual([
      { code: LINT_CODES.ownerTestNoAutoPart, item: 2, message: expect.any(String) },
    ]);
  });

  it("flags the same prefix twice, in two files or in one", () => {
    const twoFiles = lint(GOOD_BLOCKS, {
      [LOOK_SPEC]: ["[06-UAT#01] banner appears", "[06-UAT#03] copy"],
      [CORE_SPEC]: GOOD_TITLES[CORE_SPEC] ?? [],
    });
    expect(codes(twoFiles)).toEqual([LINT_CODES.duplicateTitle]);
    const oneFile = lint(GOOD_BLOCKS, {
      [LOOK_SPEC]: GOOD_TITLES[LOOK_SPEC] ?? [],
      [CORE_SPEC]: [...(GOOD_TITLES[CORE_SPEC] ?? []), "[06-UAT#03] deny again"],
    });
    expect(codes(oneFile)).toEqual([LINT_CODES.duplicateTitle]);
    expect(oneFile[0]?.item).toBe(3);
  });

  it("flags an owner item with no owner-why", () => {
    const blocks = [...GOOD_BLOCKS];
    blocks[1] = "run: owner\nauto-part: the handler opens Approvals";
    expect(codes(lint(blocks))).toEqual([LINT_CODES.ownerNoWhy]);
  });

  it("treats a missing run line as owner and flags a missing owner-why", () => {
    const blocks = [...GOOD_BLOCKS, "expected: |\n  judged by a person"];
    expect(lint(blocks)).toEqual([
      { code: LINT_CODES.ownerNoWhy, item: 4, message: expect.any(String) },
    ]);
  });

  it("flags an auto-result written on an owner item", () => {
    const blocks = [...GOOD_BLOCKS];
    blocks[1] = `${blocks[1]}\nauto-result: pass @ 0a1b2c3d 2026-10-11`;
    expect(lint(blocks)).toEqual([
      { code: LINT_CODES.ownerAutoResult, item: 2, message: expect.any(String) },
    ]);
  });

  it("flags a spec tag whose bracket prefix names another item", () => {
    const blocks = [...GOOD_BLOCKS];
    blocks[2] = `run: auto\nvia: dom\nspec: ${CORE_SPEC}::[06-UAT#02]`;
    expect(codes(lint(blocks))).toContain(LINT_CODES.specPrefixMismatch);
  });

  it("never carries script text or note content in a finding", () => {
    const blocks = [...GOOD_BLOCKS];
    blocks[1] = "run: owner\nauto-part: SECRET-NOTE-TEXT\nauto-result: pass @ 0a1b2c3d 2026-10-11";
    const found = lint(blocks);
    expect(JSON.stringify(found)).not.toContain("SECRET-NOTE-TEXT");
  });
});
