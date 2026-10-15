// URL canonicalisation (D-11, research Pattern 4). The canonical string is the input to the
// 32-hex source id, so one address has one spelling.
//
// Accepted: https only, no userinfo, the default port only. The WHATWG parser lowercases the host,
// converts it to punycode and rewrites obfuscated IPv4 forms (https://2130706433/ and 0x7f.1 both
// become 127.0.0.1); this module then strips a trailing dot, drops the fragment and tracking
// parameters and sorts what is left. Whether an address is private or loopback is not decided
// here: the service fetcher refuses addresses (D-11), and this function must never throw.

export const URL_REJECT_REASONS = [
  "invalid-url",
  "not-https",
  "userinfo",
  "bad-port",
  "empty-host",
  "too-long",
] as const;

export type UrlRejectReason = (typeof URL_REJECT_REASONS)[number];

export type CanonicalUrlResult =
  | { readonly ok: true; readonly url: string; readonly host: string }
  | { readonly ok: false; readonly reason: UrlRejectReason };

const MAX_URL_LENGTH = 2_048;

// Whitespace, control, format and separator characters anywhere in the input. The URL parser
// would silently strip some of them (a tab or newline inside a host), which would let two
// different inputs share one canonical form.
const DISALLOWED_CHARS = /[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}\p{Cs}]/u;

const TRACKING_PARAMS: ReadonlySet<string> = new Set(["fbclid", "gclid", "ref"]);

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("utm_") || TRACKING_PARAMS.has(lower);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function reject(reason: UrlRejectReason): CanonicalUrlResult {
  return { ok: false, reason };
}

export function canonicaliseUrl(input: string): CanonicalUrlResult {
  if (typeof input !== "string") return reject("invalid-url");
  if (input.length > MAX_URL_LENGTH) return reject("too-long");
  if (input === "" || DISALLOWED_CHARS.test(input)) return reject("invalid-url");

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return reject("invalid-url");
  }

  if (parsed.protocol !== "https:") return reject("not-https");
  if (parsed.username !== "" || parsed.password !== "") return reject("userinfo");
  // The parser drops an explicit default port, so any remaining port is not 443.
  if (parsed.port !== "") return reject("bad-port");

  const host = parsed.hostname.replace(/\.+$/, "");
  if (host === "") return reject("empty-host");

  const params = [...parsed.searchParams].filter(([name]) => !isTrackingParam(name));
  params.sort(([an, av], [bn, bv]) => compare(an, bn) || compare(av, bv));
  const query = params.length === 0 ? "" : `?${new URLSearchParams(params).toString()}`;

  return { ok: true, url: `https://${host}${parsed.pathname}${query}`, host };
}
