import net from "node:net";
import type { SourceFailureCode } from "@ccc/domain";
import { isBlockedAddress } from "./address-policy.js";
import { MAX_URL_LENGTH } from "./limits.js";

/**
 * Which addresses the research fetcher may request (D-09, research Pitfall 2). Run on the source
 * address and again on every redirect hop.
 *
 * It does NOT trust any earlier canonicalisation: `canonicaliseUrl` accepts `localhost`,
 * `*.nip.io` style names and punycode by design, and `HttpsUrlSchema` accepts ports and IP
 * literals. SSRF protection rests on this module plus the connect-time lookup: a literal is
 * checked here, a name is checked by the address it resolves to.
 *
 * The WHATWG parser has already normalised decimal, hex, octal and short IPv4 forms and the
 * mapped IPv6 forms to a canonical literal by the time `hostname` is read, so `https://2130706433/`
 * and `https://0x7f.1/` both arrive here as `127.0.0.1`.
 *
 * Codes: a source that cannot be parsed is `parse-failure`; a source that breaks the policy is
 * `refused-address`; on a redirect hop every violation is `unsafe-redirect`.
 */

export type FetchUrlContext = "source" | "redirect";

export type FetchUrlVerdict =
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly code: SourceFailureCode };

/** Name suffixes that never name a public host: this machine, mDNS, and the private-use zones. */
const LOCAL_SUFFIXES: readonly string[] = [".localhost", ".local", ".internal", ".home.arpa"];
const LOCAL_NAMES: readonly string[] = ["localhost", "local", "internal", "home.arpa"];

/** Names that always mean this machine or a private network, refused before any lookup. */
function isLocalName(hostname: string): boolean {
  return (
    LOCAL_NAMES.includes(hostname) || LOCAL_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  );
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find control characters
const FORBIDDEN_RAW = /[\u0000- \u007f\\]/u;

export function validateFetchUrl(
  raw: string,
  context: FetchUrlContext = "source",
): FetchUrlVerdict {
  const refusal = (policy: SourceFailureCode): FetchUrlVerdict => ({
    ok: false,
    code: context === "redirect" ? "unsafe-redirect" : policy,
  });

  if (raw.length === 0 || raw.length > MAX_URL_LENGTH || FORBIDDEN_RAW.test(raw)) {
    return refusal("parse-failure");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refusal("parse-failure");
  }
  if (url.protocol !== "https:") return refusal("refused-address");
  if (url.username !== "" || url.password !== "") return refusal("refused-address");
  // The parser drops the default port, so anything left is a different port.
  if (url.port !== "") return refusal("refused-address");

  const hostname = url.hostname.toLowerCase();
  if (hostname === "" || hostname.endsWith(".")) return refusal("refused-address");
  if (isLocalName(hostname)) return refusal("refused-address");

  const literal =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const isLiteral = net.isIP(literal) !== 0;
  // A single-label name resolves through the machine's search domains, i.e. to its own network.
  if (!isLiteral && !hostname.includes(".")) return refusal("refused-address");
  if (isLiteral && isBlockedAddress(literal)) return refusal("refused-address");

  url.hash = "";
  return { ok: true, url };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find control characters
const FORBIDDEN_LOCATION = /[\u0000-\u0020\u007f\\]/u;

/**
 * Resolve a `Location` header against the address that returned it and run the full policy on the
 * result. The raw header is checked first: the WHATWG parser silently drops tabs and line breaks,
 * which would let `https://ok.example/\r\nSet-Cookie: x` through as a clean address.
 */
export function resolveRedirectTarget(location: string, base: URL): FetchUrlVerdict {
  const unsafe: FetchUrlVerdict = { ok: false, code: "unsafe-redirect" };
  if (location.length === 0 || location.length > MAX_URL_LENGTH) return unsafe;
  if (FORBIDDEN_LOCATION.test(location)) return unsafe;
  let resolved: URL;
  try {
    resolved = new URL(location, base);
  } catch {
    return unsafe;
  }
  return validateFetchUrl(resolved.href, "redirect");
}
