/**
 * Hostile fetch targets (plan 07-09, T-07-22 to T-07-24, RSRCH-08). Everything an attacker who
 * controls a source address, a DNS answer, a redirect or a response could use to steer the research
 * fetcher at the owner's machine or network, or to smuggle markup past the sanitiser through a
 * wrong character set. A sweep test (fetch-hostile-sweep.test.ts) runs each list through the real
 * fetcher modules with an injected fake transport and resolver: no entry touches the network.
 *
 * This file is pure ASCII. Every name is a reserved `.invalid` or `.example` name, or a literal
 * address; no real host appears.
 */

/** The code a refused SOURCE address must produce (a redirect always produces unsafe-redirect). */
export type HostileFetchUrlCode = "refused-address" | "parse-failure";

export interface HostileFetchUrl {
  readonly name: string;
  readonly url: string;
  readonly code: HostileFetchUrlCode;
}

const refused = (name: string, url: string): HostileFetchUrl => ({
  name,
  url,
  code: "refused-address",
});
const unparseable = (name: string, url: string): HostileFetchUrl => ({
  name,
  url,
  code: "parse-failure",
});

/** Source addresses the fetcher must refuse before opening any connection. */
export const HOSTILE_FETCH_URLS: readonly HostileFetchUrl[] = [
  refused("plain-http", "http://example.com/feed.xml"),
  refused("ftp", "ftp://example.com/feed.xml"),
  refused("javascript", "javascript:alert(1)"),
  refused("data", "data:text/html,hello"),
  refused("file", "file:///etc/passwd"),
  refused("userinfo", "https://user:pass@example.com/"),
  refused("userinfo-confusion", "https://example.com@127.0.0.1/"),
  refused("port-8443", "https://example.com:8443/"),
  refused("port-80", "https://example.com:80/"),
  refused("port-22", "https://example.com:22/"),
  refused("trailing-dot", "https://example.com./"),
  refused("loopback", "https://127.0.0.1/"),
  refused("loopback-high", "https://127.255.255.254/"),
  refused("ipv6-loopback", "https://[::1]/"),
  refused("ipv6-unspecified", "https://[::]/"),
  refused("decimal-ipv4", "https://2130706433/"),
  refused("hex-ipv4", "https://0x7f000001/"),
  refused("hex-dotted-ipv4", "https://0x7f.1/"),
  refused("octal-ipv4", "https://017700000001/"),
  refused("octal-dotted-ipv4", "https://0177.0.0.1/"),
  refused("short-ipv4", "https://127.1/"),
  refused("short-ipv4-three", "https://127.0.1/"),
  refused("zero-ipv4", "https://0/"),
  refused("mixed-radix-ipv4", "https://0x7f.0.0.01/"),
  refused("mapped-ipv6", "https://[::ffff:7f00:1]/"),
  refused("mapped-ipv6-dotted", "https://[::ffff:127.0.0.1]/"),
  refused("mapped-ipv6-private", "https://[::ffff:10.0.0.1]/"),
  refused("mapped-ipv6-metadata", "https://[::ffff:a9fe:a9fe]/"),
  refused("compatible-ipv6", "https://[::127.0.0.1]/"),
  refused("nat64", "https://[64:ff9b::7f00:1]/"),
  refused("nat64-local", "https://[64:ff9b:1::7f00:1]/"),
  refused("six-to-four", "https://[2002:7f00:1::1]/"),
  refused("teredo", "https://[2001::1]/"),
  refused("metadata-ipv4", "https://169.254.169.254/latest/meta-data/"),
  refused("link-local-ipv4", "https://169.254.0.1/"),
  refused("link-local-ipv6", "https://[fe80::1]/"),
  refused("unique-local-ipv6", "https://[fd00::1]/"),
  refused("site-local-ipv6", "https://[fec0::1]/"),
  refused("multicast-ipv6", "https://[ff02::1]/"),
  refused("private-10", "https://10.0.0.1/"),
  refused("private-172", "https://172.16.0.1/"),
  refused("private-192", "https://192.168.1.1/"),
  refused("shared-100-64", "https://100.64.0.1/"),
  refused("benchmark", "https://198.18.0.1/"),
  refused("documentation-1", "https://192.0.2.1/"),
  refused("documentation-2", "https://198.51.100.7/"),
  refused("documentation-3", "https://203.0.113.9/"),
  refused("multicast-ipv4", "https://224.0.0.1/"),
  refused("reserved-ipv4", "https://240.0.0.1/"),
  refused("broadcast-ipv4", "https://255.255.255.255/"),
  refused("localhost", "https://localhost/"),
  refused("localhost-upper", "https://LOCALHOST/"),
  refused("localhost-trailing-dot", "https://localhost./"),
  refused("localhost-subdomain", "https://app.localhost/"),
  refused("mdns-name", "https://printer.local/"),
  refused("internal-name", "https://metadata.internal/"),
  refused("home-arpa-name", "https://router.home.arpa/"),
  refused("single-label", "https://intranet/"),
  unparseable("empty", ""),
  unparseable("no-host", "https://"),
  unparseable("no-scheme", "example.com/feed.xml"),
  unparseable("space-in-path", "https://example.com/a b"),
  unparseable("tab-in-host", "https://exa\tmple.com/"),
  unparseable("newline-in-path", "https://example.com/a\nb"),
  unparseable("carriage-return", "https://example.com/a\rb"),
  unparseable("nul-in-path", "https://example.com/a\u0000b"),
  unparseable("backslash-authority", "https://example.com\\@127.0.0.1/"),
  unparseable("too-long", `https://example.com/${"a".repeat(2100)}`),
];

