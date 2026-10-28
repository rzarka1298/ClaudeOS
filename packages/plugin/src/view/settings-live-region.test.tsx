import { newScanRootId, type ScanStateResponse } from "@ccc/domain";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionState } from "../connection-state.js";
import { configureHealth } from "../health/api.js";
import { resetHealthState } from "../health/state.js";
import type { LaunchersActions } from "../projects/launchers-actions.js";
import type {
  ProjectActionOutcome,
  ProjectsActions,
  ScanActionOutcome,
  ScanActions,
} from "../projects/projects-actions.js";
import { resetProjectsState } from "../projects/projects-state.js";
import { resetScanState } from "../projects/scan-state.js";
import { allOkHealth } from "../test-support/health-fixtures.js";
import { fakeLaunchersActions } from "../test-support/launchers-fixtures.js";
import { createLaunchersSession } from "./launchers-settings.js";
import { SECTION_VIEWS, SettingsDestination } from "./settings-destination.js";
import { createInertSettingsHost, type SettingsHost } from "./settings-host.js";
import { SETTINGS_SECTION_LABELS, takeSettingsSectionRequest } from "./settings-sections.js";

/**
 * FIX2B M1 and m1: the Settings destination has ONE live region. Every flow it embeds renders
 * its status as a plain paragraph and routes the words through the destination's `notify`, so a
 * register, a scan or a launcher outcome is announced once, by the one status line, and a
 * repeated identical message is announced again.
 */

const FAILED = (): Promise<{ kind: "failed" }> => Promise.resolve({ kind: "failed" });
const NOW = Date.parse("2026-10-22T10:00:00.000Z");
const LIVE_REGIONS = "[role=status], [aria-live]:not([aria-live=off])";

const ROOT_ID = newScanRootId();
const ONE_FOLDER: ScanStateResponse = {
  scanRoots: [
    {
      scanRootId: ROOT_ID,
      displayPath: "~/ExampleCode",
      depth: 1,
      addedAt: "2026-10-20T10:00:00.000Z",
      lastScannedAt: "2026-10-20T10:00:00.000Z",
      suggestionCount: 0,
    },
  ],
  suggestions: [],
  partial: false,
};

function projectsActions(overrides: Partial<ProjectsActions> = {}): ProjectsActions {
  return {
    register: FAILED,
    remove: FAILED,
    rename: FAILED,
    pin: FAILED,
    setGithubLink: FAILED,
    refresh: FAILED,
    ...overrides,
  };
}

function scanActions(overrides: Partial<ScanActions> = {}): ScanActions {
  return {
    addScanRoot: FAILED,
    removeScanRoot: FAILED,
    rescan: FAILED,
    listScanState: () => Promise.resolve({ kind: "state", state: ONE_FOLDER }),
    registerSuggestion: FAILED,
    dismissSuggestion: FAILED,
    suggestionsPage: FAILED,
    ...overrides,
  };
}

interface Options {
  readonly host?: SettingsHost;
  readonly projects?: ProjectsActions;
  readonly scan?: ScanActions;
  readonly launchers?: LaunchersActions;
}

function renderSettings(options: Options = {}) {
  return render(
    <SettingsDestination
      settingsHost={options.host ?? createInertSettingsHost()}
      launchersActions={options.launchers ?? fakeLaunchersActions()}
      launchersSession={createLaunchersSession()}
      connection={{ kind: "live" }}
      now={NOW}
      projectsActions={options.projects ?? projectsActions()}
      scanActions={options.scan ?? scanActions()}
      pickFolder={() => Promise.resolve({ kind: "unavailable" })}
    />,
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
  });
}

function openSection(label: string): void {
  fireEvent.click(
    within(screen.getByRole("navigation", { name: "Settings sections" })).getByRole("button", {
      name: label,
    }),
  );
}

function statusEl(): HTMLElement {
  const element = document.querySelector<HTMLElement>(".ccc-settings-status");
  if (element === null) throw new Error("no status line");
  return element;
}

