import { describe, expect, it } from "vitest";
import * as settingsHostModule from "./settings-host.js";

/**
 * FIX2B m6: the module used to export a shared `inertSettingsHost` instance nobody imported. The
 * preferences it carries are mutable, so a shared instance is a trap; only the factory remains.
 */
describe("settings-host exports", () => {
  it("exports the factory and no shared mutable instance", () => {
    expect(Object.keys(settingsHostModule)).toEqual(["createInertSettingsHost"]);
  });

  it("each inert host has its own preferences", () => {
    const first = settingsHostModule.createInertSettingsHost();
    const second = settingsHostModule.createInertSettingsHost();
    first.settings.notifyApprovals = false;
    expect(second.settings.notifyApprovals).toBe(true);
    expect(first.settings).not.toBe(second.settings);
  });
});
