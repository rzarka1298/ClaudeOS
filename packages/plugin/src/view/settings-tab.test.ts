import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Notice } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { motionMode } from "../motion.js";
import { navigationRequest } from "./navigation-request.js";
import {
  asMotionPreference,
  CLAUDE_DELETE_USAGE_NAME,
  CLAUDE_HOOKS_NAME,
  CLAUDE_TRANSCRIPT_ANALYSIS_NAME,
  NOTIFY_APPROVALS_NAME,
  REBUILD_NAME,
  REDUCED_MOTION_KEY,
  REDUCED_MOTION_OPTIONS,
  REDUCED_MOTION_SAVE_FAILED,
  SEND_TEST_APPROVAL_NAME,
} from "./settings-model.js";
import { settingsSectionRequested, takeSettingsSectionRequest } from "./settings-sections.js";
import {
  applyReducedMotionChange,
  CommandCenterSettingTab,
  POINTER_ACTION_LABEL,
  POINTER_ALIASES,
  POINTER_DESC,
  POINTER_NAME,
  type SettingsTabHost,
} from "./settings-tab.js";

/**
 * The native Obsidian settings tab after plan 08-18 (D-18, OD-1, 08-UI-SPEC S5): exactly two items,
 * the Reduced motion dropdown and the `Command center settings` pointer row. Everything else the
 * tab used to hold lives in the command center's Settings destination, where its tests now are
 * (settings-integrations, settings-security, settings-approvals-tasks, settings-model and
 * codex-settings); the SUMMARY maps each removed case to its new home.
 *
 * The tab's DECISION, not its rendering: Obsidian's own builder draws the controls and the
 * live-Obsidian UAT covers that.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

interface Recorded extends SettingsTabHost {
  readonly notices: string[];
  readonly calls: string[];
  saveCalls: number;
}

function createHost(options: { failSave?: boolean } = {}): Recorded {
  const notices: string[] = [];
  const calls: string[] = [];
  const host: Recorded = {
    settings: { reducedMotion: "auto" },
    mql: { matches: false },
    notices,
    calls,
    saveCalls: 0,
    saveSettings: async () => {
      host.saveCalls++;
      if (options.failSave) throw new Error("saveData: disk is full");
    },
    notify: (message: string) => {
      notices.push(message);
    },
    revealView: () => {
      // What the tab had asked for by the time it revealed the view.
      calls.push(
        `reveal(section=${settingsSectionRequested.value ?? "none"},destination=${navigationRequest.value?.destination ?? "none"})`,
      );
    },
  };
  return host;
}

beforeEach(() => {
  motionMode.value = "full";
  takeSettingsSectionRequest();
  navigationRequest.value = null;
});

afterEach(() => {
  motionMode.value = "full";
  takeSettingsSectionRequest();
  navigationRequest.value = null;
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
      revealView: () => {},
    };

    await expect(applyReducedMotionChange(bare, "reduced")).resolves.toBe("reverted");
    // Under Vitest `obsidian` resolves to the shared stub, whose Notice records its message, so the
    // copy is assertable without a DOM. Typed through the stub's own shape because the real
    // `Notice` exposes only a `messageEl`, which no test runner can render.
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

describe("Task 3, Test 1: the tab holds exactly two items", () => {
  it("declares the Reduced motion dropdown first, with the two documented labels and the default auto", () => {
    const tab = new CommandCenterSettingTab({} as never, {} as never, createHost());
    const [definition] = tab.getSettingDefinitions();

    expect(definition?.name).toBe("Reduced motion");
    expect(definition?.control.key).toBe(REDUCED_MOTION_KEY);
    expect(definition?.control.key).toBe("reducedMotion");
    expect(definition?.control.type).toBe("dropdown");
    expect(definition?.control.defaultValue).toBe("auto");
    expect(definition?.control.options).toEqual({ auto: "System", reduced: "Always reduced" });
    expect(REDUCED_MOTION_OPTIONS.auto).toBe("System");
    expect(REDUCED_MOTION_OPTIONS.reduced).toBe("Always reduced");
  });

  it("returns exactly two items: no group, no third row", () => {
    const tab = new CommandCenterSettingTab({} as never, {} as never, createHost());
    const definitions = tab.getSettingDefinitions();
    expect(definitions).toHaveLength(2);
    expect(definitions.some((item) => "items" in item)).toBe(false);
  });

  it("the second item is the Command center settings pointer with the UI-SPEC description", () => {
    const tab = new CommandCenterSettingTab({} as never, {} as never, createHost());
    const pointer = tab.getSettingDefinitions()[1];
    expect(pointer?.name).toBe("Command center settings");
    expect(POINTER_NAME).toBe("Command center settings");
    expect(pointer?.desc).toBe(
      "Projects, launchers, integrations, approvals, security and diagnostics are in the Settings tab of the command center.",
    );
    expect(POINTER_DESC).toBe(pointer?.desc);
    expect(POINTER_ACTION_LABEL).toBe("Open settings");
    expect(typeof pointer?.action).toBe("function");
    expect((pointer as { control?: unknown } | undefined)?.control).toBeUndefined();
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

  it("a failed save puts the dropdown back on the persisted value", async () => {
    const host = createHost({ failSave: true });
    const tab = new CommandCenterSettingTab({} as never, {} as never, host);
    const update = vi.spyOn(tab, "update");

    await tab.setControlValue(REDUCED_MOTION_KEY, "reduced");

    expect(update).toHaveBeenCalledTimes(1);
    expect(tab.getControlValue(REDUCED_MOTION_KEY)).toBe("auto");
    expect(host.notices).toEqual([REDUCED_MOTION_SAVE_FAILED]);
  });
});

/**
 * Every name the old native tab (`git show 0a69e4dc:packages/plugin/src/view/settings-tab.ts` plus
 * `codex-settings.ts` `buildCodexGroup`) offered to Obsidian's settings search, other than Reduced
 * motion which stays on the tab. A fixed list on purpose: it is the contract with the owner's
 * muscle memory, so it must not be derived from the code under test (FIX4B m3).
 */