/** Addresses `isBlockedAddress` must report as blocked, as the connection layer would see them. */
export const HOSTILE_FETCH_ADDRESSES: readonly string[] = [
  "127.0.0.1",
  "10.1.2.3",
  "172.16.0.1",
  "172.31.255.255",
  "192.168.1.1",
  "169.254.169.254",
  "100.64.0.1",
  "0.0.0.0",
  "198.18.0.1",
  "224.0.0.1",
  "240.0.0.1",
  "255.255.255.255",
  "192.0.0.8",
  "192.0.2.1",
  "198.51.100.7",
  "203.0.113.9",
  "192.88.99.1",
  "::1",
  "::",
  "fc00::1",
  "fd12:3456::1",
  "fe80::1",
  "fec0::1",
  "ff02::1",
  "100::1",
  "64:ff9b::1",
  "64:ff9b:1::7f00:1",
  "2001:db8::1",
  "2001::1",
  "2002:7f00:1::1",
  "::ffff:127.0.0.1",
  "::ffff:7f00:1",
  "::ffff:10.0.0.1",
  "::ffff:a9fe:a9fe",
  "::127.0.0.1",
  "fe80::1%eth0",
  "",
  " 127.0.0.1",
  "0x7f.1",
  "2130706433",
  "not an address",
];

/** Public addresses that must stay allowed (including the IPv4-mapped form of a public address). */
export const PUBLIC_FETCH_ADDRESSES: readonly string[] = [
  "93.184.216.34",
  "8.8.8.8",
  "2606:4700::1111",
  "2001:4860:4860::8888",
  "::ffff:93.184.216.34",
];

export interface HostileFetchHost {
  readonly name: string;
  /** What the (fake) resolver answers for the name. */
  readonly answers: readonly string[];
}

/**
 * Names that look harmless or are chosen to rebind: allowed only by the address they resolve to,
 * and each resolves to at least one forbidden address here.
 */
