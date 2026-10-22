import { newProjectId, newScanRootId, type ScanStateResponse } from "@ccc/domain";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionState } from "../connection-state.js";
import { connectionState } from "../connection-state.js";
import type { FolderPick } from "../projects/folder-picker.js";
import type { LaunchersActions } from "../projects/launchers-actions.js";
import type {
  ProjectActionOutcome,
  ProjectsActions,
  ScanActionOutcome,
  ScanActions,
} from "../projects/projects-actions.js";
import { resetProjectsState } from "../projects/projects-state.js";
import { resetScanState } from "../projects/scan-state.js";
import { createLaunchersSession } from "./launchers-settings.js";
import { navigationRequest } from "./navigation-request.js";
import { SettingsDestination } from "./settings-destination.js";
import { createInertSettingsHost } from "./settings-host.js";
import { takeSettingsSectionRequest } from "./settings-sections.js";
import { Shell } from "./shell.js";

/**
 * The Projects section of the Settings destination (plan 08-11 Task 2; 08-UI-SPEC S2 Projects,
 * G2): the register flow, Add a scan folder and the scan list from the Projects destination, a
 * `Project registered.` outcome in the one status line, a link to the Projects destination, and
 * both forms `aria-disabled` with a visible reason while the service is away.
 */

const FAILED = (): Promise<{ kind: "failed" }> => Promise.resolve({ kind: "failed" });
const NEVER = (): Promise<never> => new Promise<never>(() => {});

