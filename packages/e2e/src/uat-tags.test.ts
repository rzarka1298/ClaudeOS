import { beforeAll, describe, expect, it } from "vitest";
import {
  type ParsedScript,
  parseSpecValue,
  parseUatScript,
  phasePrefixOf,
  TAG_CODES,
  validateTags,
} from "./uat-tags.js";

const SCRIPT = `---
status: testing
phase: 06-demo-phase
updated: 2026-10-10T05:30:00Z
---

## Current Test

number: 1

# Demo UAT

Agents never mark a result in this file (D-46).

## Tests

### 1. Banner look
tags: U-1
run: auto+look
via: spy, shot
spec: packages/e2e/specs/notification-look.e2e.ts::[06-UAT#01]
expected: |
  run: owner
  auto-result: pass @ deadbeef 2026-10-10
  A line inside the block that looks like a tag.
result: [pending]

### 2. Click the banner
tags: U-2, U-3
run: owner
owner-why: banner-click
auto-part: the retained handler opens Approvals
expected: |
  Click the banner.
result: [pending]

### 3. Deny
run: auto
via: dom, store
spec: packages/e2e/specs/approvals-core.e2e.ts::[06-UAT#03]
auto-result: pass @ 0a1b2c3d 2026-10-11
expected: |
  Deny the request.
result: [pending]

### 4. No run line
expected: |
  Something only a person can judge.
result: [pending]

## Summary

total: 4
passed: 0
issues: 0
pending: 4
skipped: 0
blocked: 0

## Gaps

none
`;

describe("parseUatScript (Test 1)", () => {
  let parsed!: ParsedScript;
  beforeAll(() => {
    parsed = parseUatScript(SCRIPT);
  });

  it("finds four items and classifies them", () => {
    expect(parsed.items.map((item) => item.number)).toEqual([1, 2, 3, 4]);
    expect(parsed.items.map((item) => item.runClass)).toEqual([
      "auto+look",
      "owner",
      "auto",
      "owner",
    ]);
    expect(parsed.items.map((item) => item.runDeclared)).toEqual([true, true, true, false]);
    expect(parsed.items[0]?.title).toBe("Banner look");
  });

  it("reads via, spec, owner-why, auto-part and auto-result", () => {
    const [look, owner, auto] = parsed.items;
    expect(look?.via).toEqual(["spy", "shot"]);
    expect(look?.spec).toBe("packages/e2e/specs/notification-look.e2e.ts::[06-UAT#01]");
    expect(owner?.ownerWhy).toBe("banner-click");
    expect(owner?.autoPart).toBe("the retained handler opens Approvals");
    expect(auto?.autoResult).toBe("pass @ 0a1b2c3d 2026-10-11");
  });

  it("does not read a tag-looking line inside the indented expected block", () => {
    const look = parsed.items[0];
    expect(look?.runClass).toBe("auto+look");
    expect(look?.autoResult).toBeNull();
    expect(parsed.findings).toEqual([]);
  });

  it("keeps the existing trace tags line apart", () => {
    expect(parsed.items[0]?.legacyTags).toEqual(["U-1"]);
    expect(parsed.items[1]?.legacyTags).toEqual(["U-2", "U-3"]);
    expect(parsed.items[2]?.legacyTags).toEqual([]);
  });

  it("counts column-zero result lines per item", () => {
    expect(parsed.items.map((item) => item.resultLines)).toEqual([1, 1, 1, 1]);
  });

  it("parses the front matter and the summary block with their line indexes", () => {
    expect(parsed.frontMatter.phase).toBe("06-demo-phase");
    expect(parsed.frontMatter.status).toBe("testing");
    expect(parsed.summary.total).toBe("4");
    expect(parsed.summary.pending).toBe("4");
    const lines = SCRIPT.split("\n");
    expect(lines[parsed.summaryLines.pending as number]).toBe("pending: 4");
    expect(phasePrefixOf(parsed.frontMatter)).toBe("06");
  });

  it("records the line index of each tag line", () => {
    const lines = SCRIPT.split("\n");
    const auto = parsed.items[2];
    expect(lines[auto?.tagLines.spec as number]).toMatch(/^spec: /);
    expect(lines[auto?.tagLines["auto-result"] as number]).toMatch(/^auto-result: /);
    expect(lines[auto?.headingLine as number]).toBe("### 3. Deny");
  });
});