export const HOSTILE_FETCH_HOSTS: readonly HostileFetchHost[] = [
  { name: "rebind.example.invalid", answers: ["127.0.0.1"] },
  { name: "127.0.0.1.nip.io", answers: ["127.0.0.1"] },
  { name: "10-0-0-1.nip.io", answers: ["10.0.0.1"] },
  { name: "169.254.169.254.sslip.io", answers: ["169.254.169.254"] },
  { name: "metadata.example.invalid", answers: ["169.254.169.254"] },
  { name: "mixed.example.invalid", answers: ["93.184.216.34", "10.0.0.5"] },
  { name: "mixed-v6.example.invalid", answers: ["2606:4700::1111", "::1"] },
  { name: "mapped.example.invalid", answers: ["::ffff:7f00:1"] },
  { name: "mapped-dotted.example.invalid", answers: ["::ffff:192.168.0.1"] },
  { name: "linklocal.example.invalid", answers: ["fe80::1"] },
  { name: "uniquelocal.example.invalid", answers: ["fd00::1"] },
  { name: "teredo.example.invalid", answers: ["2001::1"] },
  { name: "nat64.example.invalid", answers: ["64:ff9b::7f00:1"] },
  { name: "sixtofour.example.invalid", answers: ["2002:a9fe:a9fe::1"] },
  { name: "unspecified.example.invalid", answers: ["0.0.0.0"] },
];

export interface HostileFetchLocation {
  readonly name: string;
  /** The Location header of a 3xx response; undefined means the header is absent. */
  readonly location: string | undefined;
}

/** Redirect targets that must end in unsafe-redirect with no second request. */
export const HOSTILE_FETCH_LOCATIONS: readonly HostileFetchLocation[] = [
  { name: "downgrade-to-http", location: "http://b.example.invalid/" },
  { name: "loopback", location: "https://127.0.0.1/" },
  { name: "mapped-loopback", location: "https://[::ffff:127.0.0.1]/" },
  { name: "metadata", location: "https://169.254.169.254/latest/meta-data/" },
  { name: "decimal-ipv4", location: "https://2130706433/" },
  { name: "hex-ipv4", location: "https://0x7f.1/" },
  { name: "short-ipv4", location: "https://127.1/" },
  { name: "private-10", location: "https://10.0.0.1/" },
  { name: "protocol-relative-loopback", location: "//127.0.0.1/" },
  { name: "protocol-relative-http-scheme-less-port", location: "//b.example.invalid:8443/" },
  { name: "localhost", location: "https://localhost/" },
  { name: "internal-name", location: "https://metadata.internal/" },
  { name: "single-label", location: "https://intranet/" },
  { name: "userinfo", location: "https://user:pw@example.com/" },
  { name: "other-port", location: "https://b.example.invalid:8443/" },
  { name: "trailing-dot", location: "https://b.example.invalid./" },
  { name: "javascript", location: "javascript:alert(1)" },
  { name: "data", location: "data:text/html,x" },
  { name: "ftp", location: "ftp://b.example.invalid/" },
  { name: "file", location: "file:///etc/passwd" },
  { name: "absent", location: undefined },
  { name: "empty", location: "" },
  { name: "header-injection", location: "https://b.example.invalid/\r\nSet-Cookie: a=b" },
  { name: "backslash", location: "https://b.example.invalid\\@127.0.0.1/" },
  { name: "space", location: "https://b.example.invalid/a b" },
];

export interface HostileFetchResponse {
  readonly name: string;
  readonly contentType: string;
  /** "feed" fetches as a feed source, "page" as a page source. */
  readonly kind: "feed" | "page";
  readonly body: Uint8Array;
  /** Refused with parse-failure, or decoded to exactly this text. */
  readonly expect: { readonly refused: true } | { readonly text: string };
}

const MARKUP = "<p>ok</p><div hidden>SECRET</div>";

function withBom(bom: readonly number[], body: Uint8Array): Uint8Array {
  return Buffer.concat([Buffer.from(bom), body]);
}

function utf16be(text: string): Uint8Array {
  const little = Buffer.from(text, "utf16le");
  const big = Buffer.alloc(little.length);
  for (let i = 0; i + 1 < little.length; i += 2) {
    big[i] = little[i + 1] ?? 0;
    big[i + 1] = little[i] ?? 0;
  }
  return big;
}

