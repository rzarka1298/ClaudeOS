// RSS and Atom parsing in XML mode (D-09, research R2 and Pitfall 6).
//
// htmlparser2 in `xmlMode` never reads a DTD: a DOCTYPE arrives as a processing instruction
// that this module ignores, a custom entity such as `&xxe;` is left as literal text, and only
// the five predefined and the numeric references decode. A `file:` entity therefore reads
// nothing and a nested-entity bomb expands to nothing. This module has no I/O at all.
//
// Every untrusted field of an entry passes exactly ONE sanitise-and-neutralise step, after the
// XML parser has decoded its entities (security finding 2). Nothing reaches a FeedEntry raw:
//
//   - a body or title declared html (Atom type="html", RSS content:encoded) goes through
//     htmlToText once; xhtml content is filtered from this parser's own XML events by a
//     sanitiser sink (single parse: no re-serialising, no second parse); the output is never
//     parsed again, so a decoded `&lt;script&gt;` stays literal text;
//   - plain text (no type, type text, RSS description) is stripped of control, format and bidi
//     characters, whitespace-normalised and kept literal (counted for command-like lines);
//   - titles and authors are identity fields: when decoded text still carries a tag it goes
//     through htmlToText once, so `<script>` and `<img onerror>` are dropped and counted;
//   - every field then has delimiter-like tokens neutralised and is capped;
//   - links are validated by canonicaliseUrl and replaced by the canonical form, or dropped and
//     counted in linksDropped; they are never put in text;
//   - an Atom author contributes its name only: email and uri children are never read.
//
// The report adds up the counts of every field of every KEPT entry.

import { Parser } from "htmlparser2";
import { canonicaliseUrl } from "./canonical-url.js";
import {
  addReport,
  createMarkupSink,
  type HtmlToTextResult,
  htmlToText,
  type MarkupSink,
  type MutableSanitiseReport,
  newReport,
  type SanitiseReport,
  writeInChunks,
} from "./html-to-text.js";
import {
  collapseLines,
  collapseToOneLine,
  countCommandLikeLines,
  neutraliseDelimiterTokens,
  stripUnsafeChars,
  truncateAtBoundary,
} from "./plain-text.js";

export interface FeedEntry {
  readonly title: string;
  /** The canonical https address (see canonicaliseUrl), or null when the feed gave none that is valid. */
  readonly link: string | null;
  /** An ISO instant, or null when the feed gave none or one that does not parse. */
  readonly updated: string | null;
  readonly author: string | null;
  readonly text: string;
}

export interface ParsedFeed {
  readonly format: "atom" | "rss" | "unknown";
  readonly entries: readonly FeedEntry[];
  readonly report: SanitiseReport;
}

/** Elements nested deeper than this are ignored. */
const MAX_FEED_DEPTH = 512;
/** Entries kept per feed, newest first. */
const KEEP_ENTRIES = 5;
/** Entries looked at per feed; a feed with more is read from its start. */
const MAX_SCANNED_ENTRIES = 1_000;
/** Each entry's text is capped here after sanitising. */
const TEXT_CAP = 4_000;
/** Titles and authors are capped here after sanitising. */
const IDENTITY_CAP = 200;
/** Raw characters collected per field before sanitising. */
const RAW_FIELD_CAP = 262_144;
/** A feed longer than this many characters is cut; the remainder is dropped and counted. */
export const MAX_FEED_INPUT_CHARS = 1_048_576;

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const ZONE_HOURS: Readonly<Record<string, number>> = {
  z: 0,
  ut: 0,
  gmt: 0,
  est: -5,
  edt: -4,
  cst: -6,
  cdt: -5,
  mst: -7,
  mdt: -6,
  pst: -8,
  pdt: -7,
};

function instantFromParts(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millis: number,
  offsetMinutes: number,
): string | null {
  const ms = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  const check = new Date(ms);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute
  ) {
    return null;
  }
  const shifted = new Date(ms - offsetMinutes * 60_000);
  return Number.isNaN(shifted.getTime()) ? null : shifted.toISOString();
}

