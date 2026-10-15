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
//   - an Atom author contributes its name only: email and uri children are never read, and an
//     RSS author written as an address keeps the name part and drops the address;
//   - an RSS body (description, summary, content without a type) is entity-encoded HTML by
//     specification: it is sanitised once, after XML decoding. Only an Atom text construct (no
//     type, or type text) is literal text, and it is never re-parsed;
//   - elements are matched by namespace and local name after resolving xmlns bindings, so
//     `atom:entry` is an entry whatever prefix the feed picked, and an element in a namespace this
//     parser does not know (or a field nested under one) is ignored.
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

const NS_ATOM = "http://www.w3.org/2005/Atom";
const NS_RSS10 = "http://purl.org/rss/1.0/";
const NS_CONTENT = "http://purl.org/rss/1.0/modules/content/";
const NS_DC = "http://purl.org/dc/elements/1.1/";
const NS_RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";

/**
 * Prefixes that are taken at their conventional binding when a feed uses them without declaring
 * them (a common mistake in real feeds). Any other undeclared prefix is an unknown namespace.
 */
const CONVENTIONAL_PREFIXES: ReadonlyMap<string, string> = new Map([
  ["atom", NS_ATOM],
  ["content", NS_CONTENT],
  ["dc", NS_DC],
  ["rdf", NS_RDF],
]);

/**
 * A namespace binding table: prefix (lower case, "" is the default namespace) to namespace. Once
 * any declaration of the feed was dropped for a cap (RegistryLosses.namespaces), an undeclared
 * prefix is an unknown namespace rather than its conventional one: the feed fails closed.
 */
interface Bindings {
  readonly map: ReadonlyMap<string, string>;
  /**
   * True in an element that dropped a declaration (budget, full table, over-long value) and in
   * everything below it: every name there is unknown, so a discarded redeclaration cannot leave
   * the parent's binding in force.
   */
  readonly poisoned: boolean;
}

/** More prefixes than this on the elements leading to an element are not bound. */
const MAX_BINDINGS = 64;
/** More xmlns declarations than this in one feed are not bound (the feed is counted). */
const MAX_DECLARATIONS = 2_048;
/** A namespace value longer than this is an unknown namespace: never trimmed or cut into a match. */
const MAX_NAMESPACE_CHARS = 256;
/** Fields kept per entry; later children of the entry are not read. */
const MAX_FIELDS_PER_ENTRY = 64;
/** An attribute the parser reads (type, href, rel) longer than this is dropped. */
const MAX_ATTRIBUTE_CHARS = 4_096;

const NO_BINDINGS: Bindings = { map: new Map(), poisoned: false };

/** What the registries refused to hold for this feed, counted once each in the report. */
interface RegistryLosses {
  namespaces: boolean;
  fields: boolean;
  attributes: boolean;
  declarations: number;
}

/**
 * The bindings in force inside an element with these attributes. The table is copied only when a
 * declaration changes it, and never grows past MAX_BINDINGS entries; a declaration that is
 * over-long, past the per-feed budget or past the table size is not bound and closes the scope.
 */
function bindingsFor(
  parent: Bindings,
  attribs: Readonly<Record<string, string>>,
  losses: RegistryLosses,
): Bindings {
  let next: Map<string, string> | null = null;
  let poisoned = parent.poisoned;
  for (const [name, value] of Object.entries(attribs)) {
    // XML is case-sensitive: `xmlns` and the prefix are taken exactly as written, so `xmlns:X`
    // never rebinds `x` and `XMLNS:x` is not a declaration at all.
    let prefix: string;
    if (name === "xmlns") prefix = "";
    else if (name.startsWith("xmlns:")) prefix = name.slice(6);
    else continue;
    losses.declarations += 1;
    if (losses.declarations > MAX_DECLARATIONS || value.length > MAX_NAMESPACE_CHARS) {
      losses.namespaces = true;
      poisoned = true;
      continue;
    }
    next ??= new Map(parent.map);
    if (next.size >= MAX_BINDINGS && !next.has(prefix)) {
      losses.namespaces = true;
      poisoned = true;
      continue;
    }
    next.set(prefix, value);
  }
  if (next === null && poisoned === parent.poisoned) return parent;
  return { map: next ?? parent.map, poisoned };
}

/**
 * The attributes the parser reads, each capped; anything else is not kept. Null when the `type`
 * discriminator is over the cap: the field is rejected, never defaulted to text.
 */
function readAttributes(
  attribs: Readonly<Record<string, string>>,
  losses: RegistryLosses,
): Record<string, string> | null {
  const kept: Record<string, string> = {};
  for (const key of ["type", "href", "rel"]) {
    const value = attribs[key];
    if (value === undefined) continue;
    if (value.length > MAX_ATTRIBUTE_CHARS) {
      losses.attributes = true;
      if (key === "type") return null;
    } else {
      kept[key] = value;
    }
  }
  return kept;
}

