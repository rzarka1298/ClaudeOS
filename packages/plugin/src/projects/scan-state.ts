import type {
  ScanRootId,
  ScanRootView,
  ScanStateResponse,
  SuggestionsPage,
  SuggestionView,
} from "@ccc/domain";
import { signal } from "@preact/signals";

/**
 * The scan folders and their suggestions as the service last reported them
 * (plan 04-13, PROJ-02, PROJ-03, D-07).
 *
 * Memory only: this is never written to plugin settings, `data.json` or the
 * vault (D-43) — the display paths it carries are personal. It is fed only
 * from scan route responses, not from a new event type (PR-13: the phase's
 * event growth stays at `projects.updated`, D-50). `undefined` until the
 * first response arrives.
 *
 * A scan response carries each folder's first page of suggestions and its
 * `suggestionCount`; `Show {n} more` pages the rest in (codex review 3,
 * finding 2), after the last suggestion held for the folder and from the
 * scan generation held (codex review 3b, finding 2) — a cursor, so a list
 * that shifted ahead of it skips nothing.
 */
export const scanState = signal<ScanStateResponse | undefined>(undefined);

/** How many suggestions a folder has in all — never fewer than the ones held. */
export function suggestionTotal(root: ScanRootView, held: number): number {
  return Math.max(root.suggestionCount ?? held, held);
}

function groupOf(state: ScanStateResponse, scanRootId: ScanRootId): SuggestionView[] {
  return state.suggestions.filter((s) => s.scanRootId === scanRootId);
}

/** `true` when `prefix`'s IDs open `list` in the same order. */
function isPrefix(prefix: readonly SuggestionView[], list: readonly SuggestionView[]): boolean {
  return (
    prefix.length <= list.length &&
    prefix.every((s, index) => list[index]?.suggestionId === s.suggestionId)
  );
}

/** `true` when `previous` held `root` from the very scan `root` reports now. */
function sameGeneration(previous: ScanStateResponse, root: ScanRootView): boolean {
  const before = previous.scanRoots.find((r) => r.scanRootId === root.scanRootId);
  return root.scanGeneration !== undefined && before?.scanGeneration === root.scanGeneration;
}

/**
 * `next`, keeping the pages already loaded for a folder whose list did not
 * change: a refresh after another folder's rescan, or a register, must not
 * fold an expanded list back to its first page. Held rows are kept only
 * within one scan generation (codex review 3b, finding 1): a rescan mints
 * new IDs, and an empty first page (the byte budget ran out) opens every
 * list, so the IDs alone cannot tell. A folder whose generation changed, or
 * whose first page no longer opens what was held, starts over.
 */
function keepLoadedPages(
  previous: ScanStateResponse | undefined,
  next: ScanStateResponse,
  restart: ScanRootId | undefined,
): ScanStateResponse {
  if (previous === undefined) return next;
  const suggestions: SuggestionView[] = [];
  for (const root of next.scanRoots) {
    const fresh = groupOf(next, root.scanRootId);
    const held = groupOf(previous, root.scanRootId);
    const total = root.suggestionCount ?? fresh.length;
    const keep =
      root.scanRootId !== restart && sameGeneration(previous, root) && isPrefix(fresh, held);
    suggestions.push(...(keep ? held.slice(0, total) : fresh));
  }
  return { ...next, suggestions };
}

/**
 * Applies a scan route response, keeping pages already loaded where still
 * valid. `restart` names a folder whose held pages are dropped whatever the
 * response says: the page route answered `reload` for it (codex review 3b,
 * finding 2), so it starts over from the first page the response carries.
 */
export function applyScanState(state: ScanStateResponse, restart?: ScanRootId): void {
  scanState.value = keepLoadedPages(scanState.value, state, restart);
}

/** The cursor of a folder's next page: its scan generation and the last suggestion held. */
export interface SuggestionsCursor {
  readonly scanGeneration: string;
  readonly afterSuggestionId: string | undefined;
}

/** Where `Show {n} more` continues a folder from; `null` before the folder has been scanned. */
export function nextPageCursor(
  base: ScanStateResponse,
  scanRootId: ScanRootId,
): SuggestionsCursor | null {
  const root = base.scanRoots.find((r) => r.scanRootId === scanRootId);
  if (root?.scanGeneration === undefined) return null;
  return {
    scanGeneration: root.scanGeneration,
    afterSuggestionId: groupOf(base, scanRootId).at(-1)?.suggestionId,
  };
}

/**
 * Appends one folder's page, fetched after `cursor`. A page that no longer
 * continues what is held (a refresh landed in between) is dropped; `false`
 * tells the caller to resync.
 */
export function appendSuggestionsPage(
  base: ScanStateResponse,
  scanRootId: ScanRootId,
  cursor: SuggestionsCursor,
  page: SuggestionsPage,
): boolean {
  const now = nextPageCursor(base, scanRootId);
  if (
    now === null ||
    now.scanGeneration !== cursor.scanGeneration ||
    now.afterSuggestionId !== cursor.afterSuggestionId
  ) {
    return false;
  }
  const held = groupOf(base, scanRootId);
  const known = new Set(held.map((s) => s.suggestionId));
  if (page.suggestions.some((s) => known.has(s.suggestionId) || s.scanRootId !== scanRootId)) {
    return false;
  }
  scanState.value = {
    ...base,
    scanRoots: base.scanRoots.map((root) =>
      root.scanRootId === scanRootId ? { ...root, suggestionCount: page.total } : root,
    ),
    suggestions: [...base.suggestions, ...page.suggestions],
  };
  return true;
}

/** Drops one suggestion (dismissed or registered) and its folder's count with it. */
export function removeSuggestion(base: ScanStateResponse, suggestion: SuggestionView): void {
  if (!base.suggestions.some((s) => s.suggestionId === suggestion.suggestionId)) return;
  scanState.value = {
    ...base,
    scanRoots: base.scanRoots.map((root) =>
      root.scanRootId === suggestion.scanRootId && root.suggestionCount !== undefined
        ? { ...root, suggestionCount: Math.max(0, root.suggestionCount - 1) }
        : root,
    ),
    suggestions: base.suggestions.filter((s) => s.suggestionId !== suggestion.suggestionId),
  };
}

/** Test seam: back to "nothing received yet". */
export function resetScanState(): void {
  scanState.value = undefined;
}
