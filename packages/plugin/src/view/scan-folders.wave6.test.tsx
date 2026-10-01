import {
  newScanRootId,
  type ScanRootId,
  type ScanRootView,
  type ScanStateResponse,
  type SuggestionView,
} from "@ccc/domain";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FolderPick } from "../projects/folder-picker.js";
import type {
  ProjectActionOutcome,
  ScanActionOutcome,
  ScanActions,
} from "../projects/projects-actions.js";
import { resetScanState, scanState } from "../projects/scan-state.js";
import { AddScanFolderFlow, ScanFolders } from "./scan-folders.js";

/**
 * Wave-6 review findings on S5: honest partial-scan copy (1), the refused
 * scan folder (3), resync after a failed add or rescan (4), in-flight guards
 * and the 404 register copy (6), focus after every action (8) and the depth
 * select reverting when its rescan does not happen (9). Synthetic names and
 * `~/…` display paths only.
 */

const NOW = Date.parse("2026-09-30T12:00:00.000Z");

function root(overrides: Partial<ScanRootView> = {}): ScanRootView {
  return {
    scanRootId: newScanRootId(),
    displayPath: "~/code",
    depth: 1,
    addedAt: "2026-09-30T11:00:00.000Z",
    lastScannedAt: "2026-09-30T11:58:00.000Z",
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

function stateOf(
  scanRoots: ScanRootView[],
  suggestions: SuggestionView[] = [],
  partial = false,
): ScanStateResponse {
  return { scanRoots, suggestions, partial };
}

function actionsWith(overrides: Partial<ScanActions> = {}): ScanActions {
  const failed = (): Promise<ScanActionOutcome> => Promise.resolve({ kind: "failed" });
  return {
    addScanRoot: failed,
    removeScanRoot: failed,
    rescan: failed,
    listScanState: failed,
    registerSuggestion: () => Promise.resolve({ kind: "failed" }),
    dismissSuggestion: () => Promise.resolve({ kind: "failed" }),
    ...overrides,
  };
}

function renderLive(state: ScanStateResponse | undefined, actions: ScanActions) {
  scanState.value = state;
  function Live() {
    return <ScanFolders state={scanState.value} actions={actions} now={NOW} />;
  }
  return render(<Live />);
}

function rowFor(displayPath: string): HTMLElement {
  const row = screen
    .getAllByRole("listitem")
    .find(
      (item) =>
        item.classList.contains("ccc-scan-folder-row") && item.textContent?.includes(displayPath),
    );
  if (row === undefined) throw new Error(`no scan folder row for ${displayPath}`);
  return row;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  resetScanState();
});

describe("partial scans are said out loud (finding 1)", () => {
  it("a partial scan folder row says the scan stopped early, with the next step", () => {
    renderLive(stateOf([root({ scanStatus: "partial" })], [], true), actionsWith());
    const row = rowFor("~/code");
    expect(
      within(row).getByText("The last scan stopped early, so some folders weren't checked."),
    ).toBeTruthy();
    expect(
      within(row).getByText("Choose Rescan folder to try again, or look fewer levels deep."),
    ).toBeTruthy();
  });

  it("a partial rescan with nothing new never reads No new Git folders found.", async () => {
    const a = root();
    const rescan = vi.fn<ScanActions["rescan"]>().mockResolvedValue({
      kind: "state",
      state: stateOf([{ ...a, scanStatus: "partial" }], [], true),
    });
    renderLive(stateOf([a]), actionsWith({ rescan }));
    fireEvent.click(screen.getByRole("button", { name: "Rescan folder" }));
    expect(
      await screen.findByText("No new Git folders found before the scan stopped."),
    ).toBeTruthy();
    expect(screen.queryByText("No new Git folders found.")).toBeNull();
  });

  it("a partial rescan that found some names the count before the scan stopped", async () => {
    const a = root();
    const rescan = vi.fn<ScanActions["rescan"]>().mockResolvedValue({
      kind: "state",
      state: stateOf([{ ...a, scanStatus: "partial" }], suggestionsFor(a.scanRootId, 2), true),
    });
    renderLive(stateOf([a]), actionsWith({ rescan }));
    fireEvent.click(screen.getByRole("button", { name: "Rescan folder" }));
    expect(await screen.findByText("Found 2 new Git folders before the scan stopped")).toBeTruthy();
  });

  it("no suggestions after a partial scan does not claim every folder was checked", () => {
    renderLive(stateOf([root({ scanStatus: "partial" })], [], true), actionsWith());
    expect(screen.getByText("No suggestions.")).toBeTruthy();
    expect(
      screen.getByText(
        "Every Git folder found is already registered, or none were found. A scan stopped early, so some folders weren't checked.",
      ),
    ).toBeTruthy();
  });

  it("suggestions after a partial scan say the list may be incomplete", () => {
    const a = root({ scanStatus: "partial" });
    renderLive(stateOf([a], suggestionsFor(a.scanRootId, 2), true), actionsWith());
    expect(screen.getByText("A scan stopped early, so this list may be incomplete.")).toBeTruthy();
  });
});

describe("a scan folder the policy now refuses (finding 3)", () => {
  const REFUSED_PROBLEM = "Couldn't scan this folder.";
  const REFUSED_NEXT =
    "It now overlaps the managed vault or a system folder. Choose Stop scanning to remove it.";

  it("a refused scan folder row says so, with Stop scanning as the next step", () => {
    renderLive(stateOf([root({ scanStatus: "refused" })]), actionsWith());
    expect(screen.getByText(REFUSED_PROBLEM)).toBeTruthy();
    expect(screen.getByText(REFUSED_NEXT)).toBeTruthy();
  });

  it("a refused rescan shows the refusal, not a service problem, once", async () => {
    const a = root();
    const rescan = vi.fn<ScanActions["rescan"]>().mockResolvedValue({ kind: "refused" });
    const listScanState = vi
      .fn<ScanActions["listScanState"]>()
      .mockResolvedValue({ kind: "state", state: stateOf([{ ...a, scanStatus: "refused" }]) });
    renderLive(stateOf([a]), actionsWith({ rescan, listScanState }));
    fireEvent.click(screen.getByRole("button", { name: "Rescan folder" }));
    expect(await screen.findByText(REFUSED_NEXT)).toBeTruthy();
    await waitFor(() => expect(listScanState).toHaveBeenCalled());
    expect(screen.getAllByText(REFUSED_NEXT)).toHaveLength(1);
    expect(screen.queryByText("Couldn't reach the command center service.")).toBeNull();
  });
});

describe("resync after a failed add or rescan (finding 4)", () => {
  it("a failed rescan re-reads the scan state", async () => {
    const a = root();
    const listed = stateOf([{ ...a, depth: 2 }]);
    const listScanState = vi
      .fn<ScanActions["listScanState"]>()
      .mockResolvedValue({ kind: "state", state: listed });
    renderLive(stateOf([a]), actionsWith({ listScanState }));
    fireEvent.click(screen.getByRole("button", { name: "Rescan folder" }));
    await waitFor(() => expect(listScanState).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(scanState.value).toEqual(listed));
  });

  it("a failed (timed-out) add re-reads the scan state", async () => {
    const listed = stateOf([root()]);
    const listScanState = vi
      .fn<ScanActions["listScanState"]>()
      .mockResolvedValue({ kind: "state", state: listed });
    const addScanRoot = vi.fn<ScanActions["addScanRoot"]>().mockResolvedValue({ kind: "failed" });
    render(
      <AddScanFolderFlow
        actions={actionsWith({ addScanRoot, listScanState })}
        pickFolder={() =>
          Promise.resolve<FolderPick>({ kind: "picked", path: "/Users/USERNAME/code" })
        }
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add a scan folder" }));
    expect(await screen.findByText("Couldn't reach the command center service.")).toBeTruthy();
    await waitFor(() => expect(listScanState).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(scanState.value).toEqual(listed));
  });
});

describe("in-flight guards and the 404 register copy (finding 6)", () => {
  it("Register sends once while its request is in flight", async () => {
    const a = root();
    const pending = deferred<ProjectActionOutcome>();
    const registerSuggestion = vi
      .fn<ScanActions["registerSuggestion"]>()
      .mockReturnValue(pending.promise);
    renderLive(stateOf([a], suggestionsFor(a.scanRootId, 2)), actionsWith({ registerSuggestion }));
    const button = screen.getByRole("button", { name: "Register project-00" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(registerSuggestion).toHaveBeenCalledTimes(1);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    await act(async () => pending.resolve({ kind: "failed" }));
  });

  it("Dismiss sends once while its request is in flight", async () => {
    const a = root();
    const pending = deferred<ProjectActionOutcome>();
    const dismissSuggestion = vi
      .fn<ScanActions["dismissSuggestion"]>()
      .mockReturnValue(pending.promise);
    renderLive(stateOf([a], suggestionsFor(a.scanRootId, 2)), actionsWith({ dismissSuggestion }));
    const button = screen.getByRole("button", { name: "Dismiss project-00" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(dismissSuggestion).toHaveBeenCalledTimes(1);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    await act(async () => pending.resolve({ kind: "failed" }));
  });

  it("Remove scan folder sends once while its request is in flight", async () => {
    const a = root();
    const pending = deferred<ScanActionOutcome>();
    const removeScanRoot = vi.fn<ScanActions["removeScanRoot"]>().mockReturnValue(pending.promise);
    renderLive(stateOf([a]), actionsWith({ removeScanRoot }));
    fireEvent.click(screen.getByRole("button", { name: "Stop scanning" }));
    const remove = screen.getByRole("button", { name: "Remove scan folder" });
    fireEvent.click(remove);
    fireEvent.click(remove);
    expect(removeScanRoot).toHaveBeenCalledTimes(1);
    expect(remove.getAttribute("aria-disabled")).toBe("true");
    await act(async () => pending.resolve({ kind: "failed" }));
  });

  it("a suggestion that is already gone (404) gets its own copy and the list is re-read", async () => {
    const a = root();
    const listScanState = vi
      .fn<ScanActions["listScanState"]>()
      .mockResolvedValue({ kind: "state", state: stateOf([a]) });
    const registerSuggestion = vi
      .fn<ScanActions["registerSuggestion"]>()
      .mockResolvedValue({ kind: "not-found" } as unknown as ProjectActionOutcome);
    renderLive(
      stateOf([a], suggestionsFor(a.scanRootId, 1)),
      actionsWith({ registerSuggestion, listScanState }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Register project-00" }));
    expect(await screen.findByText("This suggestion is no longer available.")).toBeTruthy();
    expect(screen.getByText("Choose Rescan folder to refresh the suggestions.")).toBeTruthy();
    expect(screen.queryByText("Couldn't reach the command center service.")).toBeNull();
    await waitFor(() => expect(listScanState).toHaveBeenCalledTimes(1));
  });
});

describe("focus after each action (finding 8)", () => {
  it("a successful add returns focus to Add a scan folder", async () => {
    const addScanRoot = vi
      .fn<ScanActions["addScanRoot"]>()
      .mockResolvedValue({ kind: "state", state: stateOf([root()]) });
    render(
      <AddScanFolderFlow
        actions={actionsWith({ addScanRoot })}
        pickFolder={() =>
          Promise.resolve<FolderPick>({ kind: "picked", path: "/Users/USERNAME/code" })
        }
      />,
    );
    const opener = screen.getByRole("button", { name: "Add a scan folder" });
    fireEvent.click(opener);
    await waitFor(() => expect(addScanRoot).toHaveBeenCalled());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("a successful typed-path add returns focus to Add a scan folder", async () => {
    const addScanRoot = vi
      .fn<ScanActions["addScanRoot"]>()
      .mockResolvedValue({ kind: "state", state: stateOf([root()]) });
    render(
      <AddScanFolderFlow
        actions={actionsWith({ addScanRoot })}
        pickFolder={() => Promise.resolve<FolderPick>({ kind: "cancelled" })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Type a path instead for a scan folder" }));
    const input = screen.getByLabelText("Folder path");
    fireEvent.input(input, { target: { value: "/Users/USERNAME/code" } });
    input.focus();
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() => expect(addScanRoot).toHaveBeenCalled());
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Add a scan folder" }),
      ),
    );
  });

  it("the protected-location step takes focus on its heading", async () => {
    const addScanRoot = vi.fn<ScanActions["addScanRoot"]>().mockResolvedValue({
      kind: "state",
      state: { ...stateOf([]), protectedLocation: "documents" },
    });
    render(
      <AddScanFolderFlow
        actions={actionsWith({ addScanRoot })}
        pickFolder={() =>
          Promise.resolve<FolderPick>({ kind: "picked", path: "/Users/USERNAME/Documents/code" })
        }
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add a scan folder" }));
    const heading = await screen.findByText("This folder is in Documents");
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it("Register moves focus to the next suggestion, then to the Suggestions heading", async () => {
    const a = root();
    const all = suggestionsFor(a.scanRootId, 2);
    const registerSuggestion = vi
      .fn<ScanActions["registerSuggestion"]>()
      .mockResolvedValue({ kind: "registered", projectId: "0000000000abcdefabcdefabc" as never });
    const listScanState = vi
      .fn<ScanActions["listScanState"]>()
      .mockResolvedValueOnce({ kind: "state", state: stateOf([a], all.slice(1)) })
      .mockResolvedValueOnce({ kind: "state", state: stateOf([a]) });
    renderLive(stateOf([a], all), actionsWith({ registerSuggestion, listScanState }));
    const first = screen.getByRole("button", { name: "Register project-00" });
    first.focus();
    fireEvent.click(first);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Register project-01" }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Register project-01" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { level: 3, name: "Suggestions" }),
      ),
    );
  });

  it("Dismiss moves focus to the next suggestion, then to the Suggestions heading", async () => {
    const a = root();
    const dismissSuggestion = vi
      .fn<ScanActions["dismissSuggestion"]>()
      .mockResolvedValue({ kind: "ok" });
    renderLive(stateOf([a], suggestionsFor(a.scanRootId, 2)), actionsWith({ dismissSuggestion }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss project-00" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Register project-01" }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss project-01" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { level: 3, name: "Suggestions" }),
      ),
    );
  });

  it("Remove scan folder moves focus to the next scan folder, then to the Scan folders heading", async () => {
    const a = root({ displayPath: "~/code" });
    const b = root({ displayPath: "~/work" });
    const removeScanRoot = vi
      .fn<ScanActions["removeScanRoot"]>()
      .mockResolvedValueOnce({ kind: "state", state: stateOf([b]) })
      .mockResolvedValueOnce({ kind: "state", state: stateOf([]) });
    renderLive(stateOf([a, b]), actionsWith({ removeScanRoot }));
    fireEvent.click(within(rowFor("~/code")).getByRole("button", { name: "Stop scanning" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove scan folder" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(rowFor("~/work")).getByRole("button", { name: "Rescan folder" }),
      ),
    );
    fireEvent.click(within(rowFor("~/work")).getByRole("button", { name: "Stop scanning" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove scan folder" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { level: 3, name: "Scan folders" }),
      ),
    );
  });
});

describe("the depth select reverts when its rescan does not happen (finding 9)", () => {
  it("a failed depth rescan puts the select back to the saved depth", async () => {
    const a = root({ depth: 1 });
    renderLive(stateOf([a]), actionsWith());
    const select = screen.getByLabelText<HTMLSelectElement>("Look this many levels deep");
    fireEvent.change(select, { target: { value: "3" } });
    expect(await screen.findByText("Couldn't reach the command center service.")).toBeTruthy();
    await waitFor(() => expect(select.value).toBe("1"));
  });

  it("a change ignored while a rescan runs does not stick", async () => {
    const a = root({ depth: 1 });
    const pending = deferred<ScanActionOutcome>();
    const rescan = vi.fn<ScanActions["rescan"]>().mockReturnValue(pending.promise);
    renderLive(stateOf([a]), actionsWith({ rescan }));
    const select = screen.getByLabelText<HTMLSelectElement>("Look this many levels deep");
    fireEvent.change(select, { target: { value: "2" } });
    fireEvent.change(select, { target: { value: "3" } });
    expect(rescan).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(select.value).toBe("2"));
    await act(async () => pending.resolve({ kind: "failed" }));
    await waitFor(() => expect(select.value).toBe("1"));
  });
});
