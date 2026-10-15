// Security finding 3 (plan 07-04): parser differentials. canonicaliseUrl feeds the allowlist
// check and the fetcher (07-09) with ONE string, so it must agree with the WHATWG parser that
// Node and the fetcher use and must refuse anything two parsers could read differently, instead
// of repairing it. Hostile inputs are written with escapes only; no test reaches a network.
import { describe, expect, it } from "vitest";
import { canonicaliseUrl, URL_REJECT_REASONS } from "./canonical-url.js";

function reasonOf(input: string): string {
  const result = canonicaliseUrl(input);
  if (result.ok) throw new Error(`expected a rejection, got ${result.url}`);
  return result.reason;
}

const REJECTED: ReadonlyArray<readonly [string, string, readonly string[]]> = [
  [
    "backslashes",
    "backslash",
    [
      "https://example.com\\@evil.invalid/",
      "https://example.com\\evil.invalid/",
      "https:\\\\example.com/",
      "https://example.com/a\\b",
      "https://example.com/?q=a\\b",
      "https://evil.invalid\\.example.com/",
    ],
  ],
  [
    "userinfo",
    "userinfo",
    [
      "https://a@b.invalid/",
      "https://user:pw@example.com/",
      "https://@example.com/",
      "https://example.com:443@evil.invalid/",
      "https://example.com@evil.invalid:443/",
      "https://a@b@c.invalid/",
    ],
  ],
  [
    "percent-encoded hosts",
    "ambiguous-host",
    [
      "https://exa%6dple.com/",
      "https://%65xample.com/",
      "https://example.com%2f.evil.invalid/",
      "https://example.com%40evil.invalid/",
      "https://example.com%00.evil.invalid/",
      "https://example%2ecom/",
    ],
  ],
  [
    "internationalised and look-alike hosts",
    "ambiguous-host",
    [
      "https://b\u00FCcher.example/",
      "https://\uFF45xample.com/",
      "https://example\u3002com/",
      "https://\u0435xample.com/",
      "https://example.com\uFF0Eevil.invalid/",
    ],
  ],
  [
    "IPv4 in decimal, octal, hex, short and mixed forms",
    "ambiguous-host",
    [
      "https://2130706433/",
      "https://0x7f.1/",
      "https://017700000001/",
      "https://127.1/",
      "https://0177.0.0.1/",
      "https://0x7f000001/",
      "https://1.1.1/",
      "https://127.000.000.001/",
      "https://0x7f.0x0.0x0.0x1/",
      "https://127.0.0.1/",
      "https://93.184.216.34/",
      "https://127.0.0.1./",
    ],
  ],
  [
    "IPv6 including zone and mapped forms",
    "ambiguous-host",
    [
      "https://[::1]/",
      "https://[::ffff:127.0.0.1]/",
      "https://[::ffff:7f00:1]/",
      "https://[fe80::1%25eth0]/",
      "https://[0:0:0:0:0:ffff:7f00:1]/",
      "https://[2001:db8::1]/",
    ],
  ],
  [
    "trailing-dot hosts",
    "ambiguous-host",
    ["https://example.com./", "https://example.com../", "https://example.com.:443/x"],
  ],
  [
    "other host shapes",
    "ambiguous-host",
    [
      "https://-example.com/",
      "https://example-.com/",
      "https://exa_mple.com/",
      "https://example..com/",
      "https://.example.com/",
      "https://exa!mple.com/",
      "https://exa*mple.com/",
    ],
  ],
  [
    "a scheme written in the wrong case or without two slashes",
    "not-https",
    ["HTTPS://example.com/", "Https://example.com/", "hTTps://example.com/", "http://example.com/"],
  ],
  [
    "a scheme without the two slashes",
    "invalid-url",
    ["https:example.com", "https:/example.com/", "https:", "https"],
  ],
  [
    "extra slashes where the authority should start",
    "empty-host",
    ["https:///example.com/", "https:////example.com/", "https://?x=1", "https://#frag"],
  ],
  [
    "a port that is not exactly 443",
    "bad-port",
    [
      "https://example.com:0443/",
      "https://example.com:/",
      "https://example.com:8443/",
      "https://example.com:44/",
      "https://example.com:443443/",
      "https://example.com:443:443/",
      "https://example.com:+443/",
      "https://example.com:0x1bb/",
    ],
  ],
  [
    "whitespace and control characters anywhere",
    "invalid-url",
    [
      "https://exa\tmple.com/",
      "https://exa\nmple.com/",
      "https://exa\rmple.com/",
      "https://exa mple.com/",
      "https://example.com/a b",
      "https://example.com/?q=a\tb",
      "https://example.com/#a\nb",
      "https://example.com/\u0000",
      "https://example.com/\u0085",
      "https://example.com/\u00A0",
      "https://example.com/\u2028",
      "https://example.com/\u202E",
      "https://example.com/\u200B",
      "https://example.com/\uFEFF",
      " https://example.com/",
      "https://example.com/ ",
      "\u0001https://example.com/",
    ],
  ],
];

