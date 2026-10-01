import {
  newScanRootId,
  type ScanRootId,
  type ScanRootView,
  type ScanStateResponse,
  type SuggestionView,
} from "@ccc/domain";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScanActionOutcome, ScanActions } from "../projects/projects-actions.js";
import { resetScanState, scanState } from "../projects/scan-state.js";
import { ScanFolders } from "./scan-folders.js";

/**
 * The complete S5 surface (plan 04-13 Task 3, D-36, RR-18, UI-SPEC S5):
 * scan folder rows with depth, rescan and stop scanning; suggestions grouped
 * by scan folder with overflow, register and dismiss; empty and failure
 * states. Synthetic names and `~/…` display paths only.
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

function suggestionsFor(
  scanRootId: ScanRootId,
  count: number,
  prefix = "project",
): SuggestionView[] {
  return Array.from({ length: count }, (_, i) => ({
    suggestionId: `${prefix}${i}`,
    scanRootId,
    folderName: `${prefix}-${String(i).padStart(2, "0")}`,
    displayPath: `~/code/${prefix}-${String(i).padStart(2, "0")}`,
  }));
}

function stateOf(scanRoots: ScanRootView[], suggestions: SuggestionView[] = []): ScanStateResponse {
  return { scanRoots, suggestions, partial: false };
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

/** Renders against the live signal, the way ProjectsView does. */
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

afterEach(() => {
  cleanup();
  resetScanState();
});

