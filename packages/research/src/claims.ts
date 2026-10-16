// The trusted stage for the summariser's answer (plan 07-07, D-06, D-15, research Pattern 6).
//
// The answer is untrusted data. It is parsed strictly as one JSON object with an `items` array,
// and each item is then checked on its own, in this order:
//
//   1. the item schema (kind, text, citedSourceIds, optional quote; no other key): a failure, or
//      a kind outside the three report kinds (a recommendation included), drops the item;
//   2. cited ids that were not fetched in this run are dropped;
//   3. a source-fact or an unverified-claim keeps its kind only when it carries a quote of at
//      least the domain minimum (characters, and words that carry a letter or digit, after
//      normalisation) that is found verbatim, after the shared normalisation, on whole words
//      (it may not start or stop inside a word) in a cited source's sanitised text; it then
//      cites only the sources whose text holds the quote. Otherwise it becomes inference with
//      its surviving ids;
//   4. an item with no ids is inference;
//   5. the quote that is stored is the SOURCE's own text, neutralised and cut, and it is checked
//      against the sources again afterwards: an address marker or a cut must not leave a quote
//      the source does not hold (the item is then inference). Text is neutralised too;
//   6. the domain item schema has the last word.
//
// A stored quote is always a verified quote: an item that fails the check loses its quote.
// A whole answer that is not exactly the strict shape is the summariser-invalid-output outcome.
// The function never throws, whatever it is given.

import {
  REPORT_CITED_IDS_MAX,
  REPORT_ITEM_KINDS,
  REPORT_ITEM_QUOTE_MAX_LENGTH,
  REPORT_ITEM_TEXT_MAX_LENGTH,
  REPORT_ITEMS_MAX,
  type ReportItem,
  ReportItemSchema,
} from "@ccc/domain";
import { neutraliseUntrustedSpan } from "./neutralise.js";
import { quoteInNormalisedSource } from "./quote-match.js";
import { normaliseForMatch } from "./text-canon.js";

export interface ClaimCounts {
  /** Items dropped: failed the item schema, an unknown kind, or empty after neutralising. */
  readonly droppedItems: number;
  /** Cited ids dropped because they were not fetched in this run. */
  readonly droppedIds: number;
  /** Cited ids a fact or claim lost because their text does not hold its quote. */
  readonly narrowedIds: number;
  /** Facts and claims turned into inference. */
  readonly downgraded: number;
  readonly addressesRemoved: number;
  readonly controlCharsRemoved: number;
  /** Texts and quotes cut at their length limit. */
  readonly truncated: number;
}

export interface ValidateSummariserOptions {
  /** Each fetched source id mapped to its sanitised text. */
  readonly sources: Readonly<Record<string, string>>;
}

export type SummariserValidation =
  | { readonly ok: true; readonly items: readonly ReportItem[]; readonly counts: ClaimCounts }
  | { readonly ok: false; readonly code: "summariser-invalid-output" };

const INVALID: SummariserValidation = { ok: false, code: "summariser-invalid-output" };

/** An answer above this many characters is refused before it is parsed. */
export const SUMMARISER_ANSWER_MAX_CHARS = 512 * 1024;

const FENCE = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** True when the object has exactly these keys, or these keys without the optional ones. */
function hasOnlyKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

interface RawItem {
  readonly kind: ReportItem["kind"];
  readonly text: string;
  readonly citedSourceIds: readonly string[];
  readonly quote: string | undefined;
}

/** The strict item shape: the four keys and nothing else, with the right types. */
function readRawItem(candidate: unknown): RawItem | null {
  if (!isPlainRecord(candidate)) return null;
  if (!hasOnlyKeys(candidate, ["kind", "text", "citedSourceIds"], ["quote"])) return null;
  const { kind, text, citedSourceIds, quote } = candidate;
  if (typeof kind !== "string" || !(REPORT_ITEM_KINDS as readonly string[]).includes(kind)) {
    return null;
  }
  if (typeof text !== "string") return null;
  if (
    !Array.isArray(citedSourceIds) ||
    citedSourceIds.length > REPORT_CITED_IDS_MAX ||
    !citedSourceIds.every((id): id is string => typeof id === "string")
  ) {
    return null;
  }
  if (quote !== undefined && typeof quote !== "string") return null;
  return { kind: kind as ReportItem["kind"], text, citedSourceIds, quote };
}

/**
 * Removes one surrounding code fence, or none. A fence must be the whole answer: text before it,
 * text after it, a second fence or an unterminated fence returns null (invalid output) instead
 * of a partly parsed answer.
 */
function stripFence(answer: string): string | null {
  const trimmed = answer.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const match = FENCE.exec(trimmed);
  if (match === null) return null;
  const body = (match[1] ?? "").trim();
  return /^```|\n```/.test(body) ? null : body;
}

/** Keys that could reach an object's prototype; they are refused wherever they appear. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/**
 * True when the JSON text (already known to parse) has a duplicate key in any one object, at any
 * depth, or a forbidden key. JSON.parse keeps the LAST of a duplicated key, so a duplicate could
 * flip a field after the shape check read the first. Keys are compared after decoding, so an
 * escaped spelling of a key counts as that key. The scan is iterative and linear.
 */