/**
 * The field name the rest of this module uses for an element, or "" when the element is not one
 * it knows. Atom and unqualified (RSS 2.0) elements keep their local name; the content module's
 * `encoded` and the Dublin Core `date` and `creator` keep the names `content:encoded`,
 * `dc:date` and `dc:creator`; the RDF root is `rdf:rdf`. Everything else is in some other
 * namespace and is ignored.
 */
function canonicalName(rawName: string, bindings: Bindings, closed: boolean): string {
  const colon = rawName.indexOf(":");
  const local = (colon < 0 ? rawName : rawName.slice(colon + 1)).toLowerCase();
  const namespace =
    colon < 0
      ? (bindings.map.get("") ?? "")
      : (bindings.map.get(rawName.slice(0, colon)) ??
        (closed ? undefined : CONVENTIONAL_PREFIXES.get(rawName.slice(0, colon))));
  if (bindings.poisoned || namespace === undefined) return "";
  if (namespace === "" || namespace === NS_ATOM || namespace === NS_RSS10) return local;
  if (namespace === NS_CONTENT && local === "encoded") return "content:encoded";
  if (namespace === NS_DC && (local === "date" || local === "creator")) return `dc:${local}`;
  if (namespace === NS_RDF && local === "rdf") return "rdf:rdf";
  return "";
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
  /**
   * True when a text field (title, summary, content, description) holds literal XML child
   * elements. Their tags would be lost before the sanitiser sees the text, so the field is
   * dropped and counted instead of being concatenated.
   */
  malformed: boolean;
}

/** Fields read as text (or entity-encoded HTML), where child elements are not allowed. */
const TEXT_FIELDS = new Set(["title", "summary", "content", "content:encoded", "description"]);

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

/**
 * How a field's decoded text is read. `htmlByDefault` is true for the body of any feed that is not
 * Atom: an RSS description, summary or content is HTML whatever its (non-standard) `type` says,
 * because that is how every RSS reader shows it. An Atom text construct is literal.
 */
function modeOf(field: RawField, htmlByDefault: boolean): BodyMode {
  if (field.name === "content:encoded") return "html";
  const type = (field.attrs.type ?? "").trim().toLowerCase();
  if (type === "xhtml" || type === "application/xhtml+xml") return "xhtml";
  if (type === "html" || type === "text/html") return "html";
  if (type === "" || type === "text" || type === "text/plain") {
    return htmlByDefault ? "html" : "text";
  }
  return "ignore";
}

type Candidate =
  | { readonly mode: "text"; readonly source: string; readonly cut: boolean }
  | { readonly mode: "markup"; readonly run: () => HtmlToTextResult; readonly cut: boolean };

