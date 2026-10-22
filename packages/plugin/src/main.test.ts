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

  it("builds the tasks client from the authenticated connection and calls wireTasks once", () => {
    expect(source).toMatch(/createTasksClient\(this\.client\)/);
    expect(source.match(/wireTasks\(/g)).toHaveLength(1);
  });

  it("builds the research client from the authenticated connection and calls wireResearch once (plan 07-15)", () => {
    expect(source).toMatch(/createResearchClient\(this\.client\)/);
    expect(source.match(/wireResearch\(/g)).toHaveLength(1);
    // The open-note port finds the file by its exact vault-relative path; it never parses link text.
    expect(source).toMatch(/getFileByPath\(path\)/);
    expect(source).not.toMatch(/openLinkText\([^)]*research/i);
  });

  it("registers nothing directly on the plugin", () => {
    expect(source).not.toMatch(
      /this\.(registerView|addRibbonIcon|addCommand|registerEvent|registerInterval|registerObsidianProtocolHandler)\(/,
    );
  });

  it("hands the combined connect hook to the view and the switcher", () => {
    expect(source).toMatch(/combineOnLive\(/);
  });

  it("subscribes to the service events at load after layout-ready, with the combined hook", () => {
    expect(source).toMatch(/startServiceEventsOnLayoutReady\(/);
    expect(source).toMatch(/onLive: this\.onServiceLive/);
    expect(source).toMatch(/onLayoutReady\(cb\)/);
  });
});

describe("main.ts has one write path to plugin data (plan 08-11, D-16)", () => {
  // The SettingsHost wiring itself (one object for the native tab and the view, exactly four
  // keys saved) is proven by running the real onload in main.runtime.test.tsx. What a runtime
  // test cannot see is a SECOND write path added elsewhere, so that stays a source scan.
  it("persists no display string: the only saveData path is the guarded saveSettings", () => {
    expect(source.match(/this\.saveData\(/g)).toHaveLength(1);
    expect(source).toMatch(/assertNoPrivatePathValues\(this\.settings\)/);
  });
});
