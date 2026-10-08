import type { ClaudeIntegrationStatus } from "@ccc/domain";
import { Notice } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { motionMode } from "../motion.js";
import { formatAbsoluteTime, formatRelativeTime } from "../widgets/relative-time.js";
import {
  applyReducedMotionChange,
  applyTranscriptAnalysisChange,
  asMotionPreference,
  CLAUDE_COPY_FAILED_NOTICE,
  CLAUDE_COPY_INSTALL_NAME,
  CLAUDE_COPY_UNINSTALL_NAME,
  CLAUDE_DELETE_USAGE_NAME,
  CLAUDE_DELETE_USAGE_RETAINED_NOTE,
  CLAUDE_GROUP_HEADING,
  CLAUDE_HOOKS_NAME,
  CLAUDE_HOOKS_NOT_INSTALLED_TEXT,
  CLAUDE_INSTALL_COMMAND,
  CLAUDE_INSTALL_COPIED_NOTICE,
  CLAUDE_STATUS_UNAVAILABLE_TEXT,
  CLAUDE_STATUSLINE_NAME,
  CLAUDE_TRANSCRIPT_ANALYSIS_FAILED_NOTICE,
  CLAUDE_TRANSCRIPT_ANALYSIS_NAME,
  CLAUDE_UNINSTALL_COMMAND,
  CLAUDE_UNINSTALL_COPIED_NOTICE,
  CLAUDE_USAGE_DELETE_FAILED_NOTICE,
  CLAUDE_USAGE_DELETED_NOTICE,
  APPROVALS_GROUP_HEADING,
  applyNotifyApprovalsChange,
  CommandCenterSettingTab,
  NOTIFY_APPROVALS_DESC,
  NOTIFY_APPROVALS_KEY,
  NOTIFY_APPROVALS_NAME,
  NOTIFY_APPROVALS_SAVE_FAILED,
  SEND_TEST_APPROVAL_DESC,
  SEND_TEST_APPROVAL_NAME,
  SEND_TEST_APPROVAL_NEEDS_SERVICE,
  hookStatusText,
  REDUCED_MOTION_KEY,
  REDUCED_MOTION_OPTIONS,
  REDUCED_MOTION_SAVE_FAILED,
  type SettingsClaudeSeam,
  type SettingsTabHost,
  statusLineStatusText,
  TRANSCRIPT_ANALYSIS_KEY,
} from "./settings-tab.js";

/** Flushes enough microtask ticks for a chain of a few awaited promises to settle. */
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

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

function createHost(
  options: {
    failSave?: boolean;
    claude?: SettingsClaudeSeam;
    openDeleteUsageModal?: (horizonDate: string | null, analysisOn: boolean) => Promise<boolean>;
  } = {},
): Recorded {
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
    claude: options.claude,
    openDeleteUsageModal: options.openDeleteUsageModal,
  };
  return host;
}

