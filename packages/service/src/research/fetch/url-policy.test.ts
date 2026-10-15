import { describe, expect, it } from "vitest";
import { MAX_URL_LENGTH } from "./limits.js";
import { validateFetchUrl } from "./url-policy.js";

const REFUSED_SOURCES: readonly (readonly [string, string])[] = [
  ["plain http", "http://example.com/feed.xml"],
  ["ftp", "ftp://example.com/feed.xml"],
  ["javascript", "javascript:alert(1)"],
  ["data", "data:text/html,hello"],
  ["userinfo", "https://user:pass@example.com/"],
  ["userinfo no password", "https://user@example.com/"],
  ["port 8443", "https://example.com:8443/"],
  ["port 80", "https://example.com:80/"],
  ["trailing dot", "https://example.com./"],
  ["loopback literal", "https://127.0.0.1/"],
  ["ipv6 loopback", "https://[::1]/"],
  ["decimal ipv4", "https://2130706433/"],
  ["hex ipv4", "https://0x7f.1/"],
  ["octal ipv4", "https://017700000001/"],
  ["short ipv4", "https://127.1/"],
  ["zero ipv4", "https://0/"],
  ["mapped ipv6", "https://[::ffff:7f00:1]/"],
  ["mapped ipv6 dotted", "https://[::ffff:127.0.0.1]/"],
  ["metadata literal", "https://169.254.169.254/latest/meta-data/"],
  ["metadata mapped", "https://[::ffff:a9fe:a9fe]/"],
  ["private 10", "https://10.0.0.1/"],
  ["private 192.168", "https://192.168.0.1/"],
  ["link-local ipv6", "https://[fe80::1]/"],
  ["unique-local ipv6", "https://[fd00::1]/"],
  ["localhost", "https://localhost/"],
  ["localhost upper", "https://LOCALHOST/"],
  ["localhost subdomain", "https://app.localhost/"],
  ["localhost trailing dot", "https://localhost./"],
];

const UNPARSEABLE: readonly (readonly [string, string])[] = [
  ["empty", ""],
  ["no host", "https://"],
  ["no scheme", "example.com/feed.xml"],
  ["space in path", "https://example.com/a b"],
  ["tab in host", "https://exa\tmple.com/"],
  ["newline in path", "https://example.com/a\nb"],
  ["nul in path", "https://example.com/a\u0000b"],
  ["backslash", "https://example.com\\@evil.invalid/"],
  ["too long", `https://example.com/${"a".repeat(MAX_URL_LENGTH)}`],
];

describe("Test 4 (URL policy): validateFetchUrl", () => {
  for (const [name, url] of REFUSED_SOURCES) {
    it(`refuses ${name} as a source with refused-address`, () => {
      expect(validateFetchUrl(url, "source")).toEqual({ ok: false, code: "refused-address" });
    });
    it(`refuses ${name} as a redirect with unsafe-redirect`, () => {
      expect(validateFetchUrl(url, "redirect")).toEqual({ ok: false, code: "unsafe-redirect" });
    });
  }

  for (const [name, url] of UNPARSEABLE) {
    it(`refuses ${name} as unparseable`, () => {
      expect(validateFetchUrl(url, "source")).toEqual({ ok: false, code: "parse-failure" });
      expect(validateFetchUrl(url, "redirect")).toEqual({ ok: false, code: "unsafe-redirect" });
    });
  }

  it("accepts a plain https address", () => {
    const verdict = validateFetchUrl("https://example.com/feed.xml");
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.url.href).toBe("https://example.com/feed.xml");
  });

  it("normalises: default port dropped, host lower-cased, fragment removed, IDN as punycode", () => {
    const port = validateFetchUrl("https://Example.COM:443/a?b=1#frag");
    expect(port.ok && port.url.href).toBe("https://example.com/a?b=1");
    const idn = validateFetchUrl("https://b\u00fccher.example/");
    expect(idn.ok && idn.url.hostname).toBe("xn--bcher-kva.example");
  });

  it("accepts a public IP literal (checked, then left to the certificate check)", () => {
    expect(validateFetchUrl("https://93.184.216.34/").ok).toBe(true);
    expect(validateFetchUrl("https://[2606:4700::1111]/").ok).toBe(true);
  });

  it("does not refuse a name by how it looks: that is the lookup's job", () => {
    // A name resolving to a private address is refused at connect time, not here.
    expect(validateFetchUrl("https://127.0.0.1.nip.io/").ok).toBe(true);
    expect(validateFetchUrl("https://metadata.internal.example/").ok).toBe(true);
  });
});
