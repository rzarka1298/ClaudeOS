// scripts/check-boundaries.sh — the literal grep backstop (ADR-0019 layer 3).
// Only the fixture-tree exclusions are pinned here: the two fixture trees
// exist to violate the rules, so the backstop skips them, and that skip must
// match their REAL paths only. A substring match let any other path that
// merely contained `lint-fixtures/` escape the scan (judge-r1 finding 9).

import { afterEach, describe, expect, it } from "vitest";
import { type GateRepo, gateRepo } from "./gate-repo.js";

const SCRIPT = "scripts/check-boundaries.sh";

// Rule 7 (no inline style inside packages/plugin), assembled at runtime so
// this test file is not itself a backstop hit.
const INLINE_STYLE = `export function paint(el: HTMLElement): void {\n  el${"."}style${"."}color = "red";\n}\n`;

const repos: GateRepo[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.dispose();
});

/** Every repository also tracks one clean source file, so the scan is never empty. */
const CLEAN = { "packages/domain/src/index.ts": "export const answer = 42;\n" };

function backstop(files: Record<string, string>) {
  const repo = gateRepo([SCRIPT], { ...CLEAN, ...files });
  repos.push(repo);
  return repo.run(SCRIPT);
}

describe("check-boundaries.sh fixture exclusions (judge-r1 finding 9)", () => {
  it("skips the real plugin lint-fixtures tree", () => {
    const result = backstop({ "packages/plugin/lint-fixtures/inline-style.ts": INLINE_STYLE });
    expect(result.status).toBe(0);
  });

  it("skips the real boundary-violations tree", () => {
    const result = backstop({
      "packages/test-fixtures/boundary-violations/untrusted/inline-style.ts": `import "obsidian";\n${INLINE_STYLE}`,
    });
    expect(result.status).toBe(0);
  });

  it("still scans a plugin path that merely contains lint-fixtures/", () => {
    const result = backstop({
      "packages/plugin/src/not-lint-fixtures/inline-style.ts": INLINE_STYLE,
    });
    expect(result.status).toBe(1);
    expect(result.out).toContain("packages/plugin/src/not-lint-fixtures/inline-style.ts");
  });

  it("still scans a plugin path that merely contains boundary-violations/", () => {
    const result = backstop({
      "packages/plugin/src/boundary-violations/inline-style.ts": INLINE_STYLE,
    });
    expect(result.status).toBe(1);
    expect(result.out).toContain("packages/plugin/src/boundary-violations/inline-style.ts");
  });
});

// The one anchored carve-out from the token-forgery rule (D-02, T-06-01,
// judge-r1 finding 9): the engine's minter file may cast to CapabilityToken,
// no other path may. Forbidden literals are assembled at runtime so this file
// is not itself a backstop hit. Rules are named by their description text, never
// by number (M-4).
const MINTER_PATH = "packages/service/src/approval/mint/mint-token.ts";
const FORGERY_DESCRIPTION = "forges a CapabilityToken";
const TOKEN_CAST = `export const t = {} ${"as"} CapabilityToken<"x">;\n`;
const ANY_IN_MINTER = `import type { CapabilityToken } from "@ccc/domain";\nexport const loose: ${"an"}${"y"} = 1;\nexport type Kept = CapabilityToken<"x">;\n`;

describe("check-boundaries.sh minter carve-out (D-02, T-06-01)", () => {
  it("Case A, quiet: the cast in the single allowed minter path passes", () => {
    const result = backstop({ [MINTER_PATH]: TOKEN_CAST });
    expect(result.out).not.toContain(FORGERY_DESCRIPTION);
    expect(result.status).toBe(0);
  });

  it("Case B, fires: the same cast at another approval path fails and names it", () => {
    const result = backstop({ "packages/service/src/approval/other.ts": TOKEN_CAST });
    expect(result.status).toBe(1);
    expect(result.out).toContain(FORGERY_DESCRIPTION);
    expect(result.out).toContain("packages/service/src/approval/other.ts");
  });

  it("Case C, fires (anchored at the start): a path that merely ends with the minter path fails", () => {
    const path = "packages/service/src/not-approval/mint/mint-token.ts";
    const result = backstop({ [path]: TOKEN_CAST });
    expect(result.status).toBe(1);
    expect(result.out).toContain(FORGERY_DESCRIPTION);
    expect(result.out).toContain(path);
  });

  it("Case C2, fires (anchored at the start): a prefix-extended minter path fails", () => {
    const path = `packages/nested/${MINTER_PATH}`;
    const result = backstop({ [path]: TOKEN_CAST });
    expect(result.status).toBe(1);
    expect(result.out).toContain(path);
  });

  it("Case D, fires (anchored at the end): a path that merely starts with the minter path fails", () => {
    const path = `${MINTER_PATH}.bak.ts`;
    const result = backstop({ [path]: TOKEN_CAST });
    expect(result.status).toBe(1);
    expect(result.out).toContain(FORGERY_DESCRIPTION);
    expect(result.out).toContain(path);
  });

  it("Case D2, fires: a sibling of the minter in the same folder fails", () => {
    const path = "packages/service/src/approval/mint/mint-token-extra.ts";
    const result = backstop({ [path]: TOKEN_CAST });
    expect(result.status).toBe(1);
    expect(result.out).toContain(path);
  });

  it("Case E, fires: the any type in the minter file still fails the capability-file scan", () => {
    const result = backstop({ [MINTER_PATH]: ANY_IN_MINTER });
    expect(result.status).toBe(1);
    expect(result.out).toContain(FORGERY_DESCRIPTION);
    expect(result.out).toContain(MINTER_PATH);
  });

  it("Case F, quiet: the cast in a test file path still passes", () => {
    const result = backstop({ "packages/service/src/approval/forge.test.ts": TOKEN_CAST });
    expect(result.out).not.toContain(FORGERY_DESCRIPTION);
    expect(result.status).toBe(0);
  });

  it("the rule description names the single allowed minter path", () => {
    const result = backstop({ "packages/service/src/forge.ts": TOKEN_CAST });
    expect(result.out).toContain(MINTER_PATH);
  });
});
