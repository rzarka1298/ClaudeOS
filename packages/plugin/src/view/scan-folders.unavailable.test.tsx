import {
  EMPTY_PROJECTS_SNAPSHOT,
  newScanRootId,
  type ScanRootId,
  type ScanRootView,
  type ScanStateResponse,
  type SuggestionView,
} from "@ccc/domain";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionState } from "../connection-state.js";
import type { ScanActionOutcome, ScanActions } from "../projects/projects-actions.js";
import { projectsSnapshot, resetProjectsState } from "../projects/projects-state.js";
import { resetScanState, scanState } from "../projects/scan-state.js";
import { createLaunchersSession } from "./launchers-settings.js";
import { ProjectsView } from "./projects-view.js";
import { ScanFolders } from "./scan-folders.js";
import { SettingsDestination } from "./settings-destination.js";
import { createInertSettingsHost } from "./settings-host.js";

/**
 * FIX6B (Codex-4): once the scan folders have loaded, a disconnect keeps their cached state. The
 * Settings Projects section is read-only while the service is away, so every service-dependent
 * control in the scan list is `aria-disabled` (never native `disabled`), described by the one
 * visible reason, and does nothing when pressed. The standalone Projects destination keeps its
 * own away rule (a banner, no per-control guard).
 */

const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const REASON = "The companion service isn't running.";

function root(overrides: Partial<ScanRootView> = {}): ScanRootView {
  return {
    scanRootId: newScanRootId(),
    displayPath: "~/code",
    depth: 1,
    addedAt: "2026-09-30T11:00:00.000Z",
    lastScannedAt: "2026-09-30T11:58:00.000Z",
    scanGeneration: "gen1",
    ...overrides,
  };
}

function suggestionsFor(scanRootId: ScanRootId, count: number): SuggestionView[] {
  return Array.from({ length: count }, (_, i) => ({
    suggestionId: `project${i}`,
    scanRootId,
    folderName: `project-${String(i).padStart(2, "0")}`,
    displayPath: `~/code/project-${String(i).padStart(2, "0")}`,
  }));
}

function actionsWith(overrides: Partial<ScanActions> = {}) {
  const failed = (): Promise<ScanActionOutcome> => Promise.resolve({ kind: "failed" });
  const spies = {
    addScanRoot: vi.fn(failed),
    removeScanRoot: vi.fn(failed),
    rescan: vi.fn(failed),
    listScanState: vi.fn(failed),
    registerSuggestion: vi.fn(() => Promise.resolve({ kind: "failed" as const })),
    dismissSuggestion: vi.fn(() => Promise.resolve({ kind: "failed" as const })),
    suggestionsPage: vi.fn(() => Promise.resolve({ kind: "failed" as const })),
  };
  return { ...spies, ...overrides } as typeof spies & ScanActions;
}

/** 30 suggestions, 60 counted: Show more must fetch (a page is not held). */
function heldAndMore() {
  const a = root({ suggestionCount: 60 });
  const state: ScanStateResponse = {
    scanRoots: [a],
    suggestions: suggestionsFor(a.scanRootId, 25),
    partial: false,
  };
  return state;
}

function Harness({ actions, away }: { readonly actions: ScanActions; readonly away: boolean }) {
  return (
    <>
      <p id="reason">{REASON}</p>
      <ScanFolders
        state={scanState.value}
        actions={actions}
        now={NOW}
        unavailable={away ? { reasonId: "reason" } : undefined}
      />
    </>
  );
}

function renderScan(state: ScanStateResponse, actions: ScanActions, away: boolean) {
  scanState.value = state;
  return render(<Harness actions={actions} away={away} />);
}

afterEach(() => {
  cleanup();
  resetScanState();
  resetProjectsState();
});

function expectBlocked(el: HTMLElement): void {
  expect(el.getAttribute("aria-disabled")).toBe("true");
  expect(el.getAttribute("aria-describedby")).toBe("reason");
  expect(el.hasAttribute("disabled")).toBe(false);
}

