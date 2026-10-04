import {
  MAX_PATH_LENGTH,
  MAX_SCAN_ROOT_PATH_LENGTH,
  MAX_SCAN_ROOTS,
  SCAN_RESPONSE_BUDGET_BYTES,
  type ScanRootId,
  type ScanRootView,
  ScanRootViewSchema,
  ScanStateResponseSchema,
  SUGGESTIONS_PAGE_SIZE,
  SuggestionsPageResponseSchema,
  type SuggestionView,
  SuggestionViewSchema,
} from "@ccc/domain";
import { describe, expect, it } from "vitest";
import { fitScanState, fitSuggestionsPage, jsonBytes } from "./scan-page.js";

/**
 * The worst case the schemas allow (codex review 3, finding 2): every scan
 * response body stays under the plugin client's 65,536-byte cap
 * (`SocketApiClient`'s `MAX_RESPONSE_BYTES`) however many suggestions a
 * scan holds — up to the walker's 5,000 and beyond.
 */

/** `SocketApiClient` refuses a body over this many bytes. */
const CLIENT_RESPONSE_LIMIT = 64 * 1024;
/** The walker's entry cap, with headroom: suggestions can never outnumber it. */
const MANY = 6000;
/**
 * A control character JSON escapes as `\u0001` — six bytes for one
 * character, the largest a string of N characters can serialize to.
 */
const WORST_CHAR = "\u0001";

const ROOT_ID = "abcdefghi0123456789abcdef" as ScanRootId;

/** A suggestion with every field at its schema maximum, in its costliest characters. */
function worstSuggestion(i: number): SuggestionView {
  const id = String(i).padStart(64, "z");
  return SuggestionViewSchema.parse({
    suggestionId: id,
    scanRootId: ROOT_ID,
    folderName: WORST_CHAR.repeat(255),
    displayPath: WORST_CHAR.repeat(MAX_PATH_LENGTH),
  });
}

function typicalSuggestion(i: number): SuggestionView {
  const name = `repository-number-${String(i).padStart(4, "0")}`;
  return {
    suggestionId: `${i}`.padStart(32, "a"),
    scanRootId: ROOT_ID,
    folderName: name,
    displayPath: `~/code/${name}`,
  };
}

const ROOT: ScanRootView = {
  scanRootId: ROOT_ID,
  displayPath: "~/code",
  depth: 3,
  addedAt: "2026-10-01T00:00:00.000Z",
  lastScannedAt: "2026-10-01T00:00:00.000Z",
  scanStatus: "partial",
  suggestionCount: MANY,
};

describe("scan pages fit the client's response cap (codex review 3, finding 2)", () => {
  it("one worst-case suggestion is far under the budget, so a page always progresses", () => {
    expect(jsonBytes(worstSuggestion(0))).toBeLessThan(SCAN_RESPONSE_BUDGET_BYTES / 2);
    expect(SCAN_RESPONSE_BUDGET_BYTES).toBeLessThan(CLIENT_RESPONSE_LIMIT);
  });

  it("a page of worst-case suggestions fits, and holds at least one", () => {
    const visible = Array.from({ length: MANY }, (_, i) => worstSuggestion(i));
    for (const offset of [0, 1, MANY - 1]) {
      const page = fitSuggestionsPage(visible.slice(offset), MANY);
      expect(jsonBytes(page)).toBeLessThanOrEqual(SCAN_RESPONSE_BUDGET_BYTES);
      expect(page.suggestions.length).toBeGreaterThanOrEqual(1);
      expect(page).toMatchObject({ kind: "page", total: MANY });
      SuggestionsPageResponseSchema.parse(page);
    }
  });

  it("a scan state of worst-case suggestions fits, with a prefix of the folder's list", () => {
    const visible = Array.from({ length: MANY }, (_, i) => worstSuggestion(i));
    const state = fitScanState([ROOT], [visible], true);
    // Plus the largest protectedLocation `add` appends afterwards.
    const withProtected = { ...state, protectedLocation: "cloud-storage" as const };
    expect(jsonBytes(withProtected)).toBeLessThanOrEqual(CLIENT_RESPONSE_LIMIT);
    expect(visible.slice(0, state.suggestions.length)).toEqual(state.suggestions);
    ScanStateResponseSchema.parse(withProtected);
  });

  it("typical names: a full first page per folder, and paging walks all 6,000 exactly once", () => {
    const visible = Array.from({ length: MANY }, (_, i) => typicalSuggestion(i));
    const state = fitScanState([ROOT], [visible], false);
    expect(state.suggestions).toHaveLength(SUGGESTIONS_PAGE_SIZE);

    const seen: SuggestionView[] = [...state.suggestions];
    while (seen.length < MANY) {
      const page = fitSuggestionsPage(visible.slice(seen.length), MANY);
      if (page.kind !== "page" || page.suggestions.length === 0) throw new Error("no progress");
      expect(jsonBytes(page)).toBeLessThanOrEqual(CLIENT_RESPONSE_LIMIT);
      seen.push(...page.suggestions);
    }
    expect(seen).toEqual(visible);
  });

  it("many folders: later folders carry a shorter prefix (or none) once the budget is spent", () => {
    const roots: ScanRootView[] = [];
    const byRoot: SuggestionView[][] = [];
    for (let r = 0; r < 40; r++) {
      const scanRootId = `abcdefghi${String(r).padStart(16, "0")}` as ScanRootId;
      roots.push({ ...ROOT, scanRootId });
      byRoot.push(Array.from({ length: 50 }, (_, i) => ({ ...worstSuggestion(i), scanRootId })));
    }
    const state = fitScanState(roots, byRoot, false);
    expect(jsonBytes(state)).toBeLessThanOrEqual(SCAN_RESPONSE_BUDGET_BYTES);
    expect(state.scanRoots).toHaveLength(40);
  });
});

