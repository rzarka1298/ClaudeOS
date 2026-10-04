import {
  SCAN_RESPONSE_BUDGET_BYTES,
  type ScanRootView,
  type ScanStateResponse,
  SUGGESTIONS_PAGE_SIZE,
  type SuggestionsPage,
  type SuggestionView,
} from "@ccc/domain";

/**
 * Bounded scan responses (codex review 3, finding 2): the plugin's
 * `SocketApiClient` refuses a response body over 65,536 bytes, and one scan
 * can find thousands of Git folders. Suggestions therefore travel a page at
 * a time, and every page is fitted to a byte budget, not just a count.
 */

/** The UTF-8 size of `value` as `sendJson` writes it. */
export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * The longest prefix of `items`, at most `maxCount` long, whose members fit
 * in `budgetBytes` once serialized into a JSON array (each member plus its
 * separating comma). Always a PREFIX, so the last suggestion the plugin
 * holds is the cursor of the next page.
 *
 * With `alwaysFirst`, the first item is taken even when it alone is over
 * budget, so a page request always progresses — the schema bounds
 * (`SuggestionViewSchema`) keep one suggestion far below the budget, which
 * `scan-page.test.ts` proves for the worst case.
 */
export function takeWithinBudget<T>(
  items: readonly T[],
  maxCount: number,
  budgetBytes: number,
  alwaysFirst = false,
): T[] {
  const taken: T[] = [];
  let used = 0;
  for (const item of items) {
    if (taken.length >= maxCount) break;
    const cost = jsonBytes(item) + 1;
    if (used + cost > budgetBytes && !(alwaysFirst && taken.length === 0)) break;
    taken.push(item);
    used += cost;
  }
  return taken;
}

/**
 * A scan state body: every folder, plus each folder's first page of
 * suggestions, folder by folder, while the whole body stays inside
 * {@link SCAN_RESPONSE_BUDGET_BYTES}. A folder whose page does not fit
 * carries a shorter prefix (or none), and so does every folder after it;
 * the plugin pages the rest in after the last one it holds.
 */
export function fitScanState(
  scanRoots: readonly ScanRootView[],
  suggestionsByRoot: readonly (readonly SuggestionView[])[],
  partial: boolean,
): ScanStateResponse {
  let remaining = SCAN_RESPONSE_BUDGET_BYTES - jsonBytes({ scanRoots, suggestions: [], partial });
  const suggestions: SuggestionView[] = [];
  for (const visible of suggestionsByRoot) {
    const page = takeWithinBudget(visible, SUGGESTIONS_PAGE_SIZE, remaining);
    for (const view of page) {
      suggestions.push(view);
      remaining -= jsonBytes(view) + 1;
    }
    if (page.length < Math.min(visible.length, SUGGESTIONS_PAGE_SIZE)) break;
  }
  return { scanRoots: [...scanRoots], suggestions, partial };
}

/**
 * One folder's next page: the visible suggestions after the plugin's cursor
 * (`after`, in scan order), at most one page, fitted to the budget, always
 * at least one while any remain (so `Show {n} more` always progresses).
 * `total` is how many the folder has visible in all.
 */
export function fitSuggestionsPage(
  after: readonly SuggestionView[],
  total: number,
): SuggestionsPage {
  const budget = SCAN_RESPONSE_BUDGET_BYTES - jsonBytes({ kind: "page", suggestions: [], total });
  return {
    kind: "page",
    suggestions: takeWithinBudget(after, SUGGESTIONS_PAGE_SIZE, budget, true),
    total,
  };
}
