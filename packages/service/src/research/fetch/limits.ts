/**
 * The fixed bounds of the research fetcher (D-09, research R3 and Pitfall 5). Sized from real
 * feeds: the seven candidate feeds were 36 to 355 KB, so a 1 MiB feed cap and a 512 KiB page cap
 * leave room without letting a source hold memory or time.
 */

/** The whole fetch, redirects included. */
export const TOTAL_TIMEOUT_MS = 15_000;
/** No byte, header or connection progress for this long. */
export const IDLE_TIMEOUT_MS = 8_000;
export const FEED_BYTE_CAP = 1024 * 1024;
export const PAGE_BYTE_CAP = 512 * 1024;
/** All sources of one run together. */
export const RUN_BYTE_CAP = 6 * 1024 * 1024;
export const MAX_REDIRECTS = 3;
/** Sources fetched at once; enforced by the pipeline, kept here with the other bounds. */
export const FETCH_CONCURRENCY = 3;
/** Longest address the fetcher will parse, for a source or a Location header. */
export const MAX_URL_LENGTH = 2048;
/** The most response-header bytes Node will parse (its own default, set explicitly). */
export const MAX_HEADER_BYTES = 16 * 1024;
/** The first bytes inspected for a meta charset (the HTML prescan window). */
export const META_PRESCAN_BYTES = 1024;

/** Fixed. No version of the owner's machine, no path, no contact detail. */
export const USER_AGENT = "claude-command-center-research/0.1.0 (+local)";

export type SourceKind = "feed" | "page";

export const BYTE_CAP_BY_KIND: Readonly<Record<SourceKind, number>> = {
  feed: FEED_BYTE_CAP,
  page: PAGE_BYTE_CAP,
};

export const ACCEPT_BY_KIND: Readonly<Record<SourceKind, string>> = {
  feed: "application/atom+xml, application/rss+xml, application/xml;q=0.9, text/xml;q=0.9",
  page: "text/html, application/xhtml+xml;q=0.9, text/plain;q=0.5",
};

/** The media types a source may be served as (research Pitfall 5). */
export const CONTENT_TYPE_ALLOWLIST: ReadonlySet<string> = new Set([
  "application/atom+xml",
  "application/rss+xml",
  "application/xml",
  "text/xml",
  "text/html",
  "application/xhtml+xml",
  "text/plain",
]);

/** Accepted for a feed source only, and only when the first bytes are XML. */
export const OCTET_STREAM = "application/octet-stream";

export const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