function candidatesFor(
  entry: RawEntry,
  names: readonly string[],
  htmlByDefault: boolean,
): Candidate[] {
  const out: Candidate[] = [];
  for (const name of names) {
    for (const field of entry.fields) {
      if (field.name !== name) continue;
      const mode = modeOf(field, htmlByDefault);
      if (mode === "ignore") continue;
      if (field.malformed) continue;
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

/**
 * The name of an author written as an address. RSS defines `author` as an e-mail address,
 * `joe@example.com (Joe)`; the name is the part in parentheses, and a bare address has none. The
 * address itself is never kept, as with the Atom path, which never reads `email`.
 */
function withoutAddress(source: string): string {
  let text = source.normalize("NFKC").trim();
  // "address (Name)": the last parenthesis group, with an at-sign before it and no other
  // parentheses anywhere. Every step is an indexOf or a single pass: no pattern with nested or
  // overlapping quantifiers touches this untrusted text (a feed may fill a field with 262,144
  // at-signs).
  if (text.endsWith(")")) {
    const open = text.lastIndexOf("(");
    const before = open < 0 ? "" : text.slice(0, open);
    const inner = open < 0 ? "" : text.slice(open + 1, -1);
    if (
      open >= 0 &&
      before.includes("@") &&
      !before.includes(")") &&
      !before.includes("(") &&
      !inner.includes(")")
    ) {
      return inner.trim();
    }
  }
  text = removeAngleAddresses(text).trim();
  // A bare address: exactly one at-sign, something on both sides, none of the separator
  // characters.
  const at = text.indexOf("@");
  if (at > 0 && at === text.lastIndexOf("@") && at < text.length - 1 && !hasSeparator(text)) {
    return "";
  }
  return text;
}

/** True when the text holds whitespace, an angle bracket or a parenthesis (single pass). */
function hasSeparator(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (
      code <= 32 ||
      code === 0xa0 ||
      code === 40 ||
      code === 41 ||
      code === 60 ||
      code === 62 ||
      (code >= 0x2000 && code <= 0x200a) ||
      code === 0x2028 ||
      code === 0x2029 ||
      code === 0x3000 ||
      code === 0xfeff
    ) {
      return true;
    }
  }
  return false;
}

/** Removes every `<name@host>` group (no whitespace or angle bracket inside) in one pass. */
function removeAngleAddresses(text: string): string {
  let out = "";
  let position = 0;
  // The position of the first ">" at or after the scan point is remembered and reused until the
  // scan passes it, so a run of "<" before one ">" costs one search, not one per "<".
  let close = -1;
  while (position < text.length) {
    const open = text.indexOf("<", position);
    if (open < 0) break;
    if (close <= open) {
      close = text.indexOf(">", open + 1);
      if (close < 0) break;
    }
    const next = text.indexOf("<", open + 1);
    if (next >= 0 && next < close) {
      // A later "<" starts the real group: keep everything before it as text.
      out += text.slice(position, next);
      position = next;
      continue;
    }
    const inner = text.slice(open + 1, close);
    if (inner.includes("@") && !hasSeparator(inner)) {
      out += `${text.slice(position, open)} `;
    } else {
      out += text.slice(position, close + 1);
    }
    position = close + 1;
  }
  return out + text.slice(position);
}

function authorCandidates(entry: RawEntry): Candidate[] {
  const out: Candidate[] = [];
  const add = (raw: string): void => {
    const source = withoutAddress(raw);
    if (source.trim() !== "") out.push({ mode: "text", source, cut: false });
  };
  for (const field of entry.fields) {
    if (field.name !== "author") continue;
    // The name child of an Atom author, else the direct text of an RSS author. Email and uri
    // children were never collected.
    add(field.nameText.trim() !== "" ? field.nameText : field.text);
  }
  for (const field of entry.fields) {
    if (field.name === "dc:creator") add(field.text);
  }
  return out;
}

function toEntry(
  raw: RawEntry,
  format: ParsedFeed["format"],
  report: MutableSanitiseReport,
): FeedEntry {
  // A text field with literal child elements is dropped whole and counted once, whether or not
  // another field ends up supplying the text.
  for (const field of raw.fields) {
    if (field.malformed && modeOf(field, true) !== "ignore") report.hiddenBlocks += 1;
  }
  const title = sanitiseFirst(
    candidatesFor(raw, ["title"], false),
    "identity",
    IDENTITY_CAP,
    report,
  );
  const author = sanitiseFirst(authorCandidates(raw), "identity", IDENTITY_CAP, report);
  const text = sanitiseFirst(
    candidatesFor(raw, ["content:encoded", "content", "summary", "description"], format !== "atom"),
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
  // The names as the feed wrote them, for the xhtml sink, which matches by local name itself.
  const rawPath: string[] = [];
  const scopes: Bindings[] = [];
  let bindings: Bindings = NO_BINDINGS;
  const losses: RegistryLosses = {
    namespaces: false,
    fields: false,
    attributes: false,
    declarations: 0,
  };
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
        scopes.push(bindings);
        bindings = bindingsFor(bindings, attribs, losses);
        const name = canonicalName(rawName, bindings, losses.namespaces);
        path.push(name);
        rawPath.push(rawName);
        if (path.length === 1) {
          if (name === "feed") format = "atom";
          else if (name === "rss" || name === "rdf:rdf") format = "rss";
        }
        if (current === null) {
          if (name === "entry" || name === "item") {
            current = { fields: [] };
            entryDepth = path.length;
          }
          return;
        }
        const relative = path.length - entryDepth;
        if (relative === 1 && current.fields.length >= MAX_FIELDS_PER_ENTRY) {
          // Past the per-entry field cap: this child and everything under it is not read.
          losses.fields = true;
          field = null;
          return;
        }
        const readAttribs = relative === 1 ? readAttributes(attribs, losses) : {};
        if (relative === 1 && readAttribs === null) {
          // A type discriminator over the cap: the field is rejected, not defaulted to text.
          field = null;
          return;
        }
        if (relative === 1) {
          const type = (attribs.type ?? "").trim().toLowerCase();
          const xhtml = type === "xhtml" || type === "application/xhtml+xml";
          field = {
            name,
            attrs: readAttribs ?? {},
            text: "",
            cut: false,
            nameText: "",
            sink: xhtml ? createMarkupSink({ xml: true }) : undefined,
            malformed: false,
          };
          current.fields.push(field);
        } else if (field !== null && field.sink !== undefined) {
          field.sink.open(rawName, attribs);
        } else if (field !== null && TEXT_FIELDS.has(field.name)) {
          // A child element inside a text field: its tags would vanish before the sanitiser.
          field.malformed = true;
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
              rawPath[rawPath.length - 1] ?? "",
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
        rawPath.pop();
        bindings = scopes.pop() ?? NO_BINDINGS;
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
  const kept = newest(entries).map((raw) => toEntry(raw, format, report));
  // A cut input or a stopped parse is a dropped remainder, counted like the page sanitiser's.
  if (droppedRemainder) report.hiddenBlocks += 1;
  // What the registries refused to hold is counted once per kind.
  for (const lost of [losses.namespaces, losses.fields, losses.attributes]) {
    if (lost) report.hiddenBlocks += 1;
  }
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
