import type {
  ResearchErrorCode,
  ResearchReportHeader,
  ResearchReportItem,
  ResearchReportSource,
} from "@ccc/domain/research-routes.js";
import { type Signal, signal } from "@preact/signals";
import { ResearchApiError, researchApi } from "./api.js";

/**
 * The report reader's page sequence (plan 07-13; UI-SPEC R4 "Loading the reader", D-23, research
 * Pitfall 11). Opening a report asks for the header and the first findings page; the remaining
 * findings pages and then the sources page follow automatically, one request at a time, so a long
 * report never needs a Show more button inside the article and no answer ever approaches the
 * 64 KiB socket cap.
 *
 * A load token guards every answer: opening another report or closing the reader moves the token,
 * so a late answer for the report the owner left is dropped, and no page of that report is asked
 * for again. Nothing here imports `obsidian` or the service client; the API is reached only
 * through the holder in `api.ts`, and a failure is kept as a closed error code, never a message.
 */

/** Pages are small (10 findings), the report holds at most 25: more than this is a loop. */
const MAX_PAGES_PER_SECTION = 10;

export interface ReaderState {
  readonly noteId: string;
  /** The header from the first findings page; null until it lands. */
  readonly header: ResearchReportHeader | null;
  /** The findings loaded so far, in report order, one per index. */
  readonly items: readonly ResearchReportItem[];
  /** True when the service trimmed a findings page: the findings end there. */
  readonly itemsTruncated: boolean;
  /** True once the last findings page has landed (or the findings ended at a trimmed page). */
  readonly itemsLoaded: boolean;
  /** The sources loaded so far in source-number order; null until the first sources page lands. */
  readonly sources: readonly ResearchReportSource[] | null;
  /** True when the service trimmed a sources page. */
  readonly sourcesTruncated: boolean;
  /** True once the last sources page has landed (or the sources ended at a trimmed page). */
  readonly sourcesLoaded: boolean;
  /** The closed code of a failed FIRST page (the report did not open), or null. */
  readonly firstFailure: ResearchErrorCode | null;
  /** The closed code of a failed LATER page (the findings read so far stay), or null. */
  readonly laterFailure: ResearchErrorCode | null;
}

/** The reader the owner has open, or null. */
export const readerState: Signal<ReaderState | null> = signal(null);

type Section = "items" | "sources" | "done";

interface Cursor {
  section: Section;
  /** The cursor for the next request in `section`, or undefined for its first page. */
  next: string | undefined;
  /** The cursor the previous request in this section was made with. */
  last: string | undefined;
  pages: number;
}

let loadToken = 0;
let cursor: Cursor = { section: "items", next: undefined, last: undefined, pages: 0 };

function codeOf(error: unknown): ResearchErrorCode {
  return error instanceof ResearchApiError ? error.code : "unrecognised-response";
}

function update(token: number, patch: Partial<ReaderState>): boolean {
  const current = readerState.value;
  if (token !== loadToken || current === null) return false;
  readerState.value = { ...current, ...patch };
  return true;
}

/** Appends `incoming` to `existing`, keeping the first of any repeated key. */
function mergeBy<T>(
  existing: readonly T[],
  incoming: readonly T[],
  keyOf: (value: T) => number,
): T[] {
  const seen = new Set(existing.map(keyOf));
  const merged = [...existing];
  for (const value of incoming) {
    const key = keyOf(value);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(value);
  }
  return merged;
}

/** Fails the sequence at the current page: a first-page failure before the header, a later one after. */
function fail(token: number, code: ResearchErrorCode): void {
  const current = readerState.value;
  if (token !== loadToken || current === null) return;
  if (current.header === null) update(token, { firstFailure: code });
  else update(token, { laterFailure: code });
}

async function pump(token: number, noteId: string): Promise<void> {
  while (token === loadToken && cursor.section !== "done") {
    const section = cursor.section;
    const requested = cursor.next;
    // A cursor that repeats the one just used, or too many pages, is a loop and not an answer.
    if (
      cursor.pages >= MAX_PAGES_PER_SECTION ||
      (requested !== undefined && requested === cursor.last)
    ) {
      fail(token, "unrecognised-response");
      return;
    }
    let response: Awaited<ReturnType<ReturnType<typeof researchApi>["report"]>>;
    try {
      response = await researchApi().report(noteId, section, requested);
    } catch (error) {
      fail(token, codeOf(error));
      return;
    }
    if (token !== loadToken) return;
    if (response.page !== section) {
      fail(token, "unrecognised-response");
      return;
    }
    cursor.last = requested;
    cursor.pages += 1;
    if (response.page === "items") {
      const current = readerState.value;
      if (current === null) return;
      // A trimmed page ends the findings: its cursor is not followed, so the line that says some
      // items were left out stays true.
      const ends = response.truncated || response.nextCursor === null;
      update(token, {
        header: current.header ?? response.header,
        items: mergeBy(current.items, response.items, (item) => item.index),
        itemsTruncated: current.itemsTruncated || response.truncated,
        itemsLoaded: ends,
        firstFailure: null,
        laterFailure: null,
      });
      if (ends) cursor = { section: "sources", next: undefined, last: undefined, pages: 0 };
      else cursor.next = response.nextCursor ?? undefined;
    } else {
      const current = readerState.value;
      if (current === null) return;
      const ends = response.truncated || response.nextCursor === null;
      update(token, {
        sources: mergeBy(current.sources ?? [], response.sources, (source) => source.number),
        sourcesTruncated: current.sourcesTruncated || response.truncated,
        sourcesLoaded: ends,
        laterFailure: null,
      });
      if (ends) cursor = { section: "done", next: undefined, last: undefined, pages: 0 };
      else cursor.next = response.nextCursor ?? undefined;
    }
  }
}

function freshState(noteId: string): ReaderState {
  return {
    noteId,
    header: null,
    items: [],
    itemsTruncated: false,
    itemsLoaded: false,
    sources: null,
    sourcesTruncated: false,
    sourcesLoaded: false,
    firstFailure: null,
    laterFailure: null,
  };
}

/**
 * Opens a report: requests its header and first findings page, then the rest automatically. A
 * report opened while another is loading cancels the first (its late answers are dropped).
 */
export async function openReader(noteId: string): Promise<void> {
  const token = ++loadToken;
  readerState.value = freshState(noteId);
  cursor = { section: "items", next: undefined, last: undefined, pages: 0 };
  await pump(token, noteId);
}

/**
 * Tries again after a failure: a failed first page starts over, a failed later page continues at
 * that page, so findings already rendered are never asked for twice.
 */
export async function retryReader(): Promise<void> {
  const current = readerState.value;
  if (current === null) return;
  if (current.header === null) {
    await openReader(current.noteId);
    return;
  }
  const token = ++loadToken;
  readerState.value = { ...current, laterFailure: null };
  await pump(token, current.noteId);
}

/** Leaves the reader: outstanding loads are cancelled and late answers dropped. */
export function closeReader(): void {
  loadToken += 1;
  readerState.value = null;
}

/** Puts the reader back to what a fresh mount sees. */
export function resetReaderState(): void {
  closeReader();
  cursor = { section: "items", next: undefined, last: undefined, pages: 0 };
}