const EMPTY_SCAN: ScanStateResponse = { scanRoots: [], suggestions: [], partial: false };
const WITH_ONE_FOLDER: ScanStateResponse = {
  scanRoots: [
    {
      scanRootId: newScanRootId(),
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

function scanActions(listScanState: () => Promise<ScanActionOutcome>): ScanActions {
  return {
    addScanRoot: FAILED,
    removeScanRoot: FAILED,
    rescan: FAILED,
    listScanState,
    registerSuggestion: FAILED,
    dismissSuggestion: FAILED,
    suggestionsPage: FAILED,
  };
}

const NO_LAUNCHERS: LaunchersActions = {
  detect: NEVER,
  getConfigs: NEVER,
  save: vi.fn(),
  test: vi.fn(),
  markTested: vi.fn(),
  openSystemSettings: vi.fn(),
  codexDoctor: vi.fn(),
};

interface Options {
  readonly connection?: ConnectionState;
  readonly projects?: ProjectsActions;
  readonly scan?: ScanActions;
  readonly pickFolder?: () => Promise<FolderPick>;
}

function renderSettings(options: Options = {}) {
  return render(
    <SettingsDestination
      settingsHost={createInertSettingsHost()}
      launchersActions={NO_LAUNCHERS}
      launchersSession={createLaunchersSession()}
      connection={options.connection ?? { kind: "live" }}
      now={Date.parse("2026-10-22T10:00:00.000Z")}
      projectsActions={options.projects ?? projectsActions()}
      scanActions={
        options.scan ?? scanActions(() => Promise.resolve({ kind: "state", state: EMPTY_SCAN }))
      }
      pickFolder={options.pickFolder ?? (() => Promise.resolve({ kind: "unavailable" }))}
    />,
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function statusLine(): string {
  return document.querySelector(".ccc-settings-status")?.textContent ?? "";
}

const AWAY = "The companion service isn't running.";

beforeEach(() => {
  resetScanState();
});

afterEach(() => {
  cleanup();
  resetScanState();
  resetProjectsState();
  connectionState.value = { kind: "connecting" };
  takeSettingsSectionRequest();
  navigationRequest.value = null;
});

describe("Task 2: Projects in Settings, with the register flow, scan folders and the disconnected state", () => {
  it("Test 1: shows the description, the register flow, Add a scan folder and the scan list", async () => {
    renderSettings({
      scan: scanActions(() => Promise.resolve({ kind: "state", state: WITH_ONE_FOLDER })),
    });
    await settle();
    expect(screen.getByRole("heading", { level: 3, name: "Projects" })).toBeTruthy();
    expect(
      screen.getByText("Register project folders and choose folders to scan for projects."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Register a project" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add a scan folder" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Scan folders" })).toBeTruthy();
    expect(screen.getByText("~/ExampleCode")).toBeTruthy();
  });

  it("Test 1: registering a typed path calls the action, says Project registered. and offers the Projects destination", async () => {
    const register = vi.fn(
      (): Promise<ProjectActionOutcome> =>
        Promise.resolve({ kind: "registered", projectId: newProjectId() }),
    );
    renderSettings({ projects: projectsActions({ register }) });
    await settle();
    expect(statusLine()).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Type a path instead" }));
    fireEvent.input(screen.getByLabelText("Folder path"), {
      target: { value: "/Users/example/code/demo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Register folder" }));
    await settle();

    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith("/Users/example/code/demo");
    expect(statusLine()).toBe("Project registered.");

    const link = screen.getByRole("button", { name: "Go to the projects view" });
    expect(link.className).toContain("ccc-list-more");
    fireEvent.click(link);
    expect(navigationRequest.value?.destination).toBe("projects");
  });

  it("Test 2: while the scan state loads, three skeleton lines show under the real heading, aria-busy, with hidden text", () => {
    renderSettings({ scan: scanActions(NEVER) });
    expect(screen.getByRole("heading", { level: 3, name: "Projects" })).toBeTruthy();
    const busy = document.querySelector('[aria-busy="true"]');
    expect(busy).not.toBeNull();
    expect(busy?.querySelectorAll(".ccc-skeleton-line")).toHaveLength(3);
    const hidden = busy?.querySelector(".ccc-visually-hidden");
    expect(hidden?.textContent).toBe("Loading projects");
    // Nothing claims there are no scan folders while the answer is on its way.
    expect(screen.queryByText("No scan folders yet.")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Scan folders" })).toBeNull();
  });

  it("Test 2: a scan state that cannot be read keeps the existing triangle line, and the forms stay usable", async () => {
    renderSettings({ scan: scanActions(FAILED) });
    await settle();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
    expect(
      screen.getByText(
        "▲ Couldn't load projects. Check the service in Settings → Diagnostics, then refresh.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Register a project" }).getAttribute("aria-disabled"),
    ).toBeNull();
  });

  it("Test 2: a failed register keeps the existing triangle line and the submit button as the retry", async () => {
    renderSettings({ projects: projectsActions({ register: FAILED }) });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Type a path instead" }));
    fireEvent.input(screen.getByLabelText("Folder path"), {
      target: { value: "/Users/example/code/demo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Register folder" }));
    await settle();
    expect(screen.getByText(/Couldn't register this folder\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Register folder" })).toBeTruthy();
    // A failed register is not a success: the destination status line stays quiet.
    expect(statusLine()).toBe("");
  });

  it("Test 3: with the service disconnected the note says the sections are read-only and both forms are aria-disabled with a visible reason", async () => {
    const pickFolder = vi.fn(() => Promise.resolve({ kind: "unavailable" as const }));
    renderSettings({ connection: { kind: "disconnected", reason: "gone" }, pickFolder });
    await settle();

    expect(
      screen.getByText(
        "Projects, launchers and paths are managed by the companion service, which isn't running. They are read-only until it is back.",
      ),
    ).toBeTruthy();

    const reason = screen.getByText(AWAY);
    expect(reason.id).not.toBe("");
    for (const name of ["Register a project", "Add a scan folder"]) {
      const button = screen.getByRole("button", { name });
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(button.getAttribute("aria-describedby")).toBe(reason.id);
      expect(button.hasAttribute("disabled")).toBe(false);
    }
    const typeLinks = screen.getAllByRole("button", { name: /Type a path instead/ });
    expect(typeLinks).toHaveLength(2);
    for (const link of typeLinks) {
      expect(link.getAttribute("aria-disabled")).toBe("true");
      expect(link.getAttribute("aria-describedby")).toBe(reason.id);
    }

    // Activating a blocked control does nothing: no folder dialog, no form.
    fireEvent.click(screen.getByRole("button", { name: "Register a project" }));
    fireEvent.click(screen.getByRole("button", { name: "Add a scan folder" }));
    fireEvent.click(typeLinks[0] as HTMLElement);
    await settle();
    expect(pickFolder).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Folder path")).toBeNull();

    // Nothing in the section uses the native disabled attribute.
    expect(document.querySelectorAll("[disabled]")).toHaveLength(0);
  });

  it("Test 3: with the service live there is no note and the forms carry no disabled state", async () => {
    renderSettings();
    await settle();
    expect(screen.queryByText(AWAY)).toBeNull();
    expect(screen.queryByText(/read-only until it is back/)).toBeNull();
    for (const name of ["Register a project", "Add a scan folder"]) {
      const button = screen.getByRole("button", { name });
      expect(button.getAttribute("aria-disabled")).toBeNull();
      expect(button.getAttribute("aria-describedby")).toBeNull();
    }
  });

  it("Test 3: a form already open when the service goes away cannot be submitted", async () => {
    const register = vi.fn(
      (): Promise<ProjectActionOutcome> =>
        Promise.resolve({ kind: "registered", projectId: newProjectId() }),
    );
    const view = renderSettings({ projects: projectsActions({ register }) });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Type a path instead" }));
    fireEvent.input(screen.getByLabelText("Folder path"), {
      target: { value: "/Users/example/code/demo" },
    });
    view.rerender(
      <SettingsDestination
        settingsHost={createInertSettingsHost()}
        launchersActions={NO_LAUNCHERS}
        launchersSession={createLaunchersSession()}
        connection={{ kind: "disconnected", reason: "gone" }}
        now={Date.parse("2026-10-22T10:00:00.000Z")}
        projectsActions={projectsActions({ register })}
        scanActions={scanActions(() => Promise.resolve({ kind: "state", state: EMPTY_SCAN }))}
        pickFolder={() => Promise.resolve({ kind: "unavailable" })}
      />,
    );
    await settle();
    const submit = screen.getByRole("button", { name: "Register folder" });
    expect(submit.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(submit);
    await settle();
    expect(register).not.toHaveBeenCalled();
  });

  it("Test 4: the Projects destination still renders its own register block and loads the scan state once", async () => {
    connectionState.value = { kind: "live" };
    const listScanState = vi.fn(() =>
      Promise.resolve({ kind: "state", state: EMPTY_SCAN } as const),
    );
    render(<Shell initialDestination="projects" scanActions={scanActions(listScanState)} />);
    await settle();
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByRole("button", { name: "Register a project" })).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "Add a scan folder" })).toBeTruthy();
    expect(listScanState).toHaveBeenCalledTimes(1);
  });

  it("Test 4: opening Settings from the Shell mounts Projects with the shell's own actions", async () => {
    connectionState.value = { kind: "live" };
    const listScanState = vi.fn(() =>
      Promise.resolve({ kind: "state", state: EMPTY_SCAN } as const),
    );
    render(<Shell initialDestination="settings" scanActions={scanActions(listScanState)} />);
    await settle();
    expect(screen.getByRole("button", { name: "Register a project" })).toBeTruthy();
    expect(listScanState).toHaveBeenCalledTimes(1);
  });
});
