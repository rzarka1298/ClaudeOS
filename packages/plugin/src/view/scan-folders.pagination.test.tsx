import {
  newProjectId,
  newScanRootId,
  type ScanRootId,
  type ScanRootView,
  type ScanStateResponse,
  type SuggestionView,
} from "@ccc/domain";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ScanActionOutcome,
  ScanActions,
  SuggestionsPageOutcome,
} from "../projects/projects-actions.js";
import { resetScanState, scanState } from "../projects/scan-state.js";
import { ScanFolders } from "./scan-folders.js";

/**
 * Codex review 3, finding 2 on S5: a scan response carries each folder's
 * first page and its `suggestionCount`; `Show {n} more` reveals rows held
 * or pages the next ones in from the service, from the number held.
 * Synthetic names and `~/…` display paths only.
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
    suggestionsPage: () => Promise.resolve({ kind: "failed" }),
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

function rowNames(): string[] {
  return screen
    .getAllByRole("listitem")
    .filter((item) => item.classList.contains("ccc-suggestion-row"))
    .map((item) => item.querySelector("p")?.textContent ?? "");
}

/** A page action serving `all` from the requested offset, 25 at a time. */
function pagesOf(all: SuggestionView[]) {
  return vi.fn(
    (_scanRootId: ScanRootId, offset: number): Promise<SuggestionsPageOutcome> =>
      Promise.resolve({
        kind: "page",
        page: { suggestions: all.slice(offset, offset + 25), total: all.length },
      }),
  );
}

afterEach(() => {
  cleanup();
  resetScanState();
});

describe("Show {n} more pages suggestions in from the service (codex review 3, finding 2)", () => {
  it("counts every suggestion, and fetches the next page from the number held", async () => {
    const a = root({ suggestionCount: 60 });
    const all = suggestionsFor(a.scanRootId, 60);
    const suggestionsPage = pagesOf(all);
    renderLive(stateOf([a], all.slice(0, 25)), actionsWith({ suggestionsPage }));

    expect(screen.getByText("60 folders")).toBeTruthy();
    expect(rowNames()).toHaveLength(25);

    fireEvent.click(screen.getByRole("button", { name: "Show 25 more" }));
    await waitFor(() => expect(rowNames()).toHaveLength(50));
    expect(suggestionsPage).toHaveBeenLastCalledWith(a.scanRootId, 25);

    fireEvent.click(screen.getByRole("button", { name: "Show 10 more" }));
    await waitFor(() => expect(rowNames()).toHaveLength(60));
    expect(suggestionsPage).toHaveBeenLastCalledWith(a.scanRootId, 50);
    expect(rowNames()).toEqual(all.map((s) => s.folderName));
    expect(screen.queryByRole("button", { name: /^Show \d+ more$/ })).toBeNull();
  });

  it("a folder the response had no room for still lists, and its first page is fetched", async () => {
    const a = root({ suggestionCount: 3 });
    const all = suggestionsFor(a.scanRootId, 3);
    const suggestionsPage = pagesOf(all);
    renderLive(stateOf([a], []), actionsWith({ suggestionsPage }));

    expect(screen.queryByText("No suggestions.")).toBeNull();
    expect(screen.getByText("3 folders")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show 3 more" }));
    await waitFor(() => expect(rowNames()).toHaveLength(3));
    expect(suggestionsPage).toHaveBeenCalledWith(a.scanRootId, 0);
  });

  it("rows already held are revealed with no request", () => {
    const a = root();
    const suggestionsPage = pagesOf([]);
    renderLive(stateOf([a], suggestionsFor(a.scanRootId, 30)), actionsWith({ suggestionsPage }));
    fireEvent.click(screen.getByRole("button", { name: "Show 5 more" }));
    expect(rowNames()).toHaveLength(30);
    expect(suggestionsPage).not.toHaveBeenCalled();
  });

  it("a failed page request says the service could not be reached and keeps the rows", async () => {
    const a = root({ suggestionCount: 40 });
    renderLive(
      stateOf([a], suggestionsFor(a.scanRootId, 25)),
      actionsWith({ suggestionsPage: () => Promise.resolve({ kind: "failed" }) }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Show 15 more" }));
    await waitFor(() =>
      expect(screen.getByText("Couldn't reach the command center service.")).toBeTruthy(),
    );
    expect(rowNames()).toHaveLength(25);
  });

  it("dismissing keeps loaded pages and the count honest", async () => {
    const a = root({ suggestionCount: 60 });
    const all = suggestionsFor(a.scanRootId, 60);
    renderLive(
      stateOf([a], all.slice(0, 25)),
      actionsWith({
        suggestionsPage: pagesOf(all),
        dismissSuggestion: () => Promise.resolve({ kind: "ok" }),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Show 25 more" }));
    await waitFor(() => expect(rowNames()).toHaveLength(50));

    fireEvent.click(screen.getByRole("button", { name: "Dismiss project-30" }));
    await waitFor(() => expect(screen.getByText("59 folders")).toBeTruthy());
    expect(rowNames()).toHaveLength(49);
    expect(rowNames()).not.toContain("project-30");
  });

  it("a register's refreshed state keeps the pages already loaded", async () => {
    const a = root({ suggestionCount: 60 });
    const all = suggestionsFor(a.scanRootId, 60);
    const remaining = all.filter((s) => s.folderName !== "project-30");
    renderLive(
      stateOf([a], all.slice(0, 25)),
      actionsWith({
        suggestionsPage: pagesOf(all),
        registerSuggestion: () =>
          Promise.resolve({ kind: "registered", projectId: newProjectId() }),
        listScanState: (): Promise<ScanActionOutcome> =>
          Promise.resolve({
            kind: "state",
            state: stateOf([{ ...a, suggestionCount: 59 }], remaining.slice(0, 25)),
          }),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Show 25 more" }));
    await waitFor(() => expect(rowNames()).toHaveLength(50));

    fireEvent.click(screen.getByRole("button", { name: "Register project-30" }));
    await waitFor(() => expect(screen.getByText("59 folders")).toBeTruthy());
    expect(rowNames()).toHaveLength(49);
    expect(rowNames()).toEqual(remaining.slice(0, 49).map((s) => s.folderName));
  });
});
