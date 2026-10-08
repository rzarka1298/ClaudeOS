import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * main.ts needs the Obsidian runtime, so its wiring is proven by a source scan
 * (the real functions are exercised by lifecycle.test.ts and the wiring tests).
 */
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "main.ts"), "utf8");

describe("main.ts wires the Phase 6 modules once, through the registry (plan 06-23)", () => {
  it("builds the approvals client from the authenticated connection and calls wireApprovals", () => {
    expect(source).toMatch(/createApprovalsClient\(this\.client\)/);
    expect(source.match(/wireApprovals\(/g)).toHaveLength(1);
    expect(source).toMatch(/configureNotify\(/);
  });

  it("registers nothing directly on the plugin", () => {
    expect(source).not.toMatch(/this\.(registerView|addRibbonIcon|addCommand|registerEvent|registerInterval|registerObsidianProtocolHandler)\(/);
  });

  it("hands the combined connect hook to the view and the switcher", () => {
    expect(source).toMatch(/combineOnLive\(/);
  });
});