describe("empty states (UI-SPEC S5)", () => {
  it("no scan folders: the empty copy, and no Suggestions section", () => {
    renderLive(stateOf([]), actionsWith());
    expect(screen.getByText("No scan folders yet.")).toBeTruthy();
    expect(
      screen.getByText(
        "Add a parent folder to find the Git projects inside it. Only folders you add here are ever scanned.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /Suggestions/ })).toBeNull();
  });

  it("scan folders but no suggestions: No suggestions. and its body", () => {
    renderLive(stateOf([root()]), actionsWith());
    expect(screen.getByRole("heading", { level: 3, name: /Suggestions/ })).toBeTruthy();
    expect(screen.getByText("No suggestions.")).toBeTruthy();
    expect(
      screen.getByText("Every Git folder found is already registered, or none were found."),
    ).toBeTruthy();
  });
});

describe("scan folder rows", () => {
  it("shows the display path, the last scan time or Not scanned yet, and the depth select", () => {
    renderLive(
      stateOf([
        root({ displayPath: "~/code", depth: 2 }),
        root({ displayPath: "~/work", lastScannedAt: null }),
      ]),
      actionsWith(),
    );
    const code = rowFor("~/code");
    expect(within(code).getByText("~/code").className).toContain("ccc-mono-label");
    expect(within(code).getByText("Scanned 2 minutes ago")).toBeTruthy();
    const select = within(code).getByLabelText<HTMLSelectElement>("Look this many levels deep");
    expect(select.value).toBe("2");
    expect(Array.from(select.options).map((o) => o.text)).toEqual([
      "1 level (default)",
      "2 levels",
      "3 levels",
    ]);
    expect(within(code).getByRole("button", { name: "Rescan folder" })).toBeTruthy();
    expect(within(code).getByRole("button", { name: "Stop scanning" })).toBeTruthy();
    expect(within(rowFor("~/work")).getByText("Not scanned yet")).toBeTruthy();
  });

  it("Rescan folder shows Scanning… on that row synchronously; the other row stays operable", async () => {
    const a = root({ displayPath: "~/code" });
    const b = root({ displayPath: "~/work" });
    let finishA: (outcome: ScanActionOutcome) => void = () => {};
    const rescan = vi.fn<ScanActions["rescan"]>((id) =>
      id === a.scanRootId
        ? new Promise((resolve) => {
            finishA = resolve;
          })
        : Promise.resolve({ kind: "state", state: stateOf([a, b]) }),
    );
    renderLive(stateOf([a, b]), actionsWith({ rescan }));

    fireEvent.click(within(rowFor("~/code")).getByRole("button", { name: "Rescan folder" }));
    expect(within(rowFor("~/code")).getByText("Scanning…")).toBeTruthy();
    expect(within(rowFor("~/work")).queryByText("Scanning…")).toBeNull();
    const other = within(rowFor("~/work")).getByRole("button", { name: "Rescan folder" });
    expect(other.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(other);
    expect(rescan).toHaveBeenCalledWith(b.scanRootId);

    await act(async () => {
      finishA({ kind: "state", state: stateOf([a, b], suggestionsFor(a.scanRootId, 1)) });
    });
    expect(within(rowFor("~/code")).getByText("Found 1 new Git folder")).toBeTruthy();
  });

  it("the result line is plural for many and reads No new Git folders found. for zero", async () => {
    const a = root();
    const rescan = vi
      .fn<ScanActions["rescan"]>()
      .mockResolvedValueOnce({
        kind: "state",
        state: stateOf([a], suggestionsFor(a.scanRootId, 3)),
      })
      .mockResolvedValueOnce({ kind: "state", state: stateOf([a]) });
    renderLive(stateOf([a]), actionsWith({ rescan }));
    fireEvent.click(screen.getByRole("button", { name: "Rescan folder" }));
    expect(await screen.findByText("Found 3 new Git folders")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rescan folder" }));
    expect(await screen.findByText("No new Git folders found.")).toBeTruthy();
  });

  it("changing the depth rescans at that depth", async () => {
    const a = root();
    const rescan = vi
      .fn<ScanActions["rescan"]>()
      .mockResolvedValue({ kind: "state", state: stateOf([{ ...a, depth: 3 }]) });
    renderLive(stateOf([a]), actionsWith({ rescan }));
    fireEvent.change(screen.getByLabelText("Look this many levels deep"), {
      target: { value: "3" },
    });
    expect(rescan).toHaveBeenCalledWith(a.scanRootId, 3);
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLSelectElement>("Look this many levels deep").value).toBe(
        "3",
      ),
    );
  });

  it("Stop scanning swaps to the inline confirmation with focus on Keep scan folder; Escape keeps", () => {
    const a = root();
    const removeScanRoot = vi.fn<ScanActions["removeScanRoot"]>();
    renderLive(stateOf([a]), actionsWith({ removeScanRoot }));
    fireEvent.click(screen.getByRole("button", { name: "Stop scanning" }));
    expect(
      screen.getByText(
        "Stop scanning this folder? Projects already registered from it stay registered.",
      ),
    ).toBeTruthy();
    const keep = screen.getByRole("button", { name: "Keep scan folder" });
    expect(document.activeElement).toBe(keep);
    fireEvent.keyDown(keep, { key: "Escape" });
    expect(screen.queryByRole("button", { name: "Keep scan folder" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Stop scanning" }));
    expect(removeScanRoot).not.toHaveBeenCalled();
  });

  it("Remove scan folder calls removeScanRoot and applies the new state", async () => {
    const a = root();
    const removeScanRoot = vi
      .fn<ScanActions["removeScanRoot"]>()
      .mockResolvedValue({ kind: "state", state: stateOf([]) });
    renderLive(stateOf([a], suggestionsFor(a.scanRootId, 2)), actionsWith({ removeScanRoot }));
    fireEvent.click(screen.getByRole("button", { name: "Stop scanning" }));
    const remove = screen.getByRole("button", { name: "Remove scan folder" });
    expect(remove.className).toContain("ccc-button-danger");
    fireEvent.click(remove);
    expect(removeScanRoot).toHaveBeenCalledWith(a.scanRootId);
    expect(await screen.findByText("No scan folders yet.")).toBeTruthy();
  });
});

describe("suggestions (D-36, RR-18)", () => {
  it("groups suggestions under their scan folder's display path, with the count in the heading meta", () => {
    const a = root({ displayPath: "~/code" });
    const b = root({ displayPath: "~/work" });
    renderLive(
      stateOf(
        [a, b],
        [...suggestionsFor(a.scanRootId, 2, "alpha"), ...suggestionsFor(b.scanRootId, 1, "beta")],
      ),
      actionsWith(),
    );
    expect(screen.getByText("3 folders")).toBeTruthy();
    const codeGroup = screen.getByRole("group", { name: "~/code" });
    expect(within(codeGroup).getAllByRole("button", { name: /^Register / })).toHaveLength(2);
    const workGroup = screen.getByRole("group", { name: "~/work" });
    expect(within(workGroup).getByRole("button", { name: "Register beta-00" })).toBeTruthy();
    expect(within(workGroup).getByRole("button", { name: "Dismiss beta-00" })).toBeTruthy();
    expect(within(workGroup).getByText("~/code/beta-00")).toBeTruthy();
  });

  it("one suggestion reads 1 folder", () => {
    const a = root();
    renderLive(stateOf([a], suggestionsFor(a.scanRootId, 1)), actionsWith());
    expect(screen.getByText("1 folder")).toBeTruthy();
  });

  it("shows 25 per group, then Show {n} more reveals the next 25", () => {
    const a = root();
    renderLive(stateOf([a], suggestionsFor(a.scanRootId, 60)), actionsWith());
    expect(screen.getAllByRole("button", { name: /^Register / })).toHaveLength(25);
    fireEvent.click(screen.getByRole("button", { name: "Show 25 more" }));
    expect(screen.getAllByRole("button", { name: /^Register / })).toHaveLength(50);
    fireEvent.click(screen.getByRole("button", { name: "Show 10 more" }));
    expect(screen.getAllByRole("button", { name: /^Register / })).toHaveLength(60);
    expect(screen.queryByRole("button", { name: /^Show \d+ more$/ })).toBeNull();
  });

  it("Dismiss sends the suggestionId, hides the row, and the dismissed note appears once", async () => {
    const a = root();
    const dismissSuggestion = vi
      .fn<ScanActions["dismissSuggestion"]>()
      .mockResolvedValue({ kind: "ok" });
    renderLive(stateOf([a], suggestionsFor(a.scanRootId, 3)), actionsWith({ dismissSuggestion }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss project-00" }));
    expect(dismissSuggestion).toHaveBeenCalledWith("project0");
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Register project-00" })).toBeNull(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss project-01" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Register project-01" })).toBeNull(),
    );
    expect(
      screen.getAllByText("Dismissed suggestions come back after the next rescan."),
    ).toHaveLength(1);
  });

  it("Register announces the registered folder and reloads the scan state", async () => {
    const a = root();
    const after = stateOf([a]);
    const registerSuggestion = vi
      .fn<ScanActions["registerSuggestion"]>()
      .mockResolvedValue({ kind: "registered", projectId: "0000000000abcdefabcdefabc" as never });
    const listScanState = vi
      .fn<ScanActions["listScanState"]>()
      .mockResolvedValue({ kind: "state", state: after });
    renderLive(
      stateOf([a], suggestionsFor(a.scanRootId, 1)),
      actionsWith({ registerSuggestion, listScanState }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Register project-00" }));
    expect(registerSuggestion).toHaveBeenCalledWith("project0");
    expect(await screen.findByText("Registered project-00.")).toBeTruthy();
    await waitFor(() => expect(scanState.value).toEqual(after));
  });
});

describe("failures (UI-SPEC S5, PR-11)", () => {
  it("a failed scan shows the problem and next step on that row", () => {
    renderLive(stateOf([root({ scanStatus: "failed" })]), actionsWith());
    expect(screen.getByText("Couldn't scan this folder.")).toBeTruthy();
    expect(screen.getByText("Check that it still exists, then choose Rescan folder.")).toBeTruthy();
  });

  it("a folder-access-denied scan shows the PR-11 lines for this folder", () => {
    renderLive(stateOf([root({ scanStatus: "access-denied" })]), actionsWith());
    expect(screen.getByText("macOS blocked access to this folder.")).toBeTruthy();
    expect(
      screen.getByText(
        "Move the folder out of Documents, Desktop, Downloads or iCloud Drive, or allow access in System Settings › Privacy & Security, then choose Rescan folder. Updating Node.js can make macOS block it again.",
      ),
    ).toBeTruthy();
  });

  it("every ▲ glyph is aria-hidden with a text sibling", () => {
    renderLive(
      stateOf([
        root({ scanStatus: "failed" }),
        root({ displayPath: "~/w", scanStatus: "access-denied" }),
      ]),
      actionsWith(),
    );
    const glyphs = Array.from(document.querySelectorAll("*")).filter(
      (el) => el.children.length === 0 && el.textContent?.includes("▲"),
    );
    expect(glyphs.length).toBe(2);
    for (const glyph of glyphs) {
      expect(glyph.getAttribute("aria-hidden")).toBe("true");
      expect(glyph.parentElement?.textContent?.replace("▲", "").trim().length).toBeGreaterThan(0);
    }
  });
});
