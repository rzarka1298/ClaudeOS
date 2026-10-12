import { describe, expect, it } from "vitest";
import { UAT_ITEM_PLAN, UAT_PHASE_PREFIX } from "./spec-map.js";
import {
  checkMapAgainstScript,
  extractSpecTitles,
  groupTitles,
  LINT_CODES,
  lintTags,
  type MapCheckItem,
} from "./tag-lint.js";
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

describe("extractSpecTitles (Task 3, Test 5)", () => {
  const SOURCE = [
    'describe("[06-UAT#05] reload twice", () => {',
    '  it("[06-UAT#05] one navigation", async () => {});',
    "  it.skip('[06-UAT#06] chips', () => {});",
    "  it.only(`[06-UAT#07] deny`, () => {});",
    '  test("[06-UAT#08] approve", () => {});',
    '  describe.skip("[06-UAT#09] expiry", () => {});',
    '  // it("[06-UAT#10] commented out", () => {});',
    '  /* it("[06-UAT#11] block commented", () => {}); */',
    '  it("see [06-UAT#12] mid-text", () => {});',
    '  it("[07-UAT#13] other phase", () => {});',
    '  const label = "[06-UAT#14] not a test call";',
    "});",
  ].join("\n");

  it("finds titles in it and test calls with skip and only variants, not describe", () => {
    const found = extractSpecTitles("packages/e2e/specs/x.e2e.ts", SOURCE, "06");
    expect(found.map((entry) => entry.title)).toEqual([
      "[06-UAT#05] one navigation",
      "[06-UAT#06] chips",
      "[06-UAT#07] deny",
      "[06-UAT#08] approve",
    ]);
  });

  it("returns each title with its file name", () => {
    const found = extractSpecTitles("packages/e2e/specs/x.e2e.ts", SOURCE, "06");
    expect(found.every((entry) => entry.file === "packages/e2e/specs/x.e2e.ts")).toBe(true);
  });

  it("ignores commented lines and strings that merely contain the prefix mid-text", () => {
    const text = extractSpecTitles("f", SOURCE, "06")
      .map((entry) => entry.title)
      .join("\n");
    for (const ignored of ["#10", "#11", "#12", "#13", "#14"]) expect(text).not.toContain(ignored);
  });

  it("handles an escaped quote inside a title", () => {
    const found = extractSpecTitles("f", "it('[06-UAT#05] it\\'s fine', () => {});", "06");
    expect(found).toHaveLength(1);
  });

  it("groups titles by file for lintTags", () => {
    const grouped = groupTitles([
      { file: "a", title: "[06-UAT#01] x" },
      { file: "b", title: "[06-UAT#02] y" },
      { file: "a", title: "[06-UAT#03] z" },
    ]);
    expect(Object.fromEntries(grouped)).toEqual({
      a: ["[06-UAT#01] x", "[06-UAT#03] z"],
      b: ["[06-UAT#02] y"],
    });
  });
});

function scriptFromPlan(): string {
  const blocks = UAT_ITEM_PLAN.map((plan) => {
    const nn = String(plan.number).padStart(2, "0");
    const lines = [`### ${plan.number}. Item ${plan.number}`, `run: ${plan.runClass}`];
    if (plan.via.length > 0) lines.push(`via: ${plan.via.join(", ")}`);
    if (plan.specFile !== null)
      lines.push(`spec: ${plan.specFile}::[${UAT_PHASE_PREFIX}-UAT#${nn}]`);
    if (plan.ownerWhy !== null) lines.push(`owner-why: ${plan.ownerWhy}`);
    if (plan.autoPart !== null) lines.push(`auto-part: ${plan.autoPart}`);
    lines.push("result: [pending]", "");
    return lines.join("\n");
  });
  return `---\nphase: 06-demo\n---\n\n## Tests\n\n${blocks.join("\n")}`;
}

describe("checkMapAgainstScript (Task 3, Test 6)", () => {
  it("returns nothing for a script built from the map", () => {
    const parsed = parseUatScript(scriptFromPlan());
    expect(parsed.items).toHaveLength(26);
    expect(parsed.findings).toEqual([]);
    expect(checkMapAgainstScript(parsed.items, UAT_ITEM_PLAN)).toEqual([]);
  });

  function mutated(edit: (text: string) => string) {
    return checkMapAgainstScript(parseUatScript(edit(scriptFromPlan())).items, UAT_ITEM_PLAN);
  }

  it("reports an item whose class differs", () => {
    const found = mutated((text) =>
      text.replace("### 6. Item 6\nrun: auto", "### 6. Item 6\nrun: owner"),
    );
    expect(found).toEqual([
      { code: "MAP_MISMATCH", item: 6, message: expect.stringContaining("run") },
    ]);
  });

  it("reports an item whose via differs", () => {
    const found = mutated((text) => text.replace("via: dom, spy\n", "via: dom\n"));
    expect(found.map((finding) => finding.item)).toEqual([5]);
    expect(found[0]?.message).toContain("via");
  });

  it("reports an owner-why that differs", () => {
    const found = mutated((text) => text.replace("owner-why: focus", "owner-why: space"));
    expect(found).toEqual([
      { code: "MAP_MISMATCH", item: 3, message: expect.stringContaining("owner-why") },
    ]);
  });

  it("reports a spec file that differs", () => {
    const found = mutated((text) =>
      text.replace(
        "packages/e2e/specs/approvals-expiry.e2e.ts::[06-UAT#09]",
        "packages/e2e/specs/approvals-core.e2e.ts::[06-UAT#09]",
      ),
    );
    expect(found.map((finding) => finding.item)).toEqual([9]);
    expect(found[0]?.message).toContain("spec");
  });

  it("reports an auto-part that is present or absent against the table", () => {
    const missing = mutated((text) => text.replace(/^auto-part: .*\n/m, ""));
    expect(missing.map((finding) => finding.item)).toEqual([2]);
    const extra = mutated((text) =>
      text.replace("### 26. Item 26\nrun: owner", "### 26. Item 26\nrun: owner\nauto-part: x"),
    );
    expect(extra.map((finding) => finding.item)).toEqual([26]);
  });

  it("reports the full-profile flag when the item carries one", () => {
    const base = parseUatScript(scriptFromPlan()).items;
    const items: MapCheckItem[] = base.map((item) => ({
      ...item,
      fullProfileOnly: item.number === 21 ? false : item.number === 6,
    }));
    const found = checkMapAgainstScript(items, UAT_ITEM_PLAN);
    expect(found.map((finding) => finding.item).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      6, 21,
    ]);
  });

  it("reports an item missing from the script and one the table does not know", () => {
    const base = parseUatScript(scriptFromPlan()).items;
    const withoutLast = checkMapAgainstScript(base.slice(0, 25), UAT_ITEM_PLAN);
    expect(withoutLast).toEqual([
      { code: "MAP_ITEM_MISSING", item: 26, message: expect.any(String) },
    ]);
    const first = base[0] as MapCheckItem;
    const extra = checkMapAgainstScript([...base, { ...first, number: 27 }], UAT_ITEM_PLAN);
    expect(extra).toEqual([{ code: "MAP_ITEM_UNKNOWN", item: 27, message: expect.any(String) }]);
  });
});