/** Every text the one status line takes, in order, empty states included. */
function watchStatus(): { readonly log: string[]; stop: () => void } {
  const log: string[] = [];
  const observer = new MutationObserver(() => log.push(statusEl().textContent ?? ""));
  observer.observe(statusEl(), { childList: true, characterData: true, subtree: true });
  return { log, stop: () => observer.disconnect() };
}

function liveRegions(): Element[] {
  return [...(document.querySelector(".ccc-settings")?.querySelectorAll(LIVE_REGIONS) ?? [])];
}

beforeEach(() => {
  resetScanState();
  connectionState.value = { kind: "live" };
});

afterEach(() => {
  cleanup();
  resetHealthState();
  configureHealth(null);
  resetScanState();
  resetProjectsState();
  connectionState.value = { kind: "connecting" };
  takeSettingsSectionRequest();
});

describe("M1: exactly one live region in the Settings destination", () => {
  const ids = Object.keys(SECTION_VIEWS) as (keyof typeof SETTINGS_SECTION_LABELS)[];

  // D-09: Diagnostics holds exactly two (the destination line and the bundle block's own line);
  // every other section holds exactly one.
  it.each(ids)("%s: the destination holds its live regions, before and after use", async (id) => {
    renderSettings();
    openSection(SETTINGS_SECTION_LABELS[id]);
    await settle();
    const expected =
      id === "diagnostics"
        ? ["ccc-settings-status", "ccc-settings-status"]
        : ["ccc-settings-status"];
    expect(liveRegions().map((el) => el.className || el.tagName)).toEqual(expected);
    if (id === "diagnostics") {
      expect(liveRegions().map((el) => el.getAttribute("data-status-region"))).toEqual([
        null,
        "bundle",
      ]);
    }
  });

  it("Diagnostics: Copy bundle is announced once, by the bundle line, and the destination line stays silent", async () => {
    configureHealth({ api: { get: () => Promise.resolve(allOkHealth()) } });
    const copyText = vi.fn(() => Promise.resolve());
    const base = createInertSettingsHost();
    const host: SettingsHost = {
      ...base,
      copyText,
      display: {
        ...base.display,
        pluginVersion: "0.1.0",
        obsidianVersion: "1.13.1",
        vaultName: "Marrowvault",
        userName: "zinnia-example",
        vaultBasePath: null,
      },
    };
    renderSettings({ host });
    openSection("Diagnostics");
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Show bundle preview" }));
    await settle();
    const bundle = document.querySelector<HTMLElement>('[data-status-region="bundle"]');
    if (bundle === null) throw new Error("no bundle line");
    const bundleLog: string[] = [];
    const observer = new MutationObserver(() => bundleLog.push(bundle.textContent ?? ""));
    observer.observe(bundle, { childList: true, characterData: true, subtree: true });
    const destination = watchStatus();
    fireEvent.click(screen.getByRole("button", { name: "Copy bundle" }));
    await settle();
    observer.disconnect();
    destination.stop();
    expect(bundleLog.filter((text) => text === "Bundle copied.")).toHaveLength(1);
    expect(destination.log.filter((text) => text === "Bundle copied.")).toHaveLength(0);
    expect(statusEl().textContent).toBe("");
  });

  it("the Projects section keeps one live region while a register fails and a scan runs", async () => {
    renderSettings({ projects: projectsActions({ register: FAILED }) });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Type a path instead" }));
    fireEvent.input(screen.getByLabelText("Folder path"), {
      target: { value: "/Users/USERNAME/code/demo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Register folder" }));
    await settle();
    expect(liveRegions()).toHaveLength(1);
  });
});