describe("the full list of scan folders fits too (codex review 3b, finding 3)", () => {
  /**
   * The costliest character a scan folder's display path may hold: the
   * schema refuses control characters (six bytes escaped) and lone
   * surrogates (six), so a BMP character outside ASCII — three UTF-8 bytes,
   * unescaped — is the most one UTF-16 unit can cost.
   */
  const WORST_PATH_CHAR = "\u0800";

  function worstRoot(r: number): ScanRootView {
    return ScanRootViewSchema.parse({
      scanRootId: `abcdefghi${String(r).padStart(16, "0")}`,
      displayPath: WORST_PATH_CHAR.repeat(MAX_SCAN_ROOT_PATH_LENGTH),
      depth: 3,
      addedAt: "2026-10-01T00:00:00.123456789Z",
      lastScannedAt: "2026-10-01T00:00:00.123456789Z",
      scanStatus: "access-denied",
      suggestionCount: Number.MAX_SAFE_INTEGER,
      scanGeneration: "z".repeat(64),
    });
  }

  it("the schema bounds a scan folder's fields, so the worst case is the one built here", () => {
    const base = worstRoot(0);
    const accepts = (overrides: Partial<Record<keyof ScanRootView, unknown>>) =>
      ScanRootViewSchema.safeParse({ ...base, ...overrides }).success;
    expect(accepts({ displayPath: "a".repeat(MAX_SCAN_ROOT_PATH_LENGTH + 1) })).toBe(false);
    expect(accepts({ displayPath: `~/code${WORST_CHAR}` })).toBe(false);
    expect(accepts({ displayPath: "~/code\ud800" })).toBe(false);
    expect(accepts({ displayPath: "~/code\udc00x" })).toBe(false);
    expect(accepts({ displayPath: "~/emoji-\ud83d\ude00" })).toBe(true);
    expect(accepts({ addedAt: `${"\\".repeat(4000)}` })).toBe(false);
    expect(accepts({ lastScannedAt: "2026-10-01T00:00:00.0000000000Z" })).toBe(false);
    expect(accepts({ lastScannedAt: null })).toBe(true);
    expect(accepts({ scanGeneration: "z".repeat(65) })).toBe(false);
  });

  it(`${MAX_SCAN_ROOTS} worst-case folders, each with worst-case suggestions, answer within 64 KiB`, () => {
    const roots: ScanRootView[] = [];
    const byRoot: SuggestionView[][] = [];
    for (let r = 0; r < MAX_SCAN_ROOTS; r++) {
      const root = worstRoot(r);
      roots.push(root);
      byRoot.push(
        Array.from({ length: 30 }, (_, i) => ({
          ...worstSuggestion(i),
          scanRootId: root.scanRootId,
        })),
      );
    }
    // The folders alone leave room inside the budget: suggestions are fitted
    // into what remains, never forced past it.
    expect(jsonBytes({ scanRoots: roots, suggestions: [], partial: true })).toBeLessThan(
      SCAN_RESPONSE_BUDGET_BYTES,
    );
    const state = fitScanState(roots, byRoot, true);
    const withProtected = { ...state, protectedLocation: "cloud-storage" as const };
    expect(state.scanRoots).toHaveLength(MAX_SCAN_ROOTS);
    expect(jsonBytes(state)).toBeLessThanOrEqual(SCAN_RESPONSE_BUDGET_BYTES);
    expect(jsonBytes(withProtected)).toBeLessThanOrEqual(CLIENT_RESPONSE_LIMIT);
    ScanStateResponseSchema.parse(withProtected);
  });

  it(`${MAX_SCAN_ROOTS} worst-case folders with typical suggestions still carry first pages`, () => {
    const roots: ScanRootView[] = [];
    const byRoot: SuggestionView[][] = [];
    for (let r = 0; r < MAX_SCAN_ROOTS; r++) {
      const root = worstRoot(r);
      roots.push(root);
      byRoot.push(
        Array.from({ length: 30 }, (_, i) => ({
          ...typicalSuggestion(i),
          scanRootId: root.scanRootId,
        })),
      );
    }
    const state = fitScanState(roots, byRoot, false);
    const withProtected = { ...state, protectedLocation: "cloud-storage" as const };
    expect(jsonBytes(withProtected)).toBeLessThanOrEqual(CLIENT_RESPONSE_LIMIT);
    expect(state.suggestions.length).toBeGreaterThan(0);
  });
});
