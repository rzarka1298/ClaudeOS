import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FolderPick } from "../projects/folder-picker.js";
import type { ScanActionOutcome, ScanActions } from "../projects/projects-actions.js";
import { resetScanState } from "../projects/scan-state.js";
import { AddScanFolderFlow } from "./scan-folders.js";

/**
 * Codex review 3b, finding 3: the service refuses a scan folder past its
 * cap with a constant answer, and the add flow says so in its own words —
 * not the "choose another folder" copy, which would send the owner looking
 * for a folder problem that is not there. Synthetic paths only.
 */

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

afterEach(() => {
  cleanup();
  resetScanState();
});

describe("the scan folder limit (codex review 3b, finding 3)", () => {
  it("an add past the limit says how many folders can be scanned and what to do", async () => {
    const addScanRoot = vi.fn<ScanActions["addScanRoot"]>().mockResolvedValue({ kind: "limit" });
    render(
      <AddScanFolderFlow
        actions={actionsWith({ addScanRoot })}
        pickFolder={() =>
          Promise.resolve<FolderPick>({ kind: "picked", path: "/Users/USERNAME/code" })
        }
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add a scan folder" }));
    expect(await screen.findByText("You can scan at most 50 folders.")).toBeTruthy();
    expect(screen.getByText("Remove a scan folder, then add this one.")).toBeTruthy();
    expect(screen.queryByText("Couldn't add this scan folder.")).toBeNull();
    await waitFor(() => expect(addScanRoot).toHaveBeenCalledTimes(1));
  });
});
