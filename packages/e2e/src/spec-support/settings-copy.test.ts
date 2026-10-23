import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../repo-paths.js";
import {
  SETTINGS_ATTRS,
  SETTINGS_ATTRS_TABLE,
  SETTINGS_CLASSES,
  SETTINGS_CLASSES_TABLE,
  SETTINGS_SECTION_LABELS,
  SETTINGS_TEXT,
  SETTINGS_TEXT_TABLE,
} from "./settings-copy.js";
import { findCopyDrift } from "./tasks-copy.js";

/**
 * Copy-drift guard for the Settings specs (plan 08-22, T-05.2-37 carried forward): every string,
 * class name and attribute the Settings specs assert is mirrored in settings-copy.ts with the
 * plugin module that owns it, and these tests read those modules as text, so a reworded label
 * fails here and not in a live run.
 */

function realSource(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

describe("the mirrored Settings copy", () => {
  it("every mirrored string appears in the plugin module that owns it", () => {
    expect(Object.keys(SETTINGS_TEXT_TABLE).length).toBeGreaterThan(10);
    expect(findCopyDrift(SETTINGS_TEXT_TABLE, realSource)).toEqual([]);
  });

  it("every mirrored class name appears in the plugin module that owns it", () => {
    expect(Object.keys(SETTINGS_CLASSES_TABLE).length).toBeGreaterThan(8);
    expect(findCopyDrift(SETTINGS_CLASSES_TABLE, realSource)).toEqual([]);
  });

  it("every mirrored attribute name appears in the plugin module that owns it", () => {
    expect(findCopyDrift(SETTINGS_ATTRS_TABLE, realSource)).toEqual([]);
  });

  it("names owner files that exist", () => {
    for (const table of [SETTINGS_TEXT_TABLE, SETTINGS_CLASSES_TABLE, SETTINGS_ATTRS_TABLE]) {
      for (const [, owner] of Object.values(table)) {
        expect(existsSync(join(REPO_ROOT, owner)), owner).toBe(true);
      }
    }
  });

  it("lists the nine section labels in the plugin's fixed nav order", () => {
    expect(SETTINGS_SECTION_LABELS).toEqual([
      "Projects",
      "Launchers",
      "Integrations",
      "Approvals and tasks",
      "Paths",
      "Visual",
      "Security",
      "Schedules",
      "Diagnostics",
    ]);
  });

  it("takes the words the item texts quote from the plugin copy", () => {
    expect(SETTINGS_TEXT.settingsHeading).toBe("Settings");
    expect(SETTINGS_TEXT.navLabel).toBe("Settings sections");
    expect(SETTINGS_TEXT.settingsTabId).toBe("settings");
    expect(SETTINGS_TEXT.goToLaunchers).toBe("Go to the launchers section");
  });

  it("builds class names that start with the ccc prefix", () => {
    for (const [key, value] of Object.entries(SETTINGS_CLASSES)) {
      expect(value.startsWith("ccc-"), key).toBe(true);
    }
  });

  it("builds attribute names that are data- or aria- attributes", () => {
    for (const [key, value] of Object.entries(SETTINGS_ATTRS)) {
      expect(/^(data|aria)-/.test(value), key).toBe(true);
    }
  });

  it("control: the drift check does flag a string, a class and an attribute that no longer exist", () => {
    const stale = {
      text: [
        "A sentence nobody wrote.",
        "packages/plugin/src/view/settings-sections.ts",
        "literal",
      ],
      cls: ["ccc-gone-xyz", "packages/plugin/src/view/settings-destination.tsx", "fragment"],
      attr: ["data-gone-xyz", "packages/plugin/src/view/settings-destination.tsx", "fragment"],
    } as const;
    expect(findCopyDrift(stale, realSource)).toEqual(["text", "cls", "attr"]);
  });
});
