import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionState } from "../connection-state.js";
import { motionMode } from "../motion.js";
import type { LaunchersActions } from "../projects/launchers-actions.js";
import { assertNoPrivatePathValues, DEFAULT_SETTINGS } from "../settings.js";
import { createLaunchersSession } from "./launchers-settings.js";
import { SettingsDestination } from "./settings-destination.js";
import { createInertSettingsHost, type SettingsHost } from "./settings-host.js";
import {
  NOTIFY_APPROVALS_DESC,
  NOTIFY_APPROVALS_SAVE_FAILED,
  REBUILD_DESC,
  REBUILD_FAILED_NOTICE,
  REBUILD_STARTED_NOTICE,
  REDUCED_MOTION_DESC,
  REDUCED_MOTION_SAVE_FAILED,
  rebuildSuccessNotice,
  SEND_TEST_APPROVAL_DESC,
} from "./settings-model.js";
import { resetPendingActions } from "./settings-pending.js";
import { takeSettingsSectionRequest } from "./settings-sections.js";

/**
 * The Approvals and tasks and Visual sections (plan 08-11 Task 3; 08-UI-SPEC S2, D-18, D-44,
 * accessibility additions 6 to 8): keyboard-operable, honest controls whose results reach the
 * destination's one status line, with nothing but the four allowed keys ever saved.
 */

const NEVER = (): Promise<never> => new Promise<never>(() => {});
const FAILED = (): Promise<{ kind: "failed" }> => Promise.resolve({ kind: "failed" });
const AWAY = "The companion service isn't running.";
const ALLOWED_KEYS = [
  "lastOpenedDestination",
  "notifyApprovals",
  "reducedMotion",
  "socketPathOverride",
];

const LAUNCHERS: LaunchersActions = {
  detect: NEVER,
  getConfigs: NEVER,
  save: vi.fn(),
  test: vi.fn(),
  markTested: vi.fn(),
  openSystemSettings: vi.fn(),
  codexDoctor: vi.fn(),
};

interface Fixture {
  readonly host: SettingsHost;
  readonly saves: string[][];
  readonly sendTestApproval: ReturnType<typeof vi.fn>;
  readonly rebuildTaskIndex: ReturnType<typeof vi.fn>;
  available: boolean;
}

function fixture(overrides: Partial<SettingsHost> = {}): Fixture {
  const saves: string[][] = [];
  const sendTestApproval = vi.fn();
  const rebuildTaskIndex = vi.fn(() => Promise.resolve({ tasks: 0, attention: 0 }));
  const state = { available: true };
  const base = createInertSettingsHost();
  const host: SettingsHost = {
    ...base,
    settings: { ...DEFAULT_SETTINGS },
    saveSettings: vi.fn(() => {
      saves.push(Object.keys(host.settings).sort());
      return Promise.resolve();
    }),
    approvals: { sendTestApproval, serviceAvailable: () => state.available },
    tasks: { rebuildTaskIndex, serviceAvailable: () => state.available },
    ...overrides,
  };
  return {
    host,
    saves,
    sendTestApproval,
    rebuildTaskIndex,
    get available() {
      return state.available;
    },
    set available(value: boolean) {
      state.available = value;
    },
  };
}

function renderSection(host: SettingsHost, section: string) {
  const view = render(
    <SettingsDestination
      settingsHost={host}
      launchersActions={LAUNCHERS}
      launchersSession={createLaunchersSession()}
      projectsActions={{
        register: FAILED,
        remove: FAILED,
        rename: FAILED,
        pin: FAILED,
        setGithubLink: FAILED,
        refresh: FAILED,
      }}
      pickFolder={() => Promise.resolve({ kind: "unavailable" })}
      connection={{ kind: "live" }}
      now={Date.parse("2026-10-22T10:00:00.000Z")}
    />,
  );
  fireEvent.click(
    within(screen.getByRole("navigation", { name: "Settings sections" })).getByRole("button", {
      name: section,
    }),
  );
  return view;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function statusLine(): string {
  return document.querySelector(".ccc-settings-status")?.textContent ?? "";
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  motionMode.value = "full";
  connectionState.value = { kind: "live" };
});

