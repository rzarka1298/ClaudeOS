// The trusted stage for the summariser's answer (plan 07-07, D-06, D-15, research Pattern 6).
//
// The answer is untrusted data. It is parsed strictly as one JSON object with an `items` array,
// and each item is then checked on its own, in this order:
//
//   1. the item schema (kind, text, citedSourceIds, optional quote; no other key): a failure, or
//      a kind outside the three report kinds (a recommendation included), drops the item;
//   2. cited ids that were not fetched in this run are dropped;
//   3. a source-fact or an unverified-claim keeps its kind only when it carries a quote of at
//      least the domain minimum (characters and words, after normalisation) that is found
//      verbatim, after the shared normalisation, in a cited source's sanitised text; it then
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
  REPORT_ITEM_QUOTE_MIN_LENGTH,
  REPORT_ITEM_QUOTE_MIN_WORDS,
  REPORT_ITEM_TEXT_MAX_LENGTH,
  REPORT_ITEMS_MAX,
  type ReportItem,
  ReportItemSchema,
} from "@ccc/domain";
import { neutraliseUntrustedSpan } from "./neutralise.js";
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

/** Long enough, and with enough words, to verify anything (the minimums live in the domain). */
function isSubstantialQuote(normalised: string): boolean {
  if (normalised.length < REPORT_ITEM_QUOTE_MIN_LENGTH) return false;
  return normalised.split(" ").length >= REPORT_ITEM_QUOTE_MIN_WORDS;
}

/** Removes at most one surrounding code fence. Anything else around the JSON is left to fail the parse. */
function stripFence(answer: string): string {
  const trimmed = answer.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const match = FENCE.exec(trimmed);
  return match === null ? trimmed : (match[1] ?? "").trim();
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(answer));
  } catch {
    return INVALID;
  }
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

    const holders = (candidateQuote: string): string[] =>
      surviving.filter((id) => (sourceText(id) ?? "").includes(candidateQuote));

    // The quote is checked as the model wrote it (after the shared normalisation), then the
    // SOURCE's own text is stored, neutralised and cut, and that stored form is checked again:
    // an address marker or a cut must not leave a quote the source does not hold.
    let kind = claimedKind;
    let ids: readonly string[] = surviving;
    let storedQuote: string | undefined;
    const needle = quote === undefined ? "" : normaliseForMatch(quote);
    const firstHolder = isSubstantialQuote(needle) ? holders(needle)[0] : undefined;
    if (firstHolder !== undefined) {
      const source = sourceText(firstHolder) ?? "";
      const at = source.indexOf(needle);
      const clean = neutraliseUntrustedSpan(
        source.slice(at, at + needle.length),
        REPORT_ITEM_QUOTE_MAX_LENGTH,
      );
      addressesRemoved += clean.addressesRemoved;
      controlCharsRemoved += clean.controlCharsRemoved;
      if (clean.truncated) truncated += 1;
      const stillHeld = isSubstantialQuote(clean.text) ? holders(clean.text) : [];
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