function hasDuplicateOrForbiddenKey(json: string): boolean {
  interface Frame {
    readonly object: boolean;
    readonly keys: Set<string>;
    expectKey: boolean;
  }
  const stack: Frame[] = [];
  let i = 0;
  while (i < json.length) {
    const ch = json.charAt(i);
    if (ch === "{") {
      stack.push({ object: true, keys: new Set(), expectKey: true });
    } else if (ch === "[") {
      stack.push({ object: false, keys: new Set(), expectKey: false });
    } else if (ch === "}" || ch === "]") {
      stack.pop();
    } else if (ch === ",") {
      const top = stack[stack.length - 1];
      if (top?.object === true) top.expectKey = true;
    } else if (ch === '"') {
      let end = i + 1;
      while (end < json.length && json.charAt(end) !== '"')
        end += json.charAt(end) === "\\" ? 2 : 1;
      const top = stack[stack.length - 1];
      if (top?.object === true && top.expectKey) {
        const key: unknown = JSON.parse(json.slice(i, end + 1));
        if (typeof key !== "string" || FORBIDDEN_KEYS.has(key) || top.keys.has(key)) return true;
        top.keys.add(key);
        top.expectKey = false;
      }
      i = end;
    }
    i += 1;
  }
  return false;
}

export function validateSummariserOutput(
  answer: string,
  options: ValidateSummariserOptions,
): SummariserValidation {
  try {
    return validate(answer, options);
  } catch {
    return INVALID;
  }
}

function validate(answer: string, options: ValidateSummariserOptions): SummariserValidation {
  if (typeof answer !== "string" || answer.length > SUMMARISER_ANSWER_MAX_CHARS) return INVALID;
  const json = stripFence(answer);
  if (json === null) return INVALID;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return INVALID;
  }
  if (hasDuplicateOrForbiddenKey(json)) return INVALID;
  if (!isPlainRecord(parsed) || !hasOnlyKeys(parsed, ["items"], [])) return INVALID;
  const candidates = parsed.items;
  if (!Array.isArray(candidates) || candidates.length > REPORT_ITEMS_MAX) return INVALID;

  const normalisedSources = new Map<string, string>();
  const sourceText = (id: string): string | null => {
    if (!Object.hasOwn(options.sources, id)) return null;
    let cached = normalisedSources.get(id);
    if (cached === undefined) {
      const raw = options.sources[id];
      cached = typeof raw === "string" ? normaliseForMatch(raw) : "";
      normalisedSources.set(id, cached);
    }
    return cached;
  };

  let droppedItems = 0;
  let droppedIds = 0;
  let narrowedIds = 0;
  let downgraded = 0;
  let addressesRemoved = 0;
  let controlCharsRemoved = 0;
  let truncated = 0;
  const items: ReportItem[] = [];

  for (const candidate of candidates) {
    const raw = readRawItem(candidate);
    if (raw === null) {
      droppedItems += 1;
      continue;
    }
    const { kind: claimedKind, text, quote } = raw;

    const surviving: string[] = [];
    for (const id of new Set(raw.citedSourceIds)) {
      if (sourceText(id) === null) droppedIds += 1;
      else surviving.push(id);
    }

    const cleanText = neutraliseUntrustedSpan(text, REPORT_ITEM_TEXT_MAX_LENGTH);
    addressesRemoved += cleanText.addressesRemoved;
    controlCharsRemoved += cleanText.controlCharsRemoved;
    if (cleanText.truncated) truncated += 1;
    if (cleanText.text === "") {
      droppedItems += 1;
      continue;
    }

    // The model's quote is put in the comparison form and verified by the ONE shared predicate. The text
    // that is stored is that verified source text, neutralised, and it is verified again by the
    // same predicate: an address marker must not leave a quote the source does not hold.
    const holders = (candidate: string): string[] =>
      surviving.filter((id) => quoteInNormalisedSource(sourceText(id) ?? "", candidate));
    let kind = claimedKind;
    let ids: readonly string[] = surviving;
    let storedQuote: string | undefined;
    const wanted = quote === undefined ? "" : normaliseForMatch(quote);
    // A quote over the cap is never stored as a prefix: the cut could drop a trailing qualifier
    // ("... except when the cache is cold"). It counts as truncated and the item loses its quote.
    if (wanted.length > REPORT_ITEM_QUOTE_MAX_LENGTH) {
      truncated += 1;
    } else if (holders(wanted).length > 0) {
      const clean = neutraliseUntrustedSpan(wanted, REPORT_ITEM_QUOTE_MAX_LENGTH);
      addressesRemoved += clean.addressesRemoved;
      controlCharsRemoved += clean.controlCharsRemoved;
      if (clean.truncated) truncated += 1;
      const stillHeld = clean.truncated ? [] : holders(clean.text);
      if (stillHeld.length > 0) {
        storedQuote = clean.text;
        if (kind !== "inference") {
          narrowedIds += surviving.length - stillHeld.length;
          ids = stillHeld;
        }
      }
    }
    if (kind !== "inference" && storedQuote === undefined) {
      kind = "inference";
      downgraded += 1;
    }
    const item: Record<string, unknown> = { kind, text: cleanText.text };
    if (storedQuote !== undefined) item.quote = storedQuote;
    item.citedSourceIds = ids;
    const checked = ReportItemSchema.safeParse(item);
    if (!checked.success) {
      droppedItems += 1;
      continue;
    }
    items.push(checked.data);
  }

  return {
    ok: true,
    items,
    counts: {
      droppedItems,
      droppedIds,
      narrowedIds,
      downgraded,
      addressesRemoved,
      controlCharsRemoved,
      truncated,
    },
  };
}
