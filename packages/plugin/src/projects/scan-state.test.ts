import {
  newScanRootId,
  type ScanRootId,
  type ScanRootView,
  type ScanStateResponse,
  type SuggestionView,
} from "@ccc/domain";
import { afterEach, describe, expect, it } from "vitest";
import { applyScanState, resetScanState, scanState } from "./scan-state.js";

/**
 * Codex review 3b, finding 1: a scan response may carry an EMPTY first page
 * for a folder (the byte budget ran out), and the empty list opens every
 * held list. Pages loaded before a rescan must never outlive it: a rescan
 * mints new suggestion IDs, and a held row with an old ID is a Register or
 * Dismiss the service answers "not found" forever. Synthetic names only.
 */

function root(scanRootId: ScanRootId, overrides: Partial<ScanRootView> = {}): ScanRootView {
  return {
    scanRootId,
    displayPath: "~/code",
    depth: 1,
    addedAt: "2026-10-01T00:00:00.000Z",
    lastScannedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

function suggestions(scanRootId: ScanRootId, prefix: string, count: number): SuggestionView[] {
  return Array.from({ length: count }, (_, i) => ({
    suggestionId: `${prefix}${i}`,
    scanRootId,
    folderName: `project-${i}`,
    displayPath: `~/code/project-${i}`,
  }));
}

function idsOf(state: ScanStateResponse | undefined): string[] {
  return (state?.suggestions ?? []).map((s) => s.suggestionId);
}

afterEach(() => {
  resetScanState();
});

describe("loaded pages never outlive a rescan (codex review 3b, finding 1)", () => {
  it("an empty first page from a new scan generation drops the rows held from the old one", () => {
    const id = newScanRootId();
    const old = suggestions(id, "old", 3);
    // Held from the first generation (paged in after an empty first page).
    scanState.value = {
      scanRoots: [root(id, { scanGeneration: "gen1", suggestionCount: 3 })],
      suggestions: old,
      partial: false,
    };
    // The folder was rescanned: new IDs, and no room for its first page.
    applyScanState({
      scanRoots: [root(id, { scanGeneration: "gen2", suggestionCount: 3 })],
      suggestions: [],
      partial: false,
    });
    expect(idsOf(scanState.value)).toEqual([]);
  });

  it("a non-empty first page from a new generation replaces every held row", () => {
    const id = newScanRootId();
    scanState.value = {
      scanRoots: [root(id, { scanGeneration: "gen1", suggestionCount: 3 })],
      suggestions: suggestions(id, "old", 3),
      partial: false,
    };
    const fresh = suggestions(id, "new", 1);
    applyScanState({
      scanRoots: [root(id, { scanGeneration: "gen2", suggestionCount: 3 })],
      suggestions: fresh,
      partial: false,
    });
    expect(idsOf(scanState.value)).toEqual(["new0"]);
  });

  it("the same generation keeps the pages already loaded, even past an empty first page", () => {
    const id = newScanRootId();
    const held = suggestions(id, "s", 30);
    scanState.value = {
      scanRoots: [root(id, { scanGeneration: "gen1", suggestionCount: 30 })],
      suggestions: held,
      partial: false,
    };
    applyScanState({
      scanRoots: [root(id, { scanGeneration: "gen1", suggestionCount: 30 })],
      suggestions: [],
      partial: false,
    });
    expect(idsOf(scanState.value)).toEqual(held.map((s) => s.suggestionId));
  });

  it("a folder with no generation keeps nothing held", () => {
    const id = newScanRootId();
    scanState.value = {
      scanRoots: [root(id, { suggestionCount: 2 })],
      suggestions: suggestions(id, "old", 2),
      partial: false,
    };
    applyScanState({
      scanRoots: [root(id, { suggestionCount: 2 })],
      suggestions: [],
      partial: false,
    });
    expect(idsOf(scanState.value)).toEqual([]);
  });
});

describe("a held row beyond the first page never outlives its suggestion (codex review 4)", () => {
  it("registration through an overlapping scan root drops held rows past the fresh first page", () => {
    const id = newScanRootId();
    const held = suggestions(id, "s", 30);
    // 25 on the first page, 5 more paged in: all 30 held, same generation.
    scanState.value = {
      scanRoots: [root(id, { scanGeneration: "gen1", suggestionCount: 30 })],
      suggestions: held,
      partial: false,
    };
    // s26 was registered through another, overlapping scan root: this
    // folder's generation and first page are unchanged, its count is 29.
    applyScanState({
      scanRoots: [root(id, { scanGeneration: "gen1", suggestionCount: 29 })],
      suggestions: held.slice(0, 25),
      partial: false,
    });
    const ids = idsOf(scanState.value);
    // The registered row is never kept, and nothing beyond the fresh page is
    // trusted: the rest reloads through the cursor route.
    expect(ids).not.toContain("s26");
    expect(ids).toEqual(held.slice(0, 25).map((s) => s.suggestionId));
    expect(scanState.value?.scanRoots[0]?.suggestionCount).toBe(29);
  });
});