describe("FIX6B Codex-4: the scan list while the service is away", () => {
  it("every service-dependent control is aria-disabled, described by the reason, and never natively disabled", () => {
    renderScan(heldAndMore(), actionsWith(), true);
    expectBlocked(screen.getByRole("button", { name: "Register project-00" }));
    expectBlocked(screen.getByRole("button", { name: "Dismiss project-00" }));
    expectBlocked(screen.getByRole("button", { name: "Show 25 more" }));
    expectBlocked(screen.getByRole("button", { name: "Rescan folder" }));
    expectBlocked(screen.getByRole("combobox", { name: "Look this many levels deep" }));
    expectBlocked(screen.getByRole("button", { name: "Stop scanning" }));
    expect(document.querySelectorAll("[disabled]")).toHaveLength(0);
  });

  it("pressing a blocked control sends no request and opens nothing", async () => {
    const actions = actionsWith();
    renderScan(heldAndMore(), actions, true);
    fireEvent.click(screen.getByRole("button", { name: "Register project-00" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss project-00" }));
    fireEvent.click(screen.getByRole("button", { name: "Show 25 more" }));
    fireEvent.click(screen.getByRole("button", { name: "Rescan folder" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop scanning" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(actions.registerSuggestion).not.toHaveBeenCalled();
    expect(actions.dismissSuggestion).not.toHaveBeenCalled();
    expect(actions.suggestionsPage).not.toHaveBeenCalled();
    expect(actions.listScanState).not.toHaveBeenCalled();
    expect(actions.rescan).not.toHaveBeenCalled();
    expect(actions.removeScanRoot).not.toHaveBeenCalled();
    // Stop scanning opened no confirmation, and nothing was announced as scanning.
    expect(screen.queryByRole("button", { name: "Remove scan folder" })).toBeNull();
    expect(screen.queryByText("Scanning…")).toBeNull();
  });

  it("changing the depth does not rescan, and the select keeps what is in effect", async () => {
    const actions = actionsWith();
    renderScan(heldAndMore(), actions, true);
    const select = screen.getByRole("combobox", {
      name: "Look this many levels deep",
    }) as HTMLSelectElement;
    select.value = "3";
    fireEvent.change(select);
    await act(async () => {
      await Promise.resolve();
    });
    expect(actions.rescan).not.toHaveBeenCalled();
    expect(select.value).toBe("1");
  });

  it("a removal confirmation already open when the service goes away cannot be confirmed, but can be dismissed", async () => {
    const actions = actionsWith();
    const state = heldAndMore();
    scanState.value = state;
    const view = render(<Harness actions={actions} away={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop scanning" }));
    view.rerender(<Harness actions={actions} away={true} />);
    const remove = screen.getByRole("button", { name: "Remove scan folder" });
    expectBlocked(remove);
    fireEvent.click(remove);
    await act(async () => {
      await Promise.resolve();
    });
    expect(actions.removeScanRoot).not.toHaveBeenCalled();
    const keep = screen.getByRole("button", { name: "Keep scan folder" });
    expect(keep.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(keep);
    expect(screen.queryByRole("button", { name: "Remove scan folder" })).toBeNull();
  });

  it("showing rows already held is local and stays available", async () => {
    const a = root({ suggestionCount: 30 });
    const all = suggestionsFor(a.scanRootId, 30);
    const actions = actionsWith();
    renderScan({ scanRoots: [a], suggestions: all, partial: false }, actions, true);
    const more = screen.getByRole("button", { name: "Show 5 more" });
    expect(more.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(more);
    expect(screen.getByText("project-29")).toBeTruthy();
    expect(actions.suggestionsPage).not.toHaveBeenCalled();
  });

  it("with the service live no control carries a blocked state, and the requests go out", async () => {
    const actions = actionsWith();
    renderScan(heldAndMore(), actions, false);
    for (const name of ["Rescan folder", "Stop scanning", "Register project-00"]) {
      const el = screen.getByRole("button", { name });
      expect(el.getAttribute("aria-disabled")).toBeNull();
      expect(el.getAttribute("aria-describedby")).toBeNull();
    }
    fireEvent.click(screen.getByRole("button", { name: "Rescan folder" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(actions.rescan).toHaveBeenCalledTimes(1);
  });

  it("controls unblock when the service returns", () => {
    const actions = actionsWith();
    scanState.value = heldAndMore();
    const view = render(<Harness actions={actions} away={true} />);
    expectBlocked(screen.getByRole("button", { name: "Rescan folder" }));
    view.rerender(<Harness actions={actions} away={false} />);
    expect(
      screen.getByRole("button", { name: "Rescan folder" }).getAttribute("aria-disabled"),
    ).toBeNull();
  });
});

describe("FIX6B Codex-4: through the Settings Projects section", () => {
  function settings(connection: ConnectionState, actions: ScanActions) {
    return (
      <SettingsDestination
        settingsHost={createInertSettingsHost()}
        launchersActions={{
          detect: vi.fn(),
          getConfigs: vi.fn(),
          save: vi.fn(),
          test: vi.fn(),
          markTested: vi.fn(),
          openSystemSettings: vi.fn(),
          codexDoctor: vi.fn(),
        }}
        launchersSession={createLaunchersSession()}
        connection={connection}
        now={NOW}
        projectsActions={{
          register: vi.fn(),
          remove: vi.fn(),
          rename: vi.fn(),
          pin: vi.fn(),
          setGithubLink: vi.fn(),
          refresh: vi.fn(),
        }}
        scanActions={actions}
        pickFolder={() => Promise.resolve({ kind: "unavailable" })}
      />
    );
  }

  it("scan folders that loaded while live become read-only on a disconnect, described by the visible reason", async () => {
    const state = heldAndMore();
    const actions = actionsWith({
      listScanState: vi.fn(() => Promise.resolve({ kind: "state", state } as const)),
    });
    const view = render(settings({ kind: "live" }, actions));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const rescanLive = screen.getByRole("button", { name: "Rescan folder" });
    expect(rescanLive.getAttribute("aria-disabled")).toBeNull();

    view.rerender(settings({ kind: "disconnected", reason: "gone" }, actions));
    await act(async () => {
      await Promise.resolve();
    });
    const reason = screen.getAllByText(REASON)[0] as HTMLElement;
    expect(reason.id).not.toBe("");
    const section = reason.closest("section") as HTMLElement;
    for (const name of [
      "Rescan folder",
      "Stop scanning",
      "Register project-00",
      "Dismiss project-00",
      "Show 25 more",
    ]) {
      const el = within(section).getByRole("button", { name });
      expect(el.getAttribute("aria-disabled")).toBe("true");
      expect(el.getAttribute("aria-describedby")).toBe(reason.id);
    }
    fireEvent.click(within(section).getByRole("button", { name: "Rescan folder" }));
    fireEvent.click(within(section).getByRole("button", { name: "Register project-00" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(actions.rescan).not.toHaveBeenCalled();
    expect(actions.registerSuggestion).not.toHaveBeenCalled();
  });
});

describe("FIX6B Codex-4: the standalone Projects destination keeps its own away rule", () => {
  it("while disconnected the banner shows and the scan list is not guarded per control", async () => {
    const state = heldAndMore();
    scanState.value = state;
    projectsSnapshot.value = {
      projects: [],
      launchers: EMPTY_PROJECTS_SNAPSHOT.launchers,
    };
    const actions = actionsWith();
    render(
      <ProjectsView
        actions={{
          register: vi.fn(),
          remove: vi.fn(),
          rename: vi.fn(),
          pin: vi.fn(),
          setGithubLink: vi.fn(),
          refresh: vi.fn(),
        }}
        scanActions={actions}
        pickFolder={() => Promise.resolve({ kind: "unavailable" })}
        connection={{ kind: "disconnected", reason: "gone" }}
        now={NOW}
      />,
    );
    expect(screen.getByText("Service disconnected")).toBeTruthy();
    const rescan = screen.getByRole("button", { name: "Rescan folder" });
    expect(rescan.getAttribute("aria-disabled")).toBeNull();
    expect(rescan.getAttribute("aria-describedby")).toBeNull();
    fireEvent.click(rescan);
    await act(async () => {
      await Promise.resolve();
    });
    expect(actions.rescan).toHaveBeenCalledTimes(1);
  });
});
