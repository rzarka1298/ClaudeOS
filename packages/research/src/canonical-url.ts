// URL canonicalisation (D-11, research Pattern 4; security finding 3). The canonical string is
// the input to the 32-hex source id AND the single value the allowlist check and the fetcher
// (plan 07-09) both consume, so it must mean the same thing to every parser.
//
// The WHATWG parser (`new URL`, the one Node and the fetcher use) repairs a lot of input: it turns
// backslashes into slashes, decodes percent-encoded and IDN hosts, rewrites decimal, octal, hex
// and short IPv4 forms, strips a trailing dot and ignores the case of the scheme. Anything that is
// repaired is something a second parser, a proxy or a regex could read differently. So this
// function REJECTS ambiguity instead of repairing it, and uses `new URL` only to confirm that its
// own textual reading agrees:
//
//   - the input is plain text: no whitespace, control, format or separator character and no
//     backslash anywhere, at most 2,048 characters;
//   - it starts with exactly `https://` (any other scheme or scheme case is rejected), and the
//     authority is read textually up to the first `/`, `?` or `#`: no userinfo, no empty host, no
//     bracket (IPv6 in every form), a port that is exactly 443 or absent;
//   - the host is ASCII letters, digits, hyphens and single interior dots: percent-encoding,
//     non-ASCII (IDN look-alikes), trailing dots and the other odd shapes are rejected, and so is
//     every IPv4 literal, written in any form (a research source is a named host, and the
//     fetcher still refuses private resolved addresses separately);
//   - after parsing, the hostname must equal the lowercased textual host, no userinfo or port may
//     remain, and re-canonicalising the output must reproduce it exactly.
//
// Output: `https://<host><path>[?<sorted query>]`, with the fragment and tracking parameters
// (`utm_*`, `fbclid`, `gclid`, `ref`) dropped. The function never throws.

export const URL_REJECT_REASONS = [
  "invalid-url",
  "not-https",
  "userinfo",
  "bad-port",
  "empty-host",
  "too-long",
  "backslash",
  "ambiguous-host",
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

const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;

// Labels of ASCII letters, digits and interior hyphens, separated by single dots.
const HOST =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

// A last label that is a number (decimal, octal or 0x hex): the URL parser reads such a host as
// an IPv4 address in whatever form it takes.
const NUMERIC_LAST_LABEL = /(?:^|\.)(?:0x[0-9a-f]*|[0-9]+)$/i;

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

function canonicaliseOnce(input: string): CanonicalUrlResult {
  if (typeof input !== "string") return reject("invalid-url");
  if (input.length > MAX_URL_LENGTH) return reject("too-long");
  if (input === "" || DISALLOWED_CHARS.test(input)) return reject("invalid-url");
  if (input.includes("\\")) return reject("backslash");

  const scheme = SCHEME.exec(input);
  if (scheme === null) return reject("invalid-url");
  if (scheme[1] !== "https") return reject("not-https");
  if (!input.startsWith("https://")) return reject("invalid-url");

  const rest = input.slice("https://".length);
  const authorityEnd = rest.search(/[/?#]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);

  if (authority.includes("@")) return reject("userinfo");
  if (authority === "") return reject("empty-host");
  if (authority.includes("[") || authority.includes("]")) return reject("ambiguous-host");

  const colon = authority.indexOf(":");
  const hostText = colon === -1 ? authority : authority.slice(0, colon);
  if (hostText === "" || /^\.+$/.test(hostText)) return reject("empty-host");
  if (colon !== -1 && authority.slice(colon + 1) !== "443") return reject("bad-port");
  if (!HOST.test(hostText) || NUMERIC_LAST_LABEL.test(hostText)) return reject("ambiguous-host");

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
  const host = hostText.toLowerCase();
  if (parsed.hostname !== host) return reject("ambiguous-host");

  const params = [...parsed.searchParams].filter(([name]) => !isTrackingParam(name));
  params.sort(([an, av], [bn, bv]) => compare(an, bn) || compare(av, bv));
  const query = params.length === 0 ? "" : `?${new URLSearchParams(params).toString()}`;

  return { ok: true, url: `https://${host}${parsed.pathname}${query}`, host };
}

export function canonicaliseUrl(input: string): CanonicalUrlResult {
  const first = canonicaliseOnce(input);
  if (!first.ok) return first;
  // The output must be a fixed point, or two stages could disagree about what it names.
  const second = canonicaliseOnce(first.url);
  if (!second.ok || second.url !== first.url || second.host !== first.host) {
    return reject("invalid-url");
  }
  return first;
}
