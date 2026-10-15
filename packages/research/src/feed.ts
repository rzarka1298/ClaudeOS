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
//     htmlToText once; xhtml content is re-serialised with every text node escaped and goes
//     through htmlToText once; the output is never parsed again, so a decoded `&lt;script&gt;`
//     stays literal text;
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
  htmlToText,
  type MutableSanitiseReport,
  newReport,
  type SanitiseReport,
  VOID_ELEMENTS,
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
/** Attribute values re-serialised from xhtml content are cut here. */
const ATTRIBUTE_CAP = 4_096;

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
  nameText: string;
  /** Set for type="xhtml": the re-serialised child markup, text nodes escaped. */
  xhtml: string | undefined;
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

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value.slice(0, ATTRIBUTE_CAP)).replace(/"/g, "&quot;");
}

const ELEMENT_NAME = /^[A-Za-z][A-Za-z0-9:_.-]*$/;
const ATTRIBUTE_NAME = /^[A-Za-z_:][A-Za-z0-9_:.-]*$/;

function serialiseOpen(name: string, attribs: Readonly<Record<string, string>>): string {
  if (!ELEMENT_NAME.test(name)) return "";
  let out = `<${name}`;
  for (const [key, value] of Object.entries(attribs)) {
    if (ATTRIBUTE_NAME.test(key)) out += ` ${key}="${escapeAttribute(value)}"`;
  }
  return `${out}>`;
}

function serialiseClose(name: string): string {
  if (!ELEMENT_NAME.test(name) || VOID_ELEMENTS.has(name)) return "";
  return `</${name}>`;
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

interface Candidate {
  readonly mode: BodyMode;
  readonly source: string;
}

function candidatesFor(entry: RawEntry, names: readonly string[]): Candidate[] {
  const out: Candidate[] = [];
  for (const name of names) {
    for (const field of entry.fields) {
      if (field.name !== name) continue;
      const mode = modeOf(field);
      if (mode === "ignore") continue;
      const source = mode === "xhtml" ? (field.xhtml ?? "") : field.text;
      if (source.trim() !== "") out.push({ mode, source });
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

/** The one sanitise-and-neutralise step for a markup-typed field. */
function sanitiseMarkup(source: string, kind: FieldKind, report: MutableSanitiseReport): string {
  const result = htmlToText(source);
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
    const raw =
      candidate.mode === "text"
        ? sanitisePlain(candidate.source, kind, report)
        : sanitiseMarkup(candidate.source, kind, report);
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
    if (source.trim() !== "") out.push({ mode: "text", source });
  }
  for (const field of entry.fields) {
    if (field.name === "dc:creator" && field.text.trim() !== "") {
      out.push({ mode: "text", source: field.text });
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

export function parseFeed(xml: string): ParsedFeed {
  const entries: RawEntry[] = [];
  const path: string[] = [];
  let overflow = 0;
  let format: ParsedFeed["format"] = "unknown";
  let current: RawEntry | null = null;
  let entryDepth = 0;
  let field: RawField | null = null;

  const parser = new Parser(
    {
      onopentag(rawName, attribs) {
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
            nameText: "",
            xhtml: xhtml ? "" : undefined,
          };
          current.fields.push(field);
        } else if (field !== null && field.xhtml !== undefined) {
          field.xhtml = append(field.xhtml, serialiseOpen(name, attribs));
        }
      },
      ontext(data) {
        if (overflow > 0 || current === null || field === null) return;
        const relative = path.length - entryDepth;
        if (field.xhtml !== undefined) field.xhtml = append(field.xhtml, escapeText(data));
        if (field.name === "author") {
          if (relative === 2 && path[path.length - 1] === "name") {
            field.nameText = append(field.nameText, data);
          } else if (relative === 1) {
            field.text = append(field.text, data);
          }
          return;
        }
        field.text = append(field.text, data);
      },
      oncomment() {
        if (overflow > 0 || current === null || field === null) return;
        // Counted by the sanitiser, which sees an empty comment. The comment's own text is never
        // copied: a comment body can end early under the HTML rules.
        if (field.xhtml !== undefined) field.xhtml = append(field.xhtml, "<!---->");
      },
      onclosetag() {
        if (overflow > 0) {
          overflow -= 1;
          return;
        }
        if (current !== null) {
          const relative = path.length - entryDepth;
          if (field !== null && field.xhtml !== undefined && relative >= 2) {
            field.xhtml = append(field.xhtml, serialiseClose(path[path.length - 1] ?? ""));
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
  parser.write(xml);
  parser.end();

  const report = newReport();
  const kept = newest(entries).map((raw) => toEntry(raw, report));
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
