import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isSettingsSectionId,
  requestSettingsSection,
  SETTINGS_SECTION_LABELS,
  SETTINGS_SECTIONS,
  type SettingsSectionId,
  settingsSectionRequested,
  takeSettingsSectionRequest,
} from "./settings-sections.js";

/**
 * Plan 08-02 Task 3 (D-15, UI-SPEC S1): the nine Settings section ids in their fixed order with
 * the locked labels, and the one-shot deep-link signal that setup actions and the native tab's
 * pointer use to say "go to section X". No consumer exists yet (08-11 adds it).
 */

beforeEach(() => {
  takeSettingsSectionRequest();
});

afterEach(() => {
  takeSettingsSectionRequest();
});

describe("the section ids and labels (Test 1)", () => {
  it("lists the nine ids in the fixed order", () => {
    expect([...SETTINGS_SECTIONS]).toEqual([
      "projects",
      "launchers",
      "integrations",
      "approvals-tasks",
      "paths",
      "visual",
      "security",
      "schedules",
      "diagnostics",
    ]);
  });

  it("maps each id to its locked label, with nothing extra", () => {
    expect(SETTINGS_SECTION_LABELS).toEqual({
      projects: "Projects",
      launchers: "Launchers",
      integrations: "Integrations",
      "approvals-tasks": "Approvals and tasks",
      paths: "Paths",
      visual: "Visual",
      security: "Security",
      schedules: "Schedules",
      diagnostics: "Diagnostics",
    });
    expect(Object.keys(SETTINGS_SECTION_LABELS)).toEqual([...SETTINGS_SECTIONS]);
  });

  it("accepts the nine ids and refuses everything else", () => {
    for (const id of [
      "projects",
      "launchers",
      "integrations",
      "approvals-tasks",
      "paths",
      "visual",
      "security",
      "schedules",
      "diagnostics",
    ]) {
      expect(isSettingsSectionId(id), id).toBe(true);
    }
    for (const bad of [
      "",
      "Projects",
      "approvals",
      "tasks",
      "constructor",
      "__proto__",
      "toString",
      " diagnostics",
      null,
      undefined,
      0,
      {},
      ["diagnostics"],
    ]) {
      expect(isSettingsSectionId(bad), typeof bad).toBe(false);
    }
  });
});

describe("the one-shot deep-link signal (Test 2)", () => {
  it("starts empty, is set by a request, and is read and cleared exactly once", () => {
    expect(settingsSectionRequested.value).toBeNull();
    expect(takeSettingsSectionRequest()).toBeNull();

    requestSettingsSection("diagnostics");
    expect(settingsSectionRequested.value).toBe("diagnostics");

    expect(takeSettingsSectionRequest()).toBe("diagnostics");
    expect(settingsSectionRequested.value).toBeNull();
    expect(takeSettingsSectionRequest()).toBeNull();
  });

  it("keeps only the latest request when two arrive before one is taken", () => {
    requestSettingsSection("security");
    requestSettingsSection("launchers");
    expect(takeSettingsSectionRequest()).toBe("launchers");
    expect(takeSettingsSectionRequest()).toBeNull();
  });
});

describe("an unknown id is ignored (Test 3)", () => {
  it("leaves the signal unchanged, empty or pending", () => {
    requestSettingsSection("nope" as unknown as SettingsSectionId);
    expect(settingsSectionRequested.value).toBeNull();

    requestSettingsSection("paths");
    for (const bad of ["", "__proto__", "Paths", null, 7] as unknown[]) {
      requestSettingsSection(bad as SettingsSectionId);
      expect(settingsSectionRequested.value).toBe("paths");
    }
    expect(takeSettingsSectionRequest()).toBe("paths");
  });
});

describe("the pending request cannot be written from outside (B-MINOR 8)", () => {
  it("refuses a direct write, valid or not, and keeps the pending value", () => {
    const writable = settingsSectionRequested as unknown as { value: unknown };
    expect(() => {
      writable.value = "not-a-section";
    }).toThrow();
    expect(() => {
      writable.value = "paths";
    }).toThrow();
    expect(settingsSectionRequested.value).toBeNull();
    requestSettingsSection("security");
    expect(() => {
      writable.value = "__proto__";
    }).toThrow();
    expect(settingsSectionRequested.value).toBe("security");
    expect(takeSettingsSectionRequest()).toBe("security");
  });

  it("is still readable and subscribable as a signal", () => {
    expect(settingsSectionRequested.peek()).toBeNull();
    requestSettingsSection("visual");
    expect(settingsSectionRequested.peek()).toBe("visual");
  });
});