const BASE_CLAUDE_STATUS: ClaudeIntegrationStatus = {
  hooks: "not-installed",
  hookRuntimeMissing: false,
  disableAllHooks: null,
  lastEventAt: null,
  telemetry: { kind: "ok" },
  detectedClaudeVersion: null,
  statusLine: "not-installed",
  statusLineReported: false,
  transcriptAnalysis: { enabled: false },
  spoolDropCount: 0,
  unknownEventCount: 0,
  cleanupPeriodDays: 30,
};

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

  it("declares the Claude group with six rows in the fixed UI-SPEC order (Test 3)", () => {
    const host = createHost();
    const tab = new CommandCenterSettingTab({} as never, {} as never, host);

    const definitions = tab.getSettingDefinitions();
    const group = definitions[1];

    expect(group).toMatchObject({ type: "group", heading: CLAUDE_GROUP_HEADING });
    // A group's `items` field only exists on SettingDefinitionGroup -- narrow first.
    if (!group || !("items" in group) || !group.items) throw new Error("expected a group");
    const names = group.items.map((item) => item.name);
    expect(names).toEqual([
      CLAUDE_HOOKS_NAME,
      CLAUDE_COPY_INSTALL_NAME,
      CLAUDE_COPY_UNINSTALL_NAME,
      CLAUDE_STATUSLINE_NAME,
      CLAUDE_TRANSCRIPT_ANALYSIS_NAME,
      CLAUDE_DELETE_USAGE_NAME,
    ]);
  });

  it("reads Checking… before the service answers, then the resolved status after update() (Test 4)", async () => {
    let resolveIntegration!: (status: ClaudeIntegrationStatus) => void;
    const host = createHost({
      claude: {
        getIntegration: () =>
          new Promise<ClaudeIntegrationStatus>((resolve) => {
            resolveIntegration = resolve;
          }),
        setTranscriptAnalysis: vi.fn(),
        deleteUsageAnalytics: vi.fn(),
        copyText: vi.fn(),
      },
    });
    const tab = new CommandCenterSettingTab({} as never, {} as never, host);

    const firstGroup = tab.getSettingDefinitions()[1];
    if (!firstGroup || !("items" in firstGroup) || !firstGroup.items) {
      throw new Error("expected a group");
    }
    expect(firstGroup.items[0]?.desc).toBe("Checking…");

    resolveIntegration({ ...BASE_CLAUDE_STATUS, hooks: "installed", lastEventAt: null });
    await Promise.resolve();
    await Promise.resolve();

    const secondGroup = tab.getSettingDefinitions()[1];
    if (!secondGroup || !("items" in secondGroup) || !secondGroup.items) {
      throw new Error("expected a group");
    }
    // A resolved installed status with no lastEventAt renders through the
    // same silent-since bucket as a stale one -- never a blank row.
    expect(secondGroup.items[0]?.desc).toContain("Installed");
  });

  it("reverts the transcript toggle and notifies on a failed write, without touching plugin settings (Test 5)", async () => {
    const setTranscriptAnalysis = vi.fn().mockRejectedValue(new Error("service down"));
    const host = createHost({
      claude: {
        getIntegration: vi.fn().mockResolvedValue(BASE_CLAUDE_STATUS),
        setTranscriptAnalysis,
        deleteUsageAnalytics: vi.fn(),
        copyText: vi.fn(),
      },
    });

    const outcome = await applyTranscriptAnalysisChange(host, true);

    expect(outcome).toBe("reverted");
    expect(setTranscriptAnalysis).toHaveBeenCalledWith(true);
    expect(host.notices).toEqual([CLAUDE_TRANSCRIPT_ANALYSIS_FAILED_NOTICE]);
    expect(host.saveCalls).toBe(0);
    expect(host.settings).not.toHaveProperty("transcriptAnalysis");
  });

  it("saves the transcript toggle through the service alone (Test 5)", async () => {
    const setTranscriptAnalysis = vi.fn().mockResolvedValue({ enabled: true });
    const host = createHost({
      claude: {
        getIntegration: vi.fn().mockResolvedValue(BASE_CLAUDE_STATUS),
        setTranscriptAnalysis,
        deleteUsageAnalytics: vi.fn(),
        copyText: vi.fn(),
      },
    });

    const outcome = await applyTranscriptAnalysisChange(host, true);

    expect(outcome).toBe("saved");
    expect(setTranscriptAnalysis).toHaveBeenCalledWith(true);
    expect(host.notices).toEqual([]);
    expect(host.saveCalls).toBe(0);
  });
});

describe("hookStatusText (Test 4)", () => {
  const NOW = Date.parse("2026-09-28T12:00:00Z");

  it("reads Checking… before the service answers", () => {
    expect(hookStatusText("checking", NOW)).toBe("Checking…");
  });

  it("reads the last-event relative time within the silent threshold", () => {
    const lastEventAt = new Date(NOW - 2 * 60 * 1000).toISOString();
    const status = { hooks: "installed" as const, lastEventAt, telemetry: { kind: "ok" as const } };

    expect(hookStatusText(status, NOW)).toBe(
      `Installed. Last event ${formatRelativeTime(lastEventAt, NOW)}.`,
    );
  });

  it("reads the no-events-since string once the silent threshold has passed", () => {
    const lastEventAt = new Date(NOW - 11 * 60 * 1000).toISOString();
    const status = { hooks: "installed" as const, lastEventAt, telemetry: { kind: "ok" as const } };

    expect(hookStatusText(status, NOW)).toBe(
      `Installed, but no events have arrived since ${formatAbsoluteTime(lastEventAt)}. ` +
        "Claude Code skips hooks in folders you haven't trusted and when hooks are turned off in its settings.",
    );
  });

  it("reads the not-installed string", () => {
    const status = {
      hooks: "not-installed" as const,
      lastEventAt: null,
      telemetry: { kind: "ok" as const },
    };
    expect(hookStatusText(status, NOW)).toBe(CLAUDE_HOOKS_NOT_INSTALLED_TEXT);
  });

  it("reads the unsupported-version string ahead of the install state", () => {
    const status = {
      hooks: "installed" as const,
      lastEventAt: null,
      telemetry: { kind: "unsupported-version" as const, version: "2.1.100" },
    };
    expect(hookStatusText(status, NOW)).toBe(
      "Claude Code 2.1.100 is older than the minimum supported 2.1.214.",
    );
  });

  it("reads the shape-changed string ahead of the install state", () => {
    const status = {
      hooks: "installed" as const,
      lastEventAt: null,
      telemetry: { kind: "shape-changed" as const, version: "2.1.290" },
    };
    expect(hookStatusText(status, NOW)).toBe(
      "Claude Code 2.1.290 changed its hook event format. Session tracking is paused rather than guessed.",
    );
  });

  it("reads the unavailable string for a client failure", () => {
    expect(hookStatusText("unavailable", NOW)).toBe(CLAUDE_STATUS_UNAVAILABLE_TEXT);
  });
});