describe("M1: register, scan and launcher outcomes are announced once", () => {
  it("a registered project reaches the status line once, in the flow's own words", async () => {
    const register = vi.fn(
      (): Promise<ProjectActionOutcome> =>
        Promise.resolve({ kind: "registered", projectId: "p" as never }),
    );
    renderSettings({ projects: projectsActions({ register }) });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Type a path instead" }));
    fireEvent.input(screen.getByLabelText("Folder path"), {
      target: { value: "/Users/USERNAME/code/demo" },
    });
    const watch = watchStatus();
    fireEvent.click(screen.getByRole("button", { name: "Register folder" }));
    await settle();
    watch.stop();
    expect(watch.log.filter((text) => text === "Registered demo.")).toHaveLength(1);
    expect(watch.log).not.toContain("Project registered.");
    expect(statusEl().textContent).toBe("Registered demo.");
    // The flow still shows its words, as a plain paragraph.
    const flowLine = screen
      .getAllByText("Registered demo.")
      .find((el) => !el.classList.contains("ccc-settings-status"));
    expect(flowLine?.getAttribute("role")).toBeNull();
  });

  it("a failed Add a scan folder is announced once", async () => {
    renderSettings();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Type a path instead for a scan folder" }));
    fireEvent.input(screen.getByLabelText("Folder path"), {
      target: { value: "/Users/USERNAME/code" },
    });
    const watch = watchStatus();
    fireEvent.click(screen.getByRole("button", { name: "Add scan folder" }));
    await settle();
    watch.stop();
    const problem = watch.log.filter((text) => text.includes("Couldn't reach"));
    expect(problem).toHaveLength(1);
  });

  it("a finished rescan is announced once", async () => {
    const rescan = vi.fn(
      (): Promise<ScanActionOutcome> => Promise.resolve({ kind: "state", state: ONE_FOLDER }),
    );
    renderSettings({ scan: scanActions({ rescan }) });
    await settle();
    const watch = watchStatus();
    fireEvent.click(screen.getByRole("button", { name: "Rescan folder" }));
    await settle();
    watch.stop();
    expect(rescan).toHaveBeenCalledTimes(1);
    expect(watch.log.filter((text) => text === "No new Git folders found.")).toHaveLength(1);
  });

  it("Detect apps is announced once, and opening the section announces nothing", async () => {
    renderSettings({ launchers: fakeLaunchersActions() });
    const watch = watchStatus();
    openSection("Launchers");
    await settle();
    expect(watch.log.filter((text) => text !== "")).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Detect apps" }));
    await settle();
    watch.stop();
    expect(watch.log.filter((text) => text === "Detected 5 minutes ago")).toHaveLength(0);
    expect(watch.log.filter((text) => text.startsWith("Detected "))).toHaveLength(1);
  });

  it("a launcher Test outcome is announced once", async () => {
    renderSettings({ launchers: fakeLaunchersActions() });
    openSection("Launchers");
    await settle();
    const watch = watchStatus();
    fireEvent.click(screen.getByRole("button", { name: "Test the Finder launcher" }));
    await settle();
    watch.stop();
    const texts = watch.log.filter((text) => text !== "");
    expect(texts.length).toBeGreaterThan(0);
    expect(new Set(texts).size).toBe(texts.length);
  });
});

describe("m1: the status line clears on a section change and a repeat is announced again", () => {
  function rebuildHost(): SettingsHost {
    const base = createInertSettingsHost();
    return {
      ...base,
      tasks: {
        rebuildTaskIndex: vi.fn(() => Promise.resolve({ tasks: 3, attention: 0 })),
        serviceAvailable: () => true,
      },
    };
  }

  it("clears the status line when a section is activated", async () => {
    renderSettings({ host: rebuildHost() });
    openSection("Approvals and tasks");
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Rebuild task index" }));
    await settle();
    expect(statusEl().textContent).toBe("Task index rebuilt. 3 tasks found.");
    openSection("Visual");
    await settle();
    expect(statusEl().textContent).toBe("");
  });

  it("an identical message twice in a row is cleared and set again, so it is announced again", async () => {
    const base = createInertSettingsHost();
    const host: SettingsHost = {
      ...base,
      saveSettings: vi.fn(() => Promise.reject(new Error("disk"))),
    };
    renderSettings({ host });
    openSection("Approvals and tasks");
    await settle();
    const toggle = screen.getByRole("switch", { name: "Approval notifications" });
    fireEvent.click(toggle);
    await settle();
    const message = statusEl().textContent ?? "";
    expect(message).not.toBe("");

    const watch = watchStatus();
    fireEvent.click(toggle);
    await settle();
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 120));
    });
    watch.stop();
    // The same words again: the line went empty first, so a screen reader hears them anew.
    expect(watch.log).toEqual(["", message]);
    expect(statusEl().textContent).toBe(message);
  });
});
