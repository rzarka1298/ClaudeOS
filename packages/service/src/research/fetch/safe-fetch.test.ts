import { Agent } from "node:https";
import { describe, expect, it } from "vitest";
import { safeLookup } from "./address-policy.js";
import { ACCEPT_BY_KIND, USER_AGENT } from "./limits.js";
import { createSafeFetcher } from "./safe-fetch.js";
import { createFakeHttps, headersOf } from "./test-support/fake-https.js";

const FEED_URL = "https://feeds.example.invalid/a.atom";
const PAGE_URL = "https://pages.example.invalid/post";

const ATOM_HEAD =
  '<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">';

function atomOfSize(bytes: number): string {
  const filler = "x".repeat(Math.max(0, bytes - ATOM_HEAD.length - "</feed>".length));
  return `${ATOM_HEAD}${filler}</feed>`;
}

function fetcherFor(script: Parameters<typeof createFakeHttps>[0], exerciseLookup = false) {
  const fake = createFakeHttps(script, { exerciseLookup });
  const fetcher = createSafeFetcher({ request: fake.request, env: {}, execArgv: [] });
  return { fake, fetcher };
}

describe("Test 1 (tracer): one allowlisted feed is fetched with the address validator attached", () => {
  it("issues one GET on port 443 with safeLookup, an explicit agent and fixed headers", async () => {
    const { fake, fetcher } = fetcherFor(() => ({
      headers: headersOf("application/atom+xml; charset=utf-8"),
      body: atomOfSize(10 * 1024),
    }));
    const result = await fetcher.fetchSource({ url: FEED_URL, kind: "feed" });

    expect(fake.calls).toHaveLength(1);
    const options = fake.calls[0]?.options;
    expect(options?.method).toBe("GET");
    expect(options?.port).toBe(443);
    expect(options?.hostname).toBe("feeds.example.invalid");
    expect(options?.path).toBe("/a.atom");
    expect(options?.lookup).toBe(safeLookup);
    expect(options?.agent).toBeInstanceOf(Agent);
    expect(options?.headers).toEqual({
      accept: ACCEPT_BY_KIND.feed,
      "accept-encoding": "identity",
      "user-agent": USER_AGENT,
    });
    const names = Object.keys(options?.headers ?? {}).map((name) => name.toLowerCase());
    expect(names).not.toContain("cookie");
    expect(names).not.toContain("authorization");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bytes.byteLength).toBe(10 * 1024);
      expect(result.contentType).toBe("application/atom+xml");
      expect(result.finalUrl).toBe(FEED_URL);
    }
  });

  it("uses a keep-alive-free agent", async () => {
    const { fake, fetcher } = fetcherFor(() => ({
      headers: headersOf("application/atom+xml; charset=utf-8"),
      body: atomOfSize(200),
    }));
    await fetcher.fetchSource({ url: FEED_URL, kind: "feed" });
    const agent = fake.calls[0]?.options.agent as (Agent & { keepAlive?: boolean }) | undefined;
    expect(agent?.keepAlive).toBe(false);
  });
});

describe("Test 2 (status): a non-success status is one closed code", () => {
  for (const status of [404, 500]) {
    it(`status ${status} is http-status and carries no body, header or status text`, async () => {
      const { fetcher } = fetcherFor(() => ({
        status,
        headers: headersOf("text/html; charset=utf-8", { "x-secret": "leak-me" }),
        body: "<p>leak-body</p>",
      }));
      const result = await fetcher.fetchSource({ url: PAGE_URL, kind: "page" });
      expect(result).toEqual({ ok: false, code: "http-status" });
      const text = JSON.stringify(result);
      expect(text).not.toContain("leak");
    });
  }
});

describe("Test 3 (content type): the allowlist, with octet-stream only for an XML feed", () => {
  it("accepts text/html for a page and application/rss+xml for a feed", async () => {
    const page = fetcherFor(() => ({
      headers: headersOf("text/html; charset=utf-8"),
      body: "<p>hello</p>",
    }));
    expect((await page.fetcher.fetchSource({ url: PAGE_URL, kind: "page" })).ok).toBe(true);
    const feed = fetcherFor(() => ({
      headers: headersOf("application/rss+xml; charset=utf-8"),
      body: '<?xml version="1.0" encoding="UTF-8"?><rss></rss>',
    }));
    expect((await feed.fetcher.fetchSource({ url: FEED_URL, kind: "feed" })).ok).toBe(true);
  });

  it("refuses image/png and a missing content type as content-type", async () => {
    const png = fetcherFor(() => ({ headers: headersOf("image/png"), body: "PNG" }));
    expect(await png.fetcher.fetchSource({ url: PAGE_URL, kind: "page" })).toEqual({
      ok: false,
      code: "content-type",
    });
    const none = fetcherFor(() => ({ body: "<p>x</p>" }));
    expect(await none.fetcher.fetchSource({ url: PAGE_URL, kind: "page" })).toEqual({
      ok: false,
      code: "content-type",
    });
  });

  const XML_STARTS = [
    '<?xml version="1.0" encoding="UTF-8"?><feed></feed>',
    "<feed></feed>",
    "<rss></rss>",
  ];
  for (const start of XML_STARTS) {
    it(`accepts application/octet-stream for a feed that starts with ${start.slice(0, 6)}`, async () => {
      const { fetcher } = fetcherFor(() => ({
        headers: headersOf("application/octet-stream"),
        body: start,
      }));
      const result = await fetcher.fetchSource({ url: FEED_URL, kind: "feed" });
      // Decoding is checked in the decode tests; here only the content-type decision matters.
      expect(result).not.toEqual({ ok: false, code: "content-type" });
    });
  }

  it("refuses octet-stream for a page and for non-XML feed bytes", async () => {
    const page = fetcherFor(() => ({
      headers: headersOf("application/octet-stream"),
      body: '<?xml version="1.0" encoding="UTF-8"?><feed></feed>',
    }));
    expect(await page.fetcher.fetchSource({ url: PAGE_URL, kind: "page" })).toEqual({
      ok: false,
      code: "content-type",
    });
    const junk = fetcherFor(() => ({
      headers: headersOf("application/octet-stream"),
      body: "MZ binary junk",
    }));
    expect(await junk.fetcher.fetchSource({ url: FEED_URL, kind: "feed" })).toEqual({
      ok: false,
      code: "content-type",
    });
  });
});

describe("Test 4 (encoding): any content-encoding is refused before the body is read", () => {
  it("refuses gzip as content-type without reading", async () => {
    let read = false;
    const { fetcher } = fetcherFor(() => ({
      headers: headersOf("text/html; charset=utf-8", { "content-encoding": "gzip" }),
      get body() {
        read = true;
        return "<p>x</p>";
      },
    }));
    const result = await fetcher.fetchSource({ url: PAGE_URL, kind: "page" });
    expect(result).toEqual({ ok: false, code: "content-type" });
    expect(read).toBe(false);
  });

  it("accepts an explicit identity content-encoding", async () => {
    const { fetcher } = fetcherFor(() => ({
      headers: headersOf("text/html; charset=utf-8", { "content-encoding": "identity" }),
      body: "<p>x</p>",
    }));
    expect((await fetcher.fetchSource({ url: PAGE_URL, kind: "page" })).ok).toBe(true);
  });
});
