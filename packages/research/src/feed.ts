// RSS and Atom parsing in XML mode (D-09, research R2 and Pitfall 6).
//
// htmlparser2 in `xmlMode` never reads a DTD: a DOCTYPE arrives as a processing instruction
// that this module ignores, a custom entity such as `&xxe;` is left as literal text, and only
// the five predefined and the numeric references decode. A `file:` entity therefore reads
// nothing and a nested-entity bomb expands to nothing. This module has no I/O at all.

import { Parser } from "htmlparser2";
import { emptyReport, type SanitiseReport } from "./html-to-text.js";

export interface FeedEntry {
  readonly title: string;
  /** The address exactly as the feed gave it. It is never put in text; canonicalise it separately. */
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
const MAX_DEPTH = 512;

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
}

interface RawEntry {
  readonly fields: RawField[];
}

function plain(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function firstText(entry: RawEntry, names: readonly string[]): string {
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

function toEntry(raw: RawEntry): FeedEntry {
  const authorField = raw.fields.find((f) => f.name === "author");
  const author =
    (authorField !== undefined ? plain(authorField.nameText) || plain(authorField.text) : "") ||
    firstText(raw, ["dc:creator"]);
  const instant = parseFeedInstant(firstText(raw, ["updated", "published", "pubdate", "dc:date"]));
  return {
    title: firstText(raw, ["title"]),
    link: pickLink(raw),
    updated: instant,
    author: author === "" ? null : author,
    text: firstText(raw, ["content:encoded", "content", "summary", "description"]),
  };
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
        if (overflow > 0 || path.length >= MAX_DEPTH) {
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
          field = { name, attrs: { ...attribs }, text: "", nameText: "" };
          current.fields.push(field);
        }
      },
      ontext(data) {
        if (overflow > 0 || current === null || field === null) return;
        const relative = path.length - entryDepth;
        if (field.name === "author" && relative === 2 && path[path.length - 1] === "name") {
          field.nameText += data;
        } else {
          field.text += data;
        }
      },
      onclosetag() {
        if (overflow > 0) {
          overflow -= 1;
          return;
        }
        if (current !== null) {
          const relative = path.length - entryDepth;
          if (relative === 1) field = null;
          if (relative === 0) {
            entries.push(current);
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

  return { format, entries: entries.map(toEntry), report: emptyReport() };
}

/**
 * One text block for a feed: each entry is its title, then its text, entries separated by a
 * blank line. The first line of a block is therefore always an entry title.
 */
export function renderFeedText(entries: readonly FeedEntry[]): string {
  return entries
    .map((entry) => (entry.text === "" ? entry.title : `${entry.title}\n${entry.text}`))
    .join("\n\n");
}
