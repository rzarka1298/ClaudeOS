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

/** Names that always mean this machine, refused before any lookup (defence in depth). */
function isLocalName(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
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
  if (net.isIP(literal) !== 0 && isBlockedAddress(literal)) return refusal("refused-address");

  url.hash = "";
  return { ok: true, url };
}