const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?\s*(Z|z|[+-]\d{2}:?\d{2})?)?$/;
const RFC822_INSTANT =
  /^(?:[A-Za-z]{3},?\s+)?(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*([A-Za-z]{1,3}|[+-]\d{4})?$/;

/** Parses the two date forms feeds use. Anything else is null, never a guess. */
export function parseFeedInstant(raw: string): string | null {
  const value = raw.trim();
  if (value === "" || value.length > 64) return null;
  const iso = ISO_INSTANT.exec(value);
  if (iso !== null) {
    const zone = iso[8];
    let offset = 0;
    if (zone !== undefined && zone.toLowerCase() !== "z") {
      const sign = zone.startsWith("-") ? -1 : 1;
      const digits = zone.slice(1).replace(":", "");
      offset = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
    }
    return instantFromParts(
      Number(iso[1]),
      Number(iso[2]),
      Number(iso[3]),
      Number(iso[4] ?? 0),
      Number(iso[5] ?? 0),
      Number(iso[6] ?? 0),
      Math.floor(Number(`0.${iso[7] ?? "0"}`) * 1000),
      offset,
    );
  }
  const rfc = RFC822_INSTANT.exec(value);
  if (rfc !== null) {
    const month = MONTHS[(rfc[2] ?? "").toLowerCase()];
    if (month === undefined) return null;
    let year = Number(rfc[3]);
    if ((rfc[3] ?? "").length === 2) year += year < 50 ? 2000 : 1900;
    const zone = (rfc[7] ?? "z").toLowerCase();
    let offset = 0;
    if (/^[+-]\d{4}$/.test(zone)) {
      const sign = zone.startsWith("-") ? -1 : 1;
      offset = sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5)));
    } else if (zone in ZONE_HOURS) {
      offset = (ZONE_HOURS[zone] ?? 0) * 60;
    } else {
      return null;
    }
    return instantFromParts(
      year,
      month,
      Number(rfc[1]),
      Number(rfc[4] ?? 0),
      Number(rfc[5] ?? 0),
      Number(rfc[6] ?? 0),
      0,
      offset,
    );
  }
  return null;
}

interface RawField {
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  text: string;
  /** True when the raw text hit RAW_FIELD_CAP and the rest was dropped. */
  cut: boolean;
  nameText: string;
  /** Set for type="xhtml": the sanitiser sink the field's child events are fed to. */
  sink: MarkupSink | undefined;
}

interface RawEntry {
  readonly fields: RawField[];
}