describe("statusLineStatusText (Test 4)", () => {
  it("reads installed-and-available", () => {
    expect(statusLineStatusText({ statusLine: "installed", statusLineReported: true }, 0)).toBe(
      "Installed. Plan usage is available.",
    );
  });

  it("reads installed-and-waiting", () => {
    expect(statusLineStatusText({ statusLine: "installed", statusLineReported: false }, 0)).toBe(
      "Installed. Waiting for the first response in a Claude Code session.",
    );
  });

  it("reads not-installed", () => {
    expect(
      statusLineStatusText({ statusLine: "not-installed", statusLineReported: false }, 0),
    ).toBe(
      'Not installed. Plan usage reads "Account capacity unavailable". The wrapper keeps your current status line exactly as it is.',
    );
  });

  it("reads unavailable for a client failure", () => {
    expect(statusLineStatusText("unavailable", 0)).toBe(CLAUDE_STATUS_UNAVAILABLE_TEXT);
  });
});

/** Task 3: the delete-usage confirmation modal and the copy-command rows. */
describe("CommandCenterSettingTab -- Claude rows 2, 3 and 6 (Task 3)", () => {
  function fullClaudeSeam(overrides: Partial<SettingsClaudeSeam> = {}): SettingsClaudeSeam {
    return {
      getIntegration: vi.fn().mockResolvedValue(BASE_CLAUDE_STATUS),
      setTranscriptAnalysis: vi.fn().mockResolvedValue({ enabled: false }),
      deleteUsageAnalytics: vi.fn().mockResolvedValue(undefined),
      copyText: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  it("row 6's action opens the modal and deletes on confirm (Test 3)", async () => {
    const deleteUsageAnalytics = vi.fn().mockResolvedValue(undefined);
    const openDeleteUsageModal = vi.fn().mockResolvedValue(true);
    const host = createHost({
      claude: fullClaudeSeam({ deleteUsageAnalytics }),
      openDeleteUsageModal,
    });
    const tab = new CommandCenterSettingTab({} as never, {} as never, host);
    tab.getSettingDefinitions();
    await flush();

    const group = tab.getSettingDefinitions()[1];
    group.items[5].action?.({} as never, 5);
    await flush();

    expect(openDeleteUsageModal).toHaveBeenCalledTimes(1);
    expect(deleteUsageAnalytics).toHaveBeenCalledTimes(1);
    expect(host.notices).toEqual([CLAUDE_USAGE_DELETED_NOTICE]);
  });

  it("row 6 tells the modal whether transcript analysis is on (wave 4, f44c3ae rebuild)", async () => {
    for (const enabled of [true, false]) {
      const openDeleteUsageModal = vi.fn().mockResolvedValue(false);
      const host = createHost({
        claude: fullClaudeSeam({
          getIntegration: vi
            .fn()
            .mockResolvedValue({ ...BASE_CLAUDE_STATUS, transcriptAnalysis: { enabled } }),
        }),
        openDeleteUsageModal,
      });
      const tab = new CommandCenterSettingTab({} as never, {} as never, host);
      tab.getSettingDefinitions();
      await flush();

      const group = tab.getSettingDefinitions()[1];
      group.items[5].action?.({} as never, 5);
      await flush();

      expect(openDeleteUsageModal).toHaveBeenCalledWith(expect.any(String), enabled);
    }
  });

  it("row 6's action calls nothing when the modal is cancelled (Test 3)", async () => {
    const deleteUsageAnalytics = vi.fn();
    const openDeleteUsageModal = vi.fn().mockResolvedValue(false);
    const host = createHost({
      claude: fullClaudeSeam({ deleteUsageAnalytics }),
      openDeleteUsageModal,
    });
    const tab = new CommandCenterSettingTab({} as never, {} as never, host);
    tab.getSettingDefinitions();
    await flush();

    const group = tab.getSettingDefinitions()[1];
    group.items[5].action?.({} as never, 5);
    await flush();

    expect(deleteUsageAnalytics).not.toHaveBeenCalled();
    expect(host.notices).toEqual([]);
  });

  it("row 6's action notifies the failure string on a rejected deletion (Test 3)", async () => {
    const deleteUsageAnalytics = vi.fn().mockRejectedValue(new Error("service down"));
    const openDeleteUsageModal = vi.fn().mockResolvedValue(true);
    const host = createHost({
      claude: fullClaudeSeam({ deleteUsageAnalytics }),
      openDeleteUsageModal,
    });
    const tab = new CommandCenterSettingTab({} as never, {} as never, host);
    tab.getSettingDefinitions();
    await flush();

    const group = tab.getSettingDefinitions()[1];
    group.items[5].action?.({} as never, 5);
    await flush();

    expect(host.notices).toEqual([CLAUDE_USAGE_DELETE_FAILED_NOTICE]);
  });

  it("row 6 gains the retained-totals note once transcript analysis is turned off (Test 4, R-15)", async () => {
    const setTranscriptAnalysis = vi.fn().mockResolvedValue({ enabled: false });
    const host = createHost({
      claude: fullClaudeSeam({
        getIntegration: vi
          .fn()
          .mockResolvedValue({ ...BASE_CLAUDE_STATUS, transcriptAnalysis: { enabled: true } }),
        setTranscriptAnalysis,
      }),
    });
    const tab = new CommandCenterSettingTab({} as never, {} as never, host);
    tab.getSettingDefinitions();
    await flush();

    await tab.setControlValue(TRANSCRIPT_ANALYSIS_KEY, false);

    const group = tab.getSettingDefinitions()[1];
    expect(group.items[5].desc).toContain(CLAUDE_DELETE_USAGE_RETAINED_NOTE);
  });

  it("row 2's action copies the install command and notifies (Test 5)", async () => {
    const copyText = vi.fn().mockResolvedValue(undefined);
    const host = createHost({ claude: fullClaudeSeam({ copyText }) });
    const tab = new CommandCenterSettingTab({} as never, {} as never, host);

    const group = tab.getSettingDefinitions()[1];
    group.items[1].action?.({} as never, 1);
    await flush();

    expect(copyText).toHaveBeenCalledWith(CLAUDE_INSTALL_COMMAND);
    expect(host.notices).toEqual([CLAUDE_INSTALL_COPIED_NOTICE]);
  });

  it("row 3's action copies the uninstall command and notifies (Test 5)", async () => {
    const copyText = vi.fn().mockResolvedValue(undefined);
    const host = createHost({ claude: fullClaudeSeam({ copyText }) });
    const tab = new CommandCenterSettingTab({} as never, {} as never, host);

    const group = tab.getSettingDefinitions()[1];
    group.items[2].action?.({} as never, 2);
    await flush();

    expect(copyText).toHaveBeenCalledWith(CLAUDE_UNINSTALL_COMMAND);
    expect(host.notices).toEqual([CLAUDE_UNINSTALL_COPIED_NOTICE]);
  });

  it("row 2's description mentions --dry-run and --with-statusline, and no row renders a home path (Test 5)", () => {
    const host = createHost();
    const tab = new CommandCenterSettingTab({} as never, {} as never, host);

    const group = tab.getSettingDefinitions()[1];
    expect(group.items[1].desc).toContain("--dry-run");
    expect(group.items[1].desc).toContain("--with-statusline");

    const allText = group.items.map((item) => `${item.name} ${item.desc ?? ""}`).join(" ");
    expect(allText).not.toContain("/Users/");
    expect(allText).not.toContain("~/.claude");
  });
});

describe("CommandCenterSettingTab -- status freshness and control safety (wave 2 review)", () => {
  function seam(overrides: Partial<SettingsClaudeSeam> = {}): SettingsClaudeSeam {
    return {
      getIntegration: vi.fn().mockResolvedValue(BASE_CLAUDE_STATUS),
      setTranscriptAnalysis: vi.fn().mockResolvedValue({ enabled: false }),
      deleteUsageAnalytics: vi.fn().mockResolvedValue(undefined),
      copyText: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  function hookRow(tab: CommandCenterSettingTab): string | undefined {
    return tab.getSettingDefinitions()[1].items[0].desc;
  }

  function toggleDisabled(tab: CommandCenterSettingTab): boolean {
    return tab.getSettingDefinitions()[1].items[4].control.disabled();
  }

  it("re-fetches the status each time the tab is displayed, showing the newest answer", async () => {
    const getIntegration = vi
      .fn()
      .mockResolvedValue({ ...BASE_CLAUDE_STATUS, hooks: "installed", lastEventAt: null })
      .mockResolvedValueOnce(BASE_CLAUDE_STATUS);
    const tab = new CommandCenterSettingTab(
      {} as never,
      {} as never,
      createHost({ claude: seam({ getIntegration }) }),
    );

    tab.getSettingDefinitions(); // first display
    await flush();
    expect(hookRow(tab)).toBe(CLAUDE_HOOKS_NOT_INSTALLED_TEXT);
    await flush(); // the owner opens the tab again (hookRow was that display)

    expect(getIntegration).toHaveBeenCalledTimes(2);
    expect(hookRow(tab)).toContain("Installed");
  });

  it("its own update() after a status read starts no further read, so there is no refresh loop", async () => {
    const getIntegration = vi.fn().mockResolvedValue(BASE_CLAUDE_STATUS);
    const tab = new CommandCenterSettingTab(
      {} as never,
      {} as never,
      createHost({ claude: seam({ getIntegration }) }),
    );
    // Obsidian's update() re-reads getSettingDefinitions(); the stub's does not.
    tab.update = () => {
      tab.getSettingDefinitions();
    };

    tab.getSettingDefinitions();
    await flush(12);

    expect(getIntegration).toHaveBeenCalledTimes(1);
  });

  it("starts no second fetch while one is in flight, then re-fetches on the next display", async () => {
    const resolvers: Array<(status: ClaudeIntegrationStatus) => void> = [];
    const getIntegration = vi.fn(
      () =>
        new Promise<ClaudeIntegrationStatus>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const tab = new CommandCenterSettingTab(
      {} as never,
      {} as never,
      createHost({ claude: seam({ getIntegration }) }),
    );

    tab.getSettingDefinitions();
    tab.getSettingDefinitions();
    expect(getIntegration).toHaveBeenCalledTimes(1);

    resolvers[0]?.({ ...BASE_CLAUDE_STATUS, hooks: "installed", lastEventAt: null });
    await flush();
    tab.getSettingDefinitions();
    expect(getIntegration).toHaveBeenCalledTimes(2);
    resolvers[1]?.(BASE_CLAUDE_STATUS);
    await flush();

    expect(hookRow(tab)).toBe(CLAUDE_HOOKS_NOT_INSTALLED_TEXT);
  });

  it("disables the transcript toggle while checking and while unavailable, enables it once known", async () => {
    let resolveIntegration!: (status: ClaudeIntegrationStatus) => void;
    let rejectIntegration!: (error: Error) => void;
    const getIntegration = vi.fn(
      () =>
        new Promise<ClaudeIntegrationStatus>((resolve, reject) => {
          resolveIntegration = resolve;
          rejectIntegration = reject;
        }),
    );
    const tab = new CommandCenterSettingTab(
      {} as never,
      {} as never,
      createHost({ claude: seam({ getIntegration }) }),
    );

    tab.getSettingDefinitions();
    expect(toggleDisabled(tab)).toBe(true); // checking

    resolveIntegration(BASE_CLAUDE_STATUS);
    await flush();
    expect(toggleDisabled(tab)).toBe(false);

    tab.getSettingDefinitions(); // shown again; this fetch fails
    rejectIntegration(new Error("service down"));
    await flush();
    expect(hookRow(tab)).toBe(CLAUDE_STATUS_UNAVAILABLE_TEXT);
    expect(toggleDisabled(tab)).toBe(true);
  });

  it("a rejected copy notifies the failure instead of the copied notice", async () => {
    const copyText = vi.fn().mockRejectedValue(new Error("clipboard denied"));
    const host = createHost({ claude: seam({ copyText }) });
    const tab = new CommandCenterSettingTab({} as never, {} as never, host);

    tab.getSettingDefinitions()[1].items[1].action?.({} as never, 1);
    await flush();

    expect(copyText).toHaveBeenCalledWith(CLAUDE_INSTALL_COMMAND);
    expect(host.notices).toEqual([CLAUDE_COPY_FAILED_NOTICE]);
  });
});

describe("Approvals group (plan 06-23, UI-SPEC S5)", () => {
  function approvalsHost(options: { failSave?: boolean; available?: boolean } = {}) {
    const notices: string[] = [];
    const press = vi.fn();
    const host: SettingsTabHost & { saveCalls: number } = {
      settings: { reducedMotion: "auto", notifyApprovals: true },
      mql: { matches: false },
      saveCalls: 0,
      saveSettings: async () => {
        host.saveCalls++;
        if (options.failSave) throw new Error("disk full");
      },
      notify: (m: string) => {
        notices.push(m);
      },
      approvals: { sendTestApproval: press, serviceAvailable: () => options.available ?? true },
    };
    return { host, notices, press };
  }

  function group(tab: CommandCenterSettingTab) {
    const g = tab.getSettingDefinitions()[2];
    if (!g || !("items" in g) || !g.items) throw new Error("expected the Approvals group");
    return g;
  }

  it("Test 1: ends with an Approvals group and keeps the earlier rows and Claude group first", () => {
    const { host } = approvalsHost();
    const tab = new CommandCenterSettingTab({} as never, {} as never, host);
    const defs = tab.getSettingDefinitions();

    expect(defs[0].control.key).toBe(REDUCED_MOTION_KEY);
    expect(defs[1]).toMatchObject({ type: "group", heading: CLAUDE_GROUP_HEADING });
    const g = group(tab);
    expect(g).toMatchObject({ type: "group", heading: APPROVALS_GROUP_HEADING });
    expect(g.items.map((i) => i.name)).toEqual([NOTIFY_APPROVALS_NAME, SEND_TEST_APPROVAL_NAME]);
    expect(g.items[0]?.desc).toBe(NOTIFY_APPROVALS_DESC);
    expect(g.items[0]?.control).toMatchObject({ type: "toggle", key: NOTIFY_APPROVALS_KEY });
    expect(g.items[1]?.desc).toBe(SEND_TEST_APPROVAL_DESC);
    expect(NOTIFY_APPROVALS_NAME).toBe("Approval notifications");
    expect(SEND_TEST_APPROVAL_NAME).toBe("Send a test approval");
  });

  it("Test 2: pressing the action asks the seam to send", () => {
    const { host, press } = approvalsHost();
    const tab = new CommandCenterSettingTab({} as never, {} as never, host);

    group(tab).items[1]?.action?.({} as never, 1);

    expect(press).toHaveBeenCalledTimes(1);
  });

  it("Test 4: with the service down the action is disabled, says so, and does nothing", () => {
    const { host, press } = approvalsHost({ available: false });
    const tab = new CommandCenterSettingTab({} as never, {} as never, host);
    const row = group(tab).items[1];

    expect(row?.desc).toBe(`${SEND_TEST_APPROVAL_DESC}${SEND_TEST_APPROVAL_NEEDS_SERVICE}`);
    expect(SEND_TEST_APPROVAL_NEEDS_SERVICE).toBe(" Needs the companion service, which isn't running.");
    const disabled = row && "disabled" in row ? row.disabled : undefined;
    expect(typeof disabled === "function" ? disabled() : disabled).toBe(true);
    row?.action?.({} as never, 1);
    expect(press).not.toHaveBeenCalled();
  });

  it("Test 6: the toggle persists first and applies second", async () => {
    const { host } = approvalsHost();
    const tab = new CommandCenterSettingTab({} as never, {} as never, host);

    expect(tab.getControlValue(NOTIFY_APPROVALS_KEY)).toBe(true);
    await tab.setControlValue(NOTIFY_APPROVALS_KEY, false);

    expect(host.saveCalls).toBe(1);
    expect(host.settings.notifyApprovals).toBe(false);
    expect(tab.getControlValue(NOTIFY_APPROVALS_KEY)).toBe(false);
  });

  it("Test 6: a failed save restores the control and posts the fixed notice", async () => {
    const { host, notices } = approvalsHost({ failSave: true });
    const tab = new CommandCenterSettingTab({} as never, {} as never, host);

    const outcome = await applyNotifyApprovalsChange(host, false);

    expect(outcome).toBe("reverted");
    expect(host.settings.notifyApprovals).toBe(true);
    expect(notices).toEqual([NOTIFY_APPROVALS_SAVE_FAILED]);
    expect(NOTIFY_APPROVALS_SAVE_FAILED).toBe("Couldn't save the approval notifications setting.");
    await tab.setControlValue(NOTIFY_APPROVALS_KEY, false);
    expect(tab.getControlValue(NOTIFY_APPROVALS_KEY)).toBe(true);
  });
});