describe("validateTags (Test 2)", () => {
  function itemsFor(body: string) {
    return parseUatScript(`---\nphase: 06-x\n---\n\n### 5. Probe\n${body}\nresult: [pending]\n`);
  }

  it("accepts every valid value", () => {
    const parsed = itemsFor(
      [
        "run: auto",
        "via: dom, spy, store, fs, log, proc, shot",
        "spec: packages/e2e/specs/approvals-core.e2e.ts::[06-UAT#05]",
        "auto-result: inconclusive (look pending) @ 0a1b2c3d 2026-10-11",
      ].join("\n"),
    );
    expect(parsed.findings).toEqual([]);
  });

  it("reports a bad run value with the item number", () => {
    const { findings } = itemsFor("run: maybe");
    expect(findings).toEqual([
      { code: TAG_CODES.runInvalid, item: 5, message: expect.any(String) },
    ]);
  });

  it("reports a via token outside the enumeration", () => {
    const { findings } = itemsFor("run: auto\nvia: dom, telepathy");
    expect(findings.map((finding) => finding.code)).toEqual([TAG_CODES.viaInvalid]);
  });

  it("reports an owner-why outside the enumeration", () => {
    const { findings } = itemsFor("run: owner\nowner-why: whim");
    expect(findings.map((finding) => finding.code)).toEqual([TAG_CODES.ownerWhyInvalid]);
  });

  it("reports a spec that does not follow the file::[phase-UAT#NN] form", () => {
    for (const bad of [
      "packages/e2e/specs/x.e2e.ts::deny",
      "packages/e2e/specs/x.e2e.ts::[06-UAT#5]",
      "specs/x.e2e.ts::[06-UAT#05]",
      "packages/e2e/specs/x.ts::[06-UAT#05]",
      "packages/e2e/specs/../x.e2e.ts::[06-UAT#05]",
    ]) {
      const { findings } = itemsFor(`run: auto\nspec: ${bad}`);
      expect(
        findings.map((finding) => finding.code),
        bad,
      ).toEqual([TAG_CODES.specInvalid]);
    }
  });

  it("reports an auto-result outside the grammar", () => {
    for (const bad of [
      "pass",
      "ok @ 0a1b2c3d 2026-10-11",
      "pass @ 0a1b2c3 2026-10-11",
      "pass @ 0A1B2C3D 2026-10-11",
      "pass @ 0a1b2c3d 2026-10-1",
      "pass@0a1b2c3d 2026-10-11",
    ]) {
      const { findings } = itemsFor(`run: auto\nauto-result: ${bad}`);
      expect(
        findings.map((finding) => finding.code),
        bad,
      ).toEqual([TAG_CODES.autoResultInvalid]);
    }
  });

  it("rejects the word pending in any case or brackets, except inside the look-pending state", () => {
    for (const bad of ["pending", "[pending]", "Pending @ 0a1b2c3d 2026-10-11", "pass [pending]"]) {
      const { findings } = itemsFor(`run: auto\nauto-result: ${bad}`);
      const codes = findings.map((finding) => finding.code);
      expect(codes, bad).toContain(TAG_CODES.autoResultPending);
      expect(codes, bad).toContain(TAG_CODES.autoResultInvalid);
    }
  });

  it("flags a tag given twice", () => {
    const { findings } = itemsFor("run: auto\nrun: owner");
    expect(findings.map((finding) => finding.code)).toEqual([TAG_CODES.tagDuplicate]);
  });

  it("validateTags returns the same findings the parser attaches", () => {
    const parsed = itemsFor("run: nope");
    expect(validateTags(parsed.items)).toEqual(parsed.findings);
  });

  it("parseSpecValue splits a valid value and refuses an invalid one", () => {
    expect(parseSpecValue("packages/e2e/specs/a-b.e2e.ts::[06-UAT#12]")).toEqual({
      file: "packages/e2e/specs/a-b.e2e.ts",
      prefix: "[06-UAT#12]",
    });
    expect(parseSpecValue("nonsense")).toBeNull();
  });

  it("phasePrefixOf returns null when the phase is missing or not numbered", () => {
    expect(phasePrefixOf({})).toBeNull();
    expect(phasePrefixOf({ phase: "demo" })).toBeNull();
    expect(phasePrefixOf({ phase: "05.2-automated" })).toBe("05.2");
  });
});