describe("finding 3: ambiguous input is rejected, never repaired", () => {
  for (const [name, reason, inputs] of REJECTED) {
    describe(name, () => {
      for (const input of inputs) {
        it(`rejects ${JSON.stringify(input)} as ${reason}`, () => {
          expect(reasonOf(input)).toBe(reason);
        });
      }
    });
  }

  it("only ever returns a reason from the closed list", () => {
    for (const [, , inputs] of REJECTED) {
      for (const input of inputs) expect(URL_REJECT_REASONS).toContain(reasonOf(input));
    }
  });

  it("never throws on any input of these tables or on odd types of text", () => {
    for (const input of [
      "",
      "\u0000",
      "https://",
      "https://[",
      "https://]",
      "%",
      "\uD800",
      "a".repeat(5_000),
    ]) {
      expect(() => canonicaliseUrl(input)).not.toThrow();
    }
  });
});

const ACCEPTED: ReadonlyArray<readonly [string, string, string]> = [
  ["a plain address", "https://example.com/", "https://example.com/"],
  ["a host in capitals", "https://EXAMPLE.Com/Path", "https://example.com/Path"],
  ["the explicit default port", "https://example.com:443/x", "https://example.com/x"],
  [
    "a query, sorted, with tracking dropped",
    "https://example.com/a?utm_source=x&b=2&a=1#f",
    "https://example.com/a?a=1&b=2",
  ],
  ["a dot segment, resolved by the parser", "https://example.com/a/../b", "https://example.com/b"],
  ["a double slash inside the path", "https://example.com//x", "https://example.com//x"],
  [
    "an at sign in the query",
    "https://example.com?@evil.invalid/",
    "https://example.com/?%40evil.invalid%2F=",
  ],
  ["an at sign in the fragment", "https://example.com#@evil.invalid/", "https://example.com/"],
  ["a punycode label", "https://xn--bcher-kva.example/", "https://xn--bcher-kva.example/"],
  [
    "a percent-encoded path",
    "https://example.com/%7Euser/a%20b",
    "https://example.com/%7Euser/a%20b",
  ],
  ["a numeric label that is not the last", "https://1.example.com/", "https://1.example.com/"],
];

describe("finding 3: what is accepted equals what the WHATWG parser reports", () => {
  for (const [name, input, expected] of ACCEPTED) {
    it(`accepts ${name}`, () => {
      const result = canonicaliseUrl(input);
      if (!result.ok) throw new Error(`rejected ${input}: ${result.reason}`);
      expect(result.url).toBe(expected);
      const reparsed = new URL(result.url);
      expect(reparsed.href).toBe(result.url);
      expect(reparsed.hostname).toBe(result.host);
      expect(reparsed.protocol).toBe("https:");
      expect(reparsed.username).toBe("");
      expect(reparsed.password).toBe("");
      expect(reparsed.port).toBe("");
      expect(canonicaliseUrl(result.url)).toEqual(result);
    });
  }

  it("keeps the host of a query or fragment that imitates userinfo", () => {
    for (const input of [
      "https://example.com?@evil.invalid/",
      "https://example.com#@evil.invalid/",
    ]) {
      const result = canonicaliseUrl(input);
      expect(result.ok && result.host).toBe("example.com");
      expect(new URL(input).hostname).toBe("example.com");
    }
  });

  it("agrees with the URL parser about the host for every accepted input", () => {
    for (const [, input] of ACCEPTED) {
      const result = canonicaliseUrl(input);
      if (!result.ok) throw new Error(`rejected ${input}`);
      expect(new URL(input).hostname).toBe(result.host);
    }
  });
});

describe("finding 3: a fixed-seed fuzz never yields an output two parsers could read differently", () => {
  const FRAGMENTS = [
    "https://",
    "HTTPS://",
    "http://",
    "example.com",
    "EXAMPLE.com",
    "evil.invalid",
    ".",
    "..",
    "@",
    ":",
    ":443",
    ":80",
    "\\",
    "/",
    "//",
    "?",
    "&",
    "=",
    "#",
    "%",
    "%40",
    "%2e",
    "\u00FC",
    "\uFF45",
    "\u3002",
    "[",
    "]",
    "::1",
    "127.0.0.1",
    "2130706433",
    "0x7f",
    "017",
    " ",
    "\t",
    "\u200B",
    "utm_source=1",
    "a=1",
    "xn--",
    "-",
    "_",
    "path",
    "..",
  ];

  function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("holds the output invariants over 3,000 random inputs", () => {
    const random = mulberry32(20261015);
    let accepted = 0;
    for (let round = 0; round < 3_000; round += 1) {
      let input = random() < 0.7 ? "https://" : "";
      const length = 1 + Math.floor(random() * 9);
      for (let i = 0; i < length; i += 1) {
        input += FRAGMENTS[Math.floor(random() * FRAGMENTS.length)] ?? "";
      }
      const result = canonicaliseUrl(input);
      if (!result.ok) continue;
      accepted += 1;
      const parsed = new URL(result.url);
      expect(parsed.href, input).toBe(result.url);
      expect(parsed.hostname, input).toBe(result.host);
      expect(result.url, input).toMatch(/^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?\//);
      expect(result.url, input).not.toMatch(/[\\\s\p{Cc}\p{Cf}]/u);
      expect(canonicaliseUrl(result.url), input).toEqual(result);
    }
    expect(accepted).toBeGreaterThan(20);
  });
});
