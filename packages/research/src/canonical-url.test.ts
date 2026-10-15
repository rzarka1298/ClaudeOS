// URL canonicalisation (plan 07-04 Task 2 Test 7, D-11, research Pattern 4). The canonical string
// is the input to the 32-hex source id, so its shape is pinned exactly. Address refusal itself
// (loopback, private ranges) is the service fetcher's job, not this module's.
import { describe, expect, it } from "vitest";
import { canonicaliseUrl, URL_REJECT_REASONS } from "./canonical-url.js";

function ok(input: string): string {
  const result = canonicaliseUrl(input);
  if (!result.ok) throw new Error(`expected ${input} to canonicalise, got ${result.reason}`);
  return result.url;
}

function reason(input: string): string {
  const result = canonicaliseUrl(input);
  if (result.ok) throw new Error(`expected ${input} to be rejected, got ${result.url}`);
  return result.reason;
}

describe("Test 7 (canonical URL): accepted forms", () => {
  it("lowercases the host, strips a trailing dot, drops the fragment and tracking parameters, sorts the rest", () => {
    expect(ok("https://Example.COM/a?utm_source=x&b=2&a=1#frag")).toBe(
      "https://example.com/a?a=1&b=2",
    );
  });

  it("returns the host alongside the url", () => {
    const result = canonicaliseUrl("https://Example.COM/a");
    expect(result).toEqual({ ok: true, url: "https://example.com/a", host: "example.com" });
  });

  it("drops fbclid, gclid, ref and every utm_ parameter in any case, and keeps the others", () => {
    expect(
      ok("https://example.com/p?fbclid=1&gclid=2&ref=3&UTM_Medium=4&utm_campaign=5&keep=6&refx=7"),
    ).toBe("https://example.com/p?keep=6&refx=7");
  });

  it("leaves no question mark when every parameter was a tracking parameter", () => {
    expect(ok("https://example.com/p?utm_source=a&fbclid=b")).toBe("https://example.com/p");
  });

  it("turns an empty path into a single slash", () => {
    expect(ok("https://example.com")).toBe("https://example.com/");
    expect(ok("https://example.com?b=1")).toBe("https://example.com/?b=1");
  });

  it("accepts the explicit default port and omits it", () => {
    expect(ok("https://example.com:443/x")).toBe("https://example.com/x");
  });

  it("sorts parameters by name then value, keeping repeated names", () => {
    expect(ok("https://example.com/?b=2&a=2&a=1")).toBe("https://example.com/?a=1&a=2&b=2");
  });

  it("accepts a punycode host as written and lowercases it", () => {
    expect(ok("https://XN--BCHER-KVA.example/")).toBe("https://xn--bcher-kva.example/");
  });

  it("is idempotent: a canonical url canonicalises to itself", () => {
    for (const input of [
      "https://Example.COM/a?utm_source=x&b=2&a=1#frag",
      "https://example.com",
      "https://example.com/a%20b?q=a+b&z=%C3%A9",
    ]) {
      const once = ok(input);
      expect(ok(once)).toBe(once);
    }
  });
});

describe("Test 7 (canonical URL): rejections carry a closed reason code and never throw", () => {
  it("rejects userinfo", () => {
    expect(reason("https://user:pw@example.com/")).toBe("userinfo");
    expect(reason("https://user@example.com/")).toBe("userinfo");
    expect(reason("https://example.com@example.net/")).toBe("userinfo");
  });

  it("rejects any scheme other than https", () => {
    expect(reason("http://example.com/")).toBe("not-https");
    expect(reason("javascript:alert(1)")).toBe("not-https");
    expect(reason("ftp://example.com/")).toBe("not-https");
    expect(reason("file:///etc/passwd")).toBe("not-https");
    expect(reason("data:text/html,x")).toBe("not-https");
  });

  it("rejects a port other than 443", () => {
    expect(reason("https://example.com:8443/")).toBe("bad-port");
    expect(reason("https://example.com:80/")).toBe("bad-port");
  });

  it("rejects an empty host", () => {
    expect(reason("https://./")).toBe("empty-host");
    expect(reason("https://")).toBe("empty-host");
    expect(reason("https:///x")).toBe("empty-host");
  });

  it("rejects text that is not a URL", () => {
    expect(reason("not a url")).toBe("invalid-url");
    expect(reason("")).toBe("invalid-url");
    expect(reason("//example.com/x")).toBe("invalid-url");
    expect(reason("/relative/path")).toBe("invalid-url");
  });

  it("rejects input that contains a control, format or whitespace character", () => {
    expect(reason("https://exa\nmple.com/")).toBe("invalid-url");
    expect(reason("https://example.com/\u0000")).toBe("invalid-url");
    expect(reason("https://example.com/a\u202Eb")).toBe("invalid-url");
    expect(reason("https://example.com/a\u200Bb")).toBe("invalid-url");
    expect(reason(" https://example.com/")).toBe("invalid-url");
  });

  it("rejects an address longer than 2,048 characters", () => {
    expect(reason(`https://example.com/${"a".repeat(2_100)}`)).toBe("too-long");
  });

  it("only ever returns a code from the closed list", () => {
    const inputs = ["", "x", "https://", "http://a/", "https://u@a/", "https://a:1/", "https://./"];
    for (const input of inputs) {
      const result = canonicaliseUrl(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(URL_REJECT_REASONS).toContain(result.reason);
    }
  });
});
