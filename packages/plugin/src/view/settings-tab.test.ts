import { Notice } from "obsidian";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { motionMode } from "../motion.js";
import {
  applyReducedMotionChange,
  asMotionPreference,
  CommandCenterSettingTab,
  REDUCED_MOTION_KEY,
  REDUCED_MOTION_OPTIONS,
  REDUCED_MOTION_SAVE_FAILED,
  type SettingsTabHost,
} from "./settings-tab.js";

/**
 * The tab's DECISION, not its rendering. Obsidian's own builder draws the
 * control and the live-Obsidian UAT covers that; what a unit test can prove is
 * the ordering guarantee the E8 error row depends on — the root attribute is
 * only rewritten once the value is actually on disk.
 */

interface Recorded extends SettingsTabHost {
  readonly notices: string[];
  saveCalls: number;
}

function createHost(options: { failSave?: boolean } = {}): Recorded {
  const notices: string[] = [];
  const host: Recorded = {
    settings: { reducedMotion: "auto" },
    mql: { matches: false },
    notices,
    saveCalls: 0,
    saveSettings: async () => {
      host.saveCalls++;
      if (options.failSave) throw new Error("saveData: disk is full");
    },
    notify: (message: string) => {
      notices.push(message);
    },
  };
  return host;
}

beforeEach(() => {
  motionMode.value = "full";
});

afterEach(() => {
  motionMode.value = "full";
});

describe("applyReducedMotionChange", () => {
  it("persists first, then rewrites the resolved motion mode", async () => {
    const host = createHost();

    const outcome = await applyReducedMotionChange(host, "reduced");

    expect(outcome).toBe("saved");
    expect(host.saveCalls).toBe(1);
    expect(host.settings.reducedMotion).toBe("reduced");
    expect(motionMode.value).toBe("reduced");
    expect(host.notices).toEqual([]);
  });

  it("still defers to the OS when the owner selects System", async () => {
    const host = createHost();
    host.settings.reducedMotion = "reduced";
    motionMode.value = "reduced";

    // The OS says reduce, so System must resolve to reduced, not to full.
    const osReducing: Recorded = { ...host, mql: { matches: true } };
    await applyReducedMotionChange(osReducing, "auto");

    expect(osReducing.settings.reducedMotion).toBe("auto");
    expect(motionMode.value).toBe("reduced");
  });

  it("reverts the setting, warns, and leaves the motion mode alone when the save fails", async () => {
    const host = createHost({ failSave: true });

    const outcome = await applyReducedMotionChange(host, "reduced");

    expect(outcome).toBe("reverted");
    expect(host.settings.reducedMotion).toBe("auto");
    expect(motionMode.value).toBe("full");
    expect(host.notices).toEqual([REDUCED_MOTION_SAVE_FAILED]);
  });

  it("reaches Obsidian's own Notice when the host supplies no notifier", async () => {
    const host = createHost({ failSave: true });
    const bare: SettingsTabHost = {
      settings: host.settings,
      mql: host.mql,
      saveSettings: () => host.saveSettings(),
    };

    await expect(applyReducedMotionChange(bare, "reduced")).resolves.toBe("reverted");
    // Under Vitest `obsidian` resolves to the shared stub, whose Notice
    // records its message -- so the copy is assertable without a DOM. Typed
    // through the stub's own shape because the real `Notice` exposes only a
    // `messageEl`, which no test runner can render.
    const recorded = new Notice(REDUCED_MOTION_SAVE_FAILED) as unknown as { message: string };
    expect(recorded.message).toBe(REDUCED_MOTION_SAVE_FAILED);
  });
});

describe("asMotionPreference", () => {
  it.each([
    ["reduced", "reduced"],
    ["auto", "auto"],
    ["REDUCED", "auto"],
    ["", "auto"],
    [null, "auto"],
    [undefined, "auto"],
    [1, "auto"],
  ])("narrows %o to %s", (input, expected) => {
    expect(asMotionPreference(input)).toBe(expected);
  });
});

describe("CommandCenterSettingTab", () => {
  it("declares the reduced-motion dropdown with exactly the two documented labels", () => {
    const host = createHost();
    const tab = new CommandCenterSettingTab({} as never, {} as never, host);

    const [definition] = tab.getSettingDefinitions();

    expect(definition?.control.key).toBe(REDUCED_MOTION_KEY);
    expect(definition?.control.type).toBe("dropdown");
    expect(definition?.control.options).toEqual({ auto: "System", reduced: "Always reduced" });
    expect(REDUCED_MOTION_OPTIONS.auto).toBe("System");
    expect(REDUCED_MOTION_OPTIONS.reduced).toBe("Always reduced");
  });

  it("reads the control value straight off the live settings object", () => {
    const host = createHost();
    const tab = new CommandCenterSettingTab({} as never, {} as never, host);

    expect(tab.getControlValue(REDUCED_MOTION_KEY)).toBe("auto");
    host.settings.reducedMotion = "reduced";
    expect(tab.getControlValue(REDUCED_MOTION_KEY)).toBe("reduced");
  });

  it("routes a control change through the guarded save path", async () => {
    const host = createHost();
    const tab = new CommandCenterSettingTab({} as never, {} as never, host);

    await tab.setControlValue(REDUCED_MOTION_KEY, "reduced");

    expect(host.saveCalls).toBe(1);
    expect(host.settings.reducedMotion).toBe("reduced");
    expect(motionMode.value).toBe("reduced");
  });
});