afterEach(() => {
  cleanup();
  resetPendingActions();
  motionMode.value = "full";
  connectionState.value = { kind: "connecting" };
  takeSettingsSectionRequest();
});

describe("Task 3 Test 3: Approvals and tasks", () => {
  it("shows the section frame with the three rows and their moved descriptions", async () => {
    renderSection(fixture().host, "Approvals and tasks");
    await flush();
    expect(screen.getByRole("heading", { level: 3, name: "Approvals and tasks" })).toBeTruthy();
    expect(
      screen.getByText("Notifications for approval requests and the task index."),
    ).toBeTruthy();
    expect(screen.getByRole("group", { name: "Approval notifications" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Send a test approval" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Rebuild task index" })).toBeTruthy();
    expect(screen.getByText(NOTIFY_APPROVALS_DESC)).toBeTruthy();
    expect(screen.getByText(SEND_TEST_APPROVAL_DESC)).toBeTruthy();
    expect(screen.getByText(REBUILD_DESC)).toBeTruthy();
  });

  it("the notifications switch persists notifyApprovals and reads On or Off", async () => {
    const f = fixture();
    renderSection(f.host, "Approvals and tasks");
    const toggle = screen.getByRole("switch", { name: "Approval notifications" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.textContent).toBe("On");

    fireEvent.click(toggle);
    await flush();
    expect(f.host.saveSettings).toHaveBeenCalledTimes(1);
    expect(f.host.settings.notifyApprovals).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.textContent).toBe("Off");
    // A successful save needs no announcement of its own beyond the visible word.
    expect(statusLine()).toBe("");
  });

  it("a failed save reverts the switch and the status line names the failure", async () => {
    const f = fixture();
    (f.host.saveSettings as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("disk"));
    renderSection(f.host, "Approvals and tasks");
    const toggle = screen.getByRole("switch", { name: "Approval notifications" });
    fireEvent.click(toggle);
    await flush();
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(f.host.settings.notifyApprovals).toBe(true);
    expect(statusLine()).toBe(NOTIFY_APPROVALS_SAVE_FAILED);
  });

  it("Send a test approval calls the approvals seam", async () => {
    const f = fixture();
    renderSection(f.host, "Approvals and tasks");
    const button = screen.getByRole("button", { name: "Send a test approval" });
    expect(button.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(button);
    await flush();
    expect(f.sendTestApproval).toHaveBeenCalledTimes(1);
  });

  it("Send a test approval is aria-disabled with a visible reason while the service is away", async () => {
    const f = fixture();
    f.available = false;
    renderSection(f.host, "Approvals and tasks");
    const button = screen.getByRole("button", { name: "Send a test approval" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
    const reasons = screen.getAllByText(AWAY);
    const described = button.getAttribute("aria-describedby") ?? "";
    expect(
      reasons.some((reason) => reason.id !== "" && described.split(" ").includes(reason.id)),
    ).toBe(true);
    fireEvent.click(button);
    await flush();
    expect(f.sendTestApproval).not.toHaveBeenCalled();
  });

  it("Rebuild task index posts the start line, is busy and ignores a second press, then reports the result twice", async () => {
    const f = fixture();
    const pending = deferred<{ tasks: number; attention: number }>();
    f.rebuildTaskIndex.mockReturnValue(pending.promise);
    renderSection(f.host, "Approvals and tasks");
    const button = screen.getByRole("button", { name: "Rebuild task index" });
    expect(document.querySelector('[data-result="rebuild"]')).toBeNull();

    fireEvent.click(button);
    fireEvent.click(button);
    await flush();
    expect(f.rebuildTaskIndex).toHaveBeenCalledTimes(1);
    expect(statusLine()).toBe(REBUILD_STARTED_NOTICE);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.getAttribute("aria-disabled")).toBe("true");

    pending.resolve({ tasks: 212, attention: 3 });
    await flush();
    const expected = rebuildSuccessNotice(212, 3);
    expect(expected).toBe("Task index rebuilt. 212 tasks found. 3 notes need attention.");
    expect(statusLine()).toBe(expected);
    // The persistent result line under the row, for the runner to assert.
    const result = document.querySelector('[data-result="rebuild"]');
    expect(result?.textContent).toBe(expected);
    // FIX2B m3: a plain paragraph, neither a status role nor an aria-live of any value.
    expect(result?.tagName).toBe("P");
    expect(result?.hasAttribute("role")).toBe(false);
    expect(result?.hasAttribute("aria-live")).toBe(false);
    expect(result?.closest(".ccc-setting-row")).toBe(
      screen.getByRole("group", { name: "Rebuild task index" }),
    );
    expect(button.getAttribute("aria-busy")).toBeNull();
    expect(button.getAttribute("aria-disabled")).toBeNull();

    // After it settles the action can be used again.
    f.rebuildTaskIndex.mockResolvedValue({ tasks: 1, attention: 0 });
    fireEvent.click(button);
    await flush();
    expect(f.rebuildTaskIndex).toHaveBeenCalledTimes(2);
    expect(statusLine()).toBe("Task index rebuilt. 1 task found.");
  });

  it("a failed rebuild says so in the status line and under the row", async () => {
    const f = fixture();
    f.rebuildTaskIndex.mockRejectedValue(new Error("nope"));
    renderSection(f.host, "Approvals and tasks");
    fireEvent.click(screen.getByRole("button", { name: "Rebuild task index" }));
    await flush();
    expect(statusLine()).toBe(REBUILD_FAILED_NOTICE);
    expect(document.querySelector('[data-result="rebuild"]')?.textContent).toBe(
      REBUILD_FAILED_NOTICE,
    );
  });

  it("Rebuild task index is aria-disabled with a visible reason while the service is away", async () => {
    const f = fixture();
    f.available = false;
    renderSection(f.host, "Approvals and tasks");
    const button = screen.getByRole("button", { name: "Rebuild task index" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(screen.getAllByText(AWAY).length).toBeGreaterThan(0);
    fireEvent.click(button);
    await flush();
    expect(f.rebuildTaskIndex).not.toHaveBeenCalled();
    expect(statusLine()).toBe("");
  });

  it("uses no native disabled attribute anywhere in the section", async () => {
    const f = fixture();
    f.available = false;
    renderSection(f.host, "Approvals and tasks");
    expect(document.querySelectorAll("[disabled]")).toHaveLength(0);
  });
});

describe("Task 3 Test 4: the one status line", () => {
  it("has exactly one role=status before its first message, empty, and a section change never fills it", async () => {
    const f = fixture();
    renderSection(f.host, "Approvals and tasks");
    expect(document.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(statusLine()).toBe("");

    fireEvent.click(
      within(screen.getByRole("navigation", { name: "Settings sections" })).getByRole("button", {
        name: "Visual",
      }),
    );
    await flush();
    expect(statusLine()).toBe("");
    expect(document.querySelectorAll('[role="status"]')).toHaveLength(1);
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "Settings sections" })).getByRole("button", {
        name: "Approvals and tasks",
      }),
    );
    await flush();
    expect(statusLine()).toBe("");
  });

  it("the row-level result line is a plain paragraph, so nothing is announced twice", async () => {
    const f = fixture();
    renderSection(f.host, "Approvals and tasks");
    fireEvent.click(screen.getByRole("button", { name: "Rebuild task index" }));
    await flush();
    const result = document.querySelector('[data-result="rebuild"]');
    expect(result?.hasAttribute("role")).toBe(false);
    expect(result?.hasAttribute("aria-live")).toBe(false);
    const live = document.querySelectorAll("[role=status], [aria-live]:not([aria-live=off])");
    expect(live).toHaveLength(1);
    expect(live[0]?.className).toContain("ccc-settings-status");
  });
});

function openSection(name: string): void {
  fireEvent.click(
    within(screen.getByRole("navigation", { name: "Settings sections" })).getByRole("button", {
      name,
    }),
  );
}

describe("FIX2B m4: an action in flight survives a section switch", () => {
  it("a running rebuild is still busy after switching away and back, and cannot be started twice", async () => {
    const f = fixture();
    const pending = deferred<{ tasks: number; attention: number }>();
    f.rebuildTaskIndex.mockReturnValue(pending.promise);
    renderSection(f.host, "Approvals and tasks");
    fireEvent.click(screen.getByRole("button", { name: "Rebuild task index" }));
    await flush();
    expect(f.rebuildTaskIndex).toHaveBeenCalledTimes(1);

    openSection("Visual");
    await flush();
    openSection("Approvals and tasks");
    await flush();
    const button = screen.getByRole("button", { name: "Rebuild task index" });
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(button);
    await flush();
    expect(f.rebuildTaskIndex).toHaveBeenCalledTimes(1);

    pending.resolve({ tasks: 4, attention: 0 });
    await flush();
    expect(button.getAttribute("aria-busy")).toBeNull();
    expect(button.getAttribute("aria-disabled")).toBeNull();
    // The outcome of the run that outlived the section is still on the row.
    expect(document.querySelector('[data-result="rebuild"]')?.textContent).toBe(
      "Task index rebuilt. 4 tasks found.",
    );
  });

  it("a rebuild that finishes while another section is open still posts its outcome and leaves the button idle on return", async () => {
    const f = fixture();
    const pending = deferred<{ tasks: number; attention: number }>();
    f.rebuildTaskIndex.mockReturnValue(pending.promise);
    renderSection(f.host, "Approvals and tasks");
    fireEvent.click(screen.getByRole("button", { name: "Rebuild task index" }));
    await flush();
    openSection("Visual");
    pending.resolve({ tasks: 1, attention: 0 });
    await flush();
    expect(statusLine()).toBe("Task index rebuilt. 1 task found.");
    openSection("Approvals and tasks");
    await flush();
    const button = screen.getByRole("button", { name: "Rebuild task index" });
    expect(button.getAttribute("aria-busy")).toBeNull();
    expect(document.querySelector('[data-result="rebuild"]')?.textContent).toBe(
      "Task index rebuilt. 1 task found.",
    );
  });

  it("a switch whose save is pending is still pending after a section switch, and reverts if the save fails", async () => {
    const f = fixture();
    const save = deferred<void>();
    (f.host.saveSettings as ReturnType<typeof vi.fn>).mockReturnValueOnce(save.promise);
    renderSection(f.host, "Approvals and tasks");
    fireEvent.click(screen.getByRole("switch", { name: "Approval notifications" }));
    await flush();

    openSection("Visual");
    await flush();
    openSection("Approvals and tasks");
    await flush();
    const toggle = screen.getByRole("switch", { name: "Approval notifications" });
    expect(toggle.getAttribute("aria-busy")).toBe("true");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    await flush();
    expect(f.host.saveSettings).toHaveBeenCalledTimes(1);

    save.reject(new Error("disk"));
    await flush();
    expect(toggle.getAttribute("aria-busy")).toBeNull();
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(f.host.settings.notifyApprovals).toBe(true);
  });

  it("a select whose save is pending is still busy after a section switch", async () => {
    const f = fixture();
    const save = deferred<void>();
    (f.host.saveSettings as ReturnType<typeof vi.fn>).mockReturnValueOnce(save.promise);
    renderSection(f.host, "Visual");
    fireEvent.change(screen.getByRole("combobox", { name: "Reduced motion" }), {
      target: { value: "reduced" },
    });
    await flush();

    openSection("Approvals and tasks");
    await flush();
    openSection("Visual");
    await flush();
    const select = screen.getByRole<HTMLSelectElement>("combobox", { name: "Reduced motion" });
    expect(select.getAttribute("aria-busy")).toBe("true");
    expect(select.value).toBe("reduced");
    fireEvent.change(select, { target: { value: "auto" } });
    await flush();
    expect(f.host.saveSettings).toHaveBeenCalledTimes(1);
    expect(select.value).toBe("reduced");

    save.resolve();
    await flush();
    expect(select.getAttribute("aria-busy")).toBeNull();
    expect(select.value).toBe("reduced");
  });
});

describe("Task 3 Test 5: only the four allowed keys are ever saved", () => {
  it("saves exactly socketPathOverride, lastOpenedDestination, reducedMotion and notifyApprovals", async () => {
    const f = fixture();
    renderSection(f.host, "Approvals and tasks");
    fireEvent.click(screen.getByRole("switch", { name: "Approval notifications" }));
    await flush();
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "Settings sections" })).getByRole("button", {
        name: "Visual",
      }),
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Reduced motion" }), {
      target: { value: "reduced" },
    });
    await flush();
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "Settings sections" })).getByRole("button", {
        name: "Approvals and tasks",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Rebuild task index" }));
    await flush();

    expect(f.saves.length).toBe(2);
    for (const keys of f.saves) expect(keys).toEqual(ALLOWED_KEYS);
    expect(Object.keys(f.host.settings).sort()).toEqual(ALLOWED_KEYS);
    expect(() => assertNoPrivatePathValues(f.host.settings)).not.toThrow();
    // No display string is written into the preferences object, whatever the section shows.
    expect(JSON.stringify(f.host.settings)).not.toMatch(/Users|~\//);
  });
});