function plain(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function append(current: string, addition: string): string {
  const room = RAW_FIELD_CAP - current.length;
  if (room <= 0) return current;
  return current + (addition.length > room ? addition.slice(0, room) : addition);
}

type BodyMode = "html" | "xhtml" | "text" | "ignore";

function modeOf(field: RawField): BodyMode {
  if (field.name === "content:encoded") return "html";
  const type = (field.attrs.type ?? "").trim().toLowerCase();
  if (type === "" || type === "text" || type === "text/plain") return "text";
  if (type === "html" || type === "text/html") return "html";
  if (type === "xhtml" || type === "application/xhtml+xml") return "xhtml";
  return "ignore";
}

type Candidate =
  | { readonly mode: "text"; readonly source: string; readonly cut: boolean }
  | { readonly mode: "markup"; readonly run: () => HtmlToTextResult; readonly cut: boolean };

function candidatesFor(entry: RawEntry, names: readonly string[]): Candidate[] {
  const out: Candidate[] = [];
  for (const name of names) {
    for (const field of entry.fields) {
      if (field.name !== name) continue;
      const mode = modeOf(field);
      if (mode === "ignore") continue;
      if (mode === "xhtml") {
        const sink = field.sink;
        if (sink !== undefined) out.push({ mode: "markup", run: () => sink.finish(), cut: false });
      } else if (field.text.trim() !== "") {
        const source = field.text;
        if (mode === "html")
          out.push({ mode: "markup", run: () => htmlToText(source), cut: field.cut });
        else out.push({ mode: "text", source, cut: field.cut });
      }
    }
  }
  return out;
}

type FieldKind = "identity" | "body";

const TAG_LIKE = /<[A-Za-z!/?]/;

/** The one sanitise-and-neutralise step for a text-typed field. */
function sanitisePlain(source: string, kind: FieldKind, report: MutableSanitiseReport): string {
  const stripped = stripUnsafeChars(source);
  report.controlChars += stripped.removed;
  let text = stripped.text;
  if (kind === "identity" && TAG_LIKE.test(text)) {
    // A title or an author that still carries a tag after decoding: one htmlToText pass.
    const result = htmlToText(text);
    addReport(report, result.report);
    text = result.text;
  }
  return kind === "identity" ? collapseToOneLine(text) : collapseLines(text);
}

/** The one sanitise-and-neutralise step for a markup-typed field (already filtered once). */
function sanitiseMarkup(
  result: HtmlToTextResult,
  kind: FieldKind,
  report: MutableSanitiseReport,
): string {
  addReport(report, result.report);
  return kind === "identity" ? collapseToOneLine(result.text) : result.text;
}

/**
 * Sanitises the first candidate that still has text afterwards. Candidates tried before it have
 * their counts added too: they were removed from the source even though another field won.
 */
function sanitiseFirst(
  candidates: readonly Candidate[],
  kind: FieldKind,
  cap: number,
  report: MutableSanitiseReport,
): string {
  for (const candidate of candidates) {
    // A field cut at the raw cap lost its tail: count it, as any dropped remainder is counted.
    if (candidate.cut) report.hiddenBlocks += 1;
    const raw =
      candidate.mode === "text"
        ? sanitisePlain(candidate.source, kind, report)
        : sanitiseMarkup(candidate.run(), kind, report);
    const neutralised = neutraliseDelimiterTokens(raw);
    const text = truncateAtBoundary(neutralised.text, cap).trim();
    if (text === "") continue;
    if (kind === "body" && candidate.mode === "text") {
      report.commandLikeLines += countCommandLikeLines(text);
    }
    return text;
  }
  return "";
}

function firstRawText(entry: RawEntry, names: readonly string[]): string {
  for (const name of names) {
    for (const field of entry.fields) {
      if (field.name === name && plain(field.text) !== "") return plain(field.text);
    }
  }
  return "";
}

function pickLink(entry: RawEntry): string | null {
  const links = entry.fields.filter((f) => f.name === "link");
  const preferred =
    links.find(
      (f) =>
        f.attrs.href !== undefined && (f.attrs.rel === undefined || f.attrs.rel === "alternate"),
    ) ??
    links.find((f) => f.attrs.href !== undefined) ??
    links.find((f) => plain(f.text) !== "");
  if (preferred === undefined) return null;
  const value = (preferred.attrs.href ?? plain(preferred.text)).trim();
  return value === "" ? null : value;
}

function authorCandidates(entry: RawEntry): Candidate[] {
  const out: Candidate[] = [];
  for (const field of entry.fields) {
    if (field.name !== "author") continue;
    // The name child of an Atom author, else the direct text of an RSS author. Email and uri
    // children were never collected.
    const source = field.nameText.trim() !== "" ? field.nameText : field.text;
    if (source.trim() !== "") out.push({ mode: "text", source, cut: false });
  }
  for (const field of entry.fields) {
    if (field.name === "dc:creator" && field.text.trim() !== "") {
      out.push({ mode: "text", source: field.text, cut: false });
    }
  }
  return out;
}

function toEntry(raw: RawEntry, report: MutableSanitiseReport): FeedEntry {
  const title = sanitiseFirst(candidatesFor(raw, ["title"]), "identity", IDENTITY_CAP, report);
  const author = sanitiseFirst(authorCandidates(raw), "identity", IDENTITY_CAP, report);
  const text = sanitiseFirst(
    candidatesFor(raw, ["content:encoded", "content", "summary", "description"]),
    "body",
    TEXT_CAP,
    report,
  );
  const rawLink = pickLink(raw);
  let link: string | null = null;
  if (rawLink !== null) {
    const canonical = canonicaliseUrl(rawLink);
    if (canonical.ok) link = canonical.url;
    else report.linksDropped += 1;
  }
  return { title, link, updated: instantOf(raw), author: author === "" ? null : author, text };
}

function instantOf(raw: RawEntry): string | null {
  return parseFeedInstant(firstRawText(raw, ["updated", "published", "pubdate", "dc:date"]));
}

/** Newest first; dated entries before undated ones; document order among equals. */
function newest(entries: readonly RawEntry[]): RawEntry[] {
  return entries
    .map((entry, index) => ({ entry, index, instant: instantOf(entry) }))
    .sort((a, b) => {
      if (a.instant !== null && b.instant !== null && a.instant !== b.instant) {
        return a.instant < b.instant ? 1 : -1;
      }
      if ((a.instant === null) !== (b.instant === null)) return a.instant === null ? 1 : -1;
      return a.index - b.index;
    })
    .slice(0, KEEP_ENTRIES)
    .map((item) => item.entry);
}

function cutInput(text: string, limit: number): string {
  const last = text.charCodeAt(limit - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit);
}

export function parseFeed(xml: string): ParsedFeed {
  const entries: RawEntry[] = [];
  const path: string[] = [];
  let overflow = 0;
  let format: ParsedFeed["format"] = "unknown";
  let current: RawEntry | null = null;
  let entryDepth = 0;
  let field: RawField | null = null;
  let lastOpenStart = -1;

  const parser = new Parser(
    {
      onopentag(rawName, attribs) {
        lastOpenStart = parser.startIndex;
        if (overflow > 0 || path.length >= MAX_FEED_DEPTH) {
          overflow += 1;
          return;
        }
        const name = rawName.toLowerCase();
        path.push(name);
        if (path.length === 1) {
          if (name === "feed") format = "atom";
          else if (name === "rss" || name === "rdf:rdf" || name === "rdf") format = "rss";
        }
        if (current === null) {
          if (name === "entry" || name === "item") {
            current = { fields: [] };
            entryDepth = path.length;
          }
          return;
        }
        const relative = path.length - entryDepth;
        if (relative === 1) {
          const type = (attribs.type ?? "").trim().toLowerCase();
          const xhtml = type === "xhtml" || type === "application/xhtml+xml";
          field = {
            name,
            attrs: { ...attribs },
            text: "",
            cut: false,
            nameText: "",
            sink: xhtml ? createMarkupSink({ xml: true }) : undefined,
          };
          current.fields.push(field);
        } else if (field !== null && field.sink !== undefined) {
          field.sink.open(rawName, attribs);
        }
      },
      ontext(data) {
        if (overflow > 0 || current === null || field === null) return;
        const relative = path.length - entryDepth;
        if (field.sink !== undefined) {
          field.sink.text(data);
          return;
        }
        if (field.name === "author") {
          if (relative === 2 && path[path.length - 1] === "name") {
            field.nameText = append(field.nameText, data);
          } else if (relative === 1) {
            field.text = append(field.text, data);
          }
          return;
        }
        if (field.text.length + data.length > RAW_FIELD_CAP) field.cut = true;
        field.text = append(field.text, data);
      },
      oncomment() {
        if (overflow > 0 || current === null || field === null) return;
        // Counted by the sanitiser; the comment's own text is never read.
        field.sink?.comment();
      },
      onclosetag(_name, implied) {
        if (overflow > 0) {
          overflow -= 1;
          return;
        }
        if (current !== null) {
          const relative = path.length - entryDepth;
          if (field !== null && field.sink !== undefined && relative >= 2) {
            field.sink.close(
              path[path.length - 1] ?? "",
              implied,
              parser.startIndex === lastOpenStart,
            );
          }
          if (relative === 1) field = null;
          if (relative === 0) {
            if (entries.length < MAX_SCANNED_ENTRIES) entries.push(current);
            current = null;
            field = null;
          }
        }
        path.pop();
      },
    },
    { xmlMode: true },
  );
  // An input past the cap is cut before any parsing, and the remainder is counted. The parser is
  // fed in small pieces and not fed any more once the element depth cap tripped: it would only
  // keep growing its stack (quadratic) for elements nobody reads.
  const input = xml.length > MAX_FEED_INPUT_CHARS ? cutInput(xml, MAX_FEED_INPUT_CHARS) : xml;
  let droppedRemainder = input.length < xml.length;
  try {
    const written = writeInChunks(
      (chunk) => parser.write(chunk),
      input,
      () => overflow > 0,
    );
    if (written === input.length && overflow === 0) parser.end();
    else droppedRemainder = true;
  } catch {
    // A failed parse keeps the entries that were completed before it and drops the one in
    // progress: half an entry is not a decision.
  }

  const report = newReport();
  const kept = newest(entries).map((raw) => toEntry(raw, report));
  // A cut input or a stopped parse is a dropped remainder, counted like the page sanitiser's.
  if (droppedRemainder) report.hiddenBlocks += 1;
  return { format, entries: kept, report };
}

/**
 * One text block for a feed: each entry is its title, then its text, entries separated by a
 * blank line. The first line of a block is therefore always an entry title. Every value was
 * sanitised by parseFeed; the link is not part of the text.
 */
export function renderFeedText(entries: readonly FeedEntry[]): string {
  return entries
    .map((entry) => (entry.text === "" ? entry.title : `${entry.title}\n${entry.text}`))
    .join("\n\n");
}