/** Documents whose character set an attacker hides or lies about (wave 2 review MAJOR 4). */
export const HOSTILE_FETCH_RESPONSES: readonly HostileFetchResponse[] = [
  {
    name: "utf16le-bom-hidden-block",
    contentType: "text/html",
    kind: "page",
    body: withBom([0xff, 0xfe], Buffer.from(MARKUP, "utf16le")),
    expect: { text: MARKUP },
  },
  {
    name: "utf16le-bom-served-as-utf8",
    contentType: "text/html; charset=utf-8",
    kind: "page",
    body: withBom([0xff, 0xfe], Buffer.from(MARKUP, "utf16le")),
    expect: { text: MARKUP },
  },
  {
    name: "utf16be-bom-hidden-block",
    contentType: "text/html",
    kind: "page",
    body: withBom([0xfe, 0xff], utf16be(MARKUP)),
    expect: { text: MARKUP },
  },
  {
    name: "utf16le-no-bom-served-as-utf8",
    contentType: "text/html; charset=utf-8",
    kind: "page",
    body: Buffer.from(MARKUP, "utf16le"),
    expect: { refused: true },
  },
  {
    name: "utf16be-no-bom-served-as-utf8",
    contentType: "text/html; charset=utf-8",
    kind: "page",
    body: utf16be(MARKUP),
    expect: { refused: true },
  },
  {
    name: "utf32le-bom",
    contentType: "text/html",
    kind: "page",
    body: withBom(
      [0xff, 0xfe, 0x00, 0x00],
      Buffer.from("<\u0000\u0000\u0000p\u0000\u0000\u0000", "latin1"),
    ),
    expect: { refused: true },
  },
  {
    name: "no-bom-no-charset-no-meta",
    contentType: "text/html",
    kind: "page",
    body: Buffer.from(MARKUP, "latin1"),
    expect: { refused: true },
  },
  {
    name: "no-content-type-charset-text-plain",
    contentType: "text/plain",
    kind: "page",
    body: Buffer.from(MARKUP, "latin1"),
    expect: { refused: true },
  },
  {
    name: "meta-after-prescan-window",
    contentType: "text/html",
    kind: "page",
    body: Buffer.from(`${" ".repeat(1100)}<meta charset="utf-8">${MARKUP}`, "latin1"),
    expect: { refused: true },
  },
  {
    name: "meta-inside-comment",
    contentType: "text/html",
    kind: "page",
    body: Buffer.from(`<!-- <meta charset="utf-8"> -->${MARKUP}`, "latin1"),
    expect: { refused: true },
  },
  {
    name: "utf7-label",
    contentType: "text/html; charset=utf-7",
    kind: "page",
    body: Buffer.from("+ADw-div hidden+AD4-SECRET+ADw-/div+AD4-", "latin1"),
    expect: { refused: true },
  },
  {
    name: "unknown-label",
    contentType: "text/html; charset=x-attacker",
    kind: "page",
    body: Buffer.from(MARKUP, "latin1"),
    expect: { refused: true },
  },
  {
    name: "nul-inside-utf8",
    contentType: "text/html; charset=utf-8",
    kind: "page",
    body: Buffer.from("<p>a\u0000b</p>", "latin1"),
    expect: { refused: true },
  },
  {
    name: "feed-without-declaration",
    contentType: "application/atom+xml",
    kind: "feed",
    body: Buffer.from("<feed></feed>", "latin1"),
    expect: { refused: true },
  },
  {
    name: "feed-declares-utf16-in-ascii",
    contentType: "application/atom+xml",
    kind: "feed",
    body: Buffer.from('<?xml version="1.0" encoding="UTF-16"?><feed></feed>', "latin1"),
    expect: { refused: true },
  },
  {
    name: "feed-octet-stream-utf16-no-bom",
    contentType: "application/octet-stream",
    kind: "feed",
    body: Buffer.from("<feed></feed>", "utf16le"),
    expect: { refused: true },
  },
];