describe("Visual", () => {
  it("shows the Reduced motion select, its moved description and the dark-look note", async () => {
    renderSection(fixture().host, "Visual");
    await flush();
    expect(screen.getByRole("heading", { level: 3, name: "Visual" })).toBeTruthy();
    expect(screen.getByText("How the command center looks and moves.")).toBeTruthy();
    const select = screen.getByRole<HTMLSelectElement>("combobox", { name: "Reduced motion" });
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "System",
      "Always reduced",
    ]);
    expect(select.value).toBe("auto");
    expect(screen.getByText(REDUCED_MOTION_DESC)).toBeTruthy();
    expect(
      screen.getByText("The command center keeps its dark look in both Obsidian themes."),
    ).toBeTruthy();
  });

  it("applies at once and saves through the same function the native tab uses", async () => {
    const f = fixture();
    renderSection(f.host, "Visual");
    const select = screen.getByRole<HTMLSelectElement>("combobox", { name: "Reduced motion" });
    fireEvent.change(select, { target: { value: "reduced" } });
    await flush();
    expect(f.host.saveSettings).toHaveBeenCalledTimes(1);
    expect(f.host.settings.reducedMotion).toBe("reduced");
    expect(motionMode.value).toBe("reduced");
    expect(select.value).toBe("reduced");
    expect(statusLine()).toBe("");
  });

  it("a failed save restores the previous option, leaves the motion mode and posts the moved string", async () => {
    const f = fixture();
    (f.host.saveSettings as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("disk"));
    renderSection(f.host, "Visual");
    const select = screen.getByRole<HTMLSelectElement>("combobox", { name: "Reduced motion" });
    fireEvent.change(select, { target: { value: "reduced" } });
    await flush();
    expect(select.value).toBe("auto");
    expect(f.host.settings.reducedMotion).toBe("auto");
    expect(motionMode.value).toBe("full");
    expect(statusLine()).toBe(REDUCED_MOTION_SAVE_FAILED);
  });
});