const OLD_TAB_SEARCHABLE_NAMES = [
  // Claude Code group
  "Claude Code hooks",
  "Copy install command",
  "Copy uninstall command",
  "Status-line wrapper",
  "Transcript analysis",
  "Delete cached usage analytics",
  // Approvals and tasks groups
  "Approval notifications",
  "Send a test approval",
  "Rebuild task index",
  // Codex group
  "Codex hooks",
  "Copy install step",
  "Copy uninstall step",
  "Antigravity terminal bridge",
  "Copy bridge install step",
  "Launcher",
  "Codex notify setting",
  // The Launcher row's own alias
  "Open launcher settings",
];

describe("Task 3, Test 2: the pointer row keeps every migrated setting findable", () => {
  it("carries an alias for each migrated setting name", () => {
    const tab = new CommandCenterSettingTab({} as never, {} as never, createHost());
    const aliases = tab.getSettingDefinitions()[1]?.aliases ?? [];
    for (const name of OLD_TAB_SEARCHABLE_NAMES) {
      expect(aliases, name).toContain(name);
    }
    expect(aliases).toEqual(POINTER_ALIASES);
  });

  it("builds its aliases from the one set of destination names, not a second copy", () => {
    expect(POINTER_ALIASES).toEqual(
      expect.arrayContaining([
        CLAUDE_TRANSCRIPT_ANALYSIS_NAME,
        CLAUDE_DELETE_USAGE_NAME,
        NOTIFY_APPROVALS_NAME,
        SEND_TEST_APPROVAL_NAME,
        REBUILD_NAME,
        CLAUDE_HOOKS_NAME,
      ]),
    );
    expect(new Set(POINTER_ALIASES).size).toBe(POINTER_ALIASES.length);
  });

  it("keeps the action's own name findable", () => {
    expect(POINTER_ALIASES).toContain("Open settings");
  });
});

describe("Task 3, Test 3: Open settings", () => {
  it("requests the visual section, selects Settings and reveals the view, in that order", () => {
    const host = createHost();
    const tab = new CommandCenterSettingTab({} as never, {} as never, host);

    tab.getSettingDefinitions()[1]?.action?.({} as never, 1);

    // By the time the view is revealed both requests are already waiting for it.
    expect(host.calls).toEqual(["reveal(section=visual,destination=settings)"]);
    expect(navigationRequest.value?.destination).toBe("settings");
  });

  it("is repeatable: a second press asks again", () => {
    const host = createHost();
    const tab = new CommandCenterSettingTab({} as never, {} as never, host);
    const action = tab.getSettingDefinitions()[1]?.action;

    action?.({} as never, 1);
    takeSettingsSectionRequest();
    navigationRequest.value = null;
    action?.({} as never, 1);

    expect(host.calls).toHaveLength(2);
  });
});

describe("Task 3, Test 4: nothing else lives in the tab", () => {
  const tabSource = readFileSync(join(HERE, "settings-tab.ts"), "utf8");
  const code = tabSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("the tab host type has no claude, codex, approvals, tasks or delete-usage member", () => {
    const hostType = /export interface SettingsTabHost[\s\S]*?\n\}/.exec(code)?.[0] ?? "";
    expect(hostType).not.toBe("");
    for (const member of ["claude", "codex", "approvals", "tasks", "openDeleteUsageModal"]) {
      expect(hostType, member).not.toMatch(new RegExp(`\\b${member}\\b`));
    }
  });

  it("holds no Claude, Codex, approvals or tasks row, status fetch or copy command", () => {
    expect(code).not.toMatch(
      /getIntegration|copyText|rebuildTaskIndex|sendTestApproval|deleteUsageAnalytics|setTranscriptAnalysis|buildCodexGroup|CodexSettingsState|type:\s*"group"/,
    );
  });

  it("the Codex group builder and its state class are gone from codex-settings.ts", () => {
    const codex = readFileSync(join(HERE, "codex-settings.ts"), "utf8");
    expect(codex).not.toContain("buildCodexGroup");
    expect(codex).not.toContain("CodexSettingsState");
    // The status texts the destination reads are kept.
    expect(codex).toContain("export function codexHookStatusText");
    expect(codex).toContain("export function codexBridgeStatusText");
  });

  it("the tab declares only the reduced-motion and pointer controls", () => {
    expect(
      [...code.matchAll(/type:\s*"(dropdown|toggle|slider|text|button)"/g)].map((m) => m[1]),
    ).toEqual(["dropdown"]);
  });
});

describe("Task 3, Test 5: the tab is Obsidian chrome", () => {
  const tabSource = readFileSync(join(HERE, "settings-tab.ts"), "utf8");
  const code = tabSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("uses no --ccc-* token and no command-center class", () => {
    expect(code).not.toContain("--ccc-");
    expect(code).not.toMatch(/\bccc-|command-center["'`]/);
    expect(code).not.toMatch(/\bclassName\b|\.cls\b|addClass|createDiv|createEl/);
  });

  it("the definitions carry no markup or class, only plain strings", () => {
    const tab = new CommandCenterSettingTab({} as never, {} as never, createHost());
    const text = JSON.stringify(tab.getSettingDefinitions(), (_key, value: unknown) =>
      typeof value === "function" ? "fn" : value,
    );
    expect(text).not.toMatch(/ccc-|<[a-z]/);
  });
});
