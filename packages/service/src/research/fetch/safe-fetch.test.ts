import { Agent } from "node:https";
import { SOURCE_FAILURE_CODES } from "@ccc/domain";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createSafeLookup, safeLookup } from "./address-policy.js";
import {
  ACCEPT_BY_KIND,
  FETCH_CONCURRENCY,
  IDLE_TIMEOUT_MS,
  MAX_HEADER_BYTES,
  RUN_BYTE_CAP,
  TOTAL_TIMEOUT_MS,
  USER_AGENT,
} from "./limits.js";
import {
  createRunBudget,
  createSafeFetcher,
  type FetchSourceResult,
  type RunBudget,
} from "./safe-fetch.js";
import {
  createFakeHttps,
  headersOf,
  type RecordedCall,
  type Script,
  tableResolver,
} from "./test-support/fake-https.js";

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

// ---------------------------------------------------------------------------------------------
// Task 3: redirects, caps, time, errors, proxy refusal, decoding, hostile resolution
// ---------------------------------------------------------------------------------------------

const PUBLIC = "93.184.216.34";
const CLOSED_CODES: readonly string[] = SOURCE_FAILURE_CODES;
const seenCodes = new Set<string>();

afterAll(() => {
  for (const code of seenCodes) expect(CLOSED_CODES).toContain(code);
});

/** Answers a public address for any `*.example.invalid` name unless the table says otherwise. */
function resolverWith(overrides: Readonly<Record<string, readonly string[]>> = {}) {
  const table = tableResolver(overrides);
  return (
    ...args: Parameters<ReturnType<typeof tableResolver>>
  ): ReturnType<ReturnType<typeof tableResolver>> => {
    const [hostname, options, callback] = args;
    const name = hostname.toLowerCase();
    if (overrides[name] === undefined && name.endsWith(".example.invalid")) {
      return tableResolver({ [name]: [PUBLIC] })(hostname, options, callback);
    }
    return table(hostname, options, callback);
  };
}

type Routes = Readonly<Record<string, Script>>;

function routed(routes: Routes, fallback?: Script): (call: RecordedCall) => Script {
  return (call) => {
    const route = routes[call.url.replace(/^https:\/\//, "")] ?? fallback;
    if (route === undefined) throw new Error(`no route for ${call.url}`);
    return route;
  };
}

interface Rig {
  readonly fake: ReturnType<typeof createFakeHttps>;
  readonly fetcher: ReturnType<typeof createSafeFetcher>;
  readonly logs: { event: string; code: string }[];
}

function rig(
  script: (call: RecordedCall) => Script,
  overrides: Readonly<Record<string, readonly string[]>> = {},
  env: NodeJS.ProcessEnv = {},
  execArgv: readonly string[] = [],
): Rig {
  const fake = createFakeHttps(script);
  const logs: { event: string; code: string }[] = [];
  const fetcher = createSafeFetcher({
    request: fake.request,
    lookup: createSafeLookup(resolverWith(overrides)),
    env,
    execArgv,
    log: (entry) => logs.push(entry),
  });
  return { fake, fetcher, logs };
}

async function run(
  target: Rig,
  url: string,
  kind: "feed" | "page" = "page",
  budget?: RunBudget,
): Promise<FetchSourceResult> {
  const result = await target.fetcher.fetchSource(
    budget === undefined ? { url, kind } : { url, kind, budget },
  );
  if (!result.ok) seenCodes.add(result.code);
  return result;
}

const HTML = headersOf("text/html; charset=utf-8");
const OK_PAGE: Script = { headers: HTML, body: "<p>ok</p>" };

function redirect(location: string | undefined, status = 301): Script {
  return {
    status,
    headers: location === undefined ? {} : { location },
    body: "<p>leak-redirect-body</p>",
  };
}

describe("Task 3 Test 1 (redirects): manual, re-validated, at most three", () => {
  it("follows a 301 to another https host and reports the final address", async () => {
    const target = rig(
      routed({
        "a.example.invalid/start": redirect("https://b.example.invalid/next#frag"),
        "b.example.invalid/next": OK_PAGE,
      }),
    );
    const result = await run(target, "https://a.example.invalid/start");
    expect(result.ok && result.finalUrl).toBe("https://b.example.invalid/next");
    expect(target.fake.calls).toHaveLength(2);
    // Every hop carries the validator, the same agent and the same fixed headers.
    const [first, second] = target.fake.calls;
    expect(second?.options.lookup).toBe(first?.options.lookup);
    expect(second?.options.agent).toBe(first?.options.agent);
    expect(second?.options.headers).toEqual(first?.options.headers);
    expect(first?.responseDestroyed).toBe(true);
    expect(first?.bytesDelivered).toBe(0);
  });

  for (const status of [301, 302, 303, 307, 308]) {
    it(`follows status ${status}`, async () => {
      const target = rig(
        routed({
          "a.example.invalid/": redirect("https://b.example.invalid/", status),
          "b.example.invalid/": OK_PAGE,
        }),
      );
      expect((await run(target, "https://a.example.invalid/")).ok).toBe(true);
    });
  }

  it("resolves a relative Location against the current address", async () => {
    const target = rig(
      routed({
        "a.example.invalid/dir/start": redirect("../other?x=1"),
        "a.example.invalid/other?x=1": OK_PAGE,
      }),
    );
    const result = await run(target, "https://a.example.invalid/dir/start");
    expect(result.ok && result.finalUrl).toBe("https://a.example.invalid/other?x=1");
  });

  it("follows three redirects and refuses a fourth with redirect-limit", async () => {
    const chain = (length: number): Routes => {
      const routes: Record<string, Script> = {};
      for (let i = 0; i < length; i += 1) {
        routes[`h${i}.example.invalid/`] = redirect(`https://h${i + 1}.example.invalid/`);
      }
      routes[`h${length}.example.invalid/`] = OK_PAGE;
      return routes;
    };
    const three = rig(routed(chain(3)));
    expect((await run(three, "https://h0.example.invalid/")).ok).toBe(true);
    expect(three.fake.calls).toHaveLength(4);

    const four = rig(routed(chain(4)));
    expect(await run(four, "https://h0.example.invalid/")).toEqual({
      ok: false,
      code: "redirect-limit",
    });
    expect(four.fake.calls).toHaveLength(4);
  });

  it("stops a redirect loop at the limit", async () => {
    const target = rig(() => redirect("https://loop.example.invalid/"));
    expect(await run(target, "https://loop.example.invalid/")).toEqual({
      ok: false,
      code: "redirect-limit",
    });
    expect(target.fake.calls.length).toBeLessThanOrEqual(4);
  });

  const UNSAFE_LOCATIONS: readonly (readonly [string, string | undefined])[] = [
    ["downgrade to http", "http://b.example.invalid/"],
    ["loopback literal", "https://127.0.0.1/"],
    ["mapped loopback literal", "https://[::ffff:127.0.0.1]/"],
    ["metadata literal", "https://169.254.169.254/latest/meta-data/"],
    ["decimal literal", "https://2130706433/"],
    ["hex literal", "https://0x7f.1/"],
    ["short literal", "https://127.1/"],
    ["private literal", "https://10.0.0.1/"],
    ["protocol-relative loopback", "//127.0.0.1/"],
    ["localhost", "https://localhost/"],
    ["internal name", "https://metadata.internal/"],
    ["single label", "https://intranet/"],
    ["userinfo", "https://user:pw@example.com/"],
    ["other port", "https://b.example.invalid:8443/"],
    ["trailing dot", "https://b.example.invalid./"],
    ["javascript", "javascript:alert(1)"],
    ["data", "data:text/html,x"],
    ["ftp", "ftp://b.example.invalid/"],
    ["no Location header", undefined],
    ["empty Location", ""],
    ["Location with a line break", "https://b.example.invalid/\r\nSet-Cookie: a=b"],
  ];
  for (const [name, location] of UNSAFE_LOCATIONS) {
    it(`refuses a redirect to ${name} as unsafe-redirect`, async () => {
      const target = rig(routed({ "a.example.invalid/": redirect(location) }));
      expect(await run(target, "https://a.example.invalid/")).toEqual({
        ok: false,
        code: "unsafe-redirect",
      });
      expect(target.fake.calls).toHaveLength(1);
    });
  }

  it("treats 300 and 304 as http-status", async () => {
    for (const status of [300, 304]) {
      const target = rig(() => ({ status, headers: { location: "https://b.example.invalid/" } }));
      expect(await run(target, "https://a.example.invalid/")).toEqual({
        ok: false,
        code: "http-status",
      });
    }
  });

  it("returns http-status for a failing status after a redirect", async () => {
    const target = rig(
      routed({
        "a.example.invalid/": redirect("https://b.example.invalid/"),
        "b.example.invalid/": { status: 500 },
      }),
    );
    expect(await run(target, "https://a.example.invalid/")).toEqual({
      ok: false,
      code: "http-status",
    });
  });
});

describe("Task 3 Test 1b (resolved addresses): a name is allowed only by what it resolves to", () => {
  const HOSTILE: Readonly<Record<string, readonly string[]>> = {
    "rebind.example.invalid": ["127.0.0.1"],
    "127.0.0.1.nip.io": ["127.0.0.1"],
    "10-0-0-1.nip.io": ["10.0.0.1"],
    "169.254.169.254.sslip.io": ["169.254.169.254"],
    "mixed.example.invalid": [PUBLIC, "10.0.0.5"],
    "mapped.example.invalid": ["::ffff:7f00:1"],
    "v6.example.invalid": ["::1"],
    "linklocal.example.invalid": ["fe80::1"],
    "teredo.example.invalid": ["2001::1"],
  };

  for (const name of Object.keys(HOSTILE)) {
    it(`refuses ${name} as a source with refused-address`, async () => {
      const target = rig(() => OK_PAGE, HOSTILE);
      expect(await run(target, `https://${name}/`)).toEqual({ ok: false, code: "refused-address" });
      // The request was attempted (so the lookup ran) but no response was ever read.
      expect(target.fake.calls.every((call) => call.bytesDelivered === 0)).toBe(true);
    });

    it(`refuses a redirect to ${name} with refused-address`, async () => {
      const target = rig(
        routed({ "a.example.invalid/": redirect(`https://${name}/x`) }, OK_PAGE),
        HOSTILE,
      );
      expect(await run(target, "https://a.example.invalid/")).toEqual({
        ok: false,
        code: "refused-address",
      });
    });
  }

  it("refuses a connection whose peer address is private, whatever the lookup said", async () => {
    for (const remoteAddress of ["127.0.0.1", "::ffff:10.0.0.1", "169.254.169.254"]) {
      const target = rig(() => ({ headers: HTML, body: "<p>x</p>", remoteAddress }));
      expect(await run(target, "https://a.example.invalid/")).toEqual({
        ok: false,
        code: "refused-address",
      });
      expect(target.fake.calls[0]?.responseDestroyed).toBe(true);
    }
  });

  it("connects to the address it validated: the lookup is the only resolution", async () => {
    const target = rig(() => OK_PAGE);
    await run(target, "https://a.example.invalid/");
    expect(target.fake.calls[0]?.resolved).toEqual([PUBLIC]);
    // Nothing but `hostname` and the validated `lookup` selects the peer: no host override, no proxy.
    const options = target.fake.calls[0]?.options as unknown as Record<string, unknown>;
    for (const key of ["host", "socketPath", "createConnection", "family", "localAddress"]) {
      expect(options[key]).toBeUndefined();
    }
  });
});

describe("Task 3 Test 2 (size): declared and counted bytes", () => {
  const KIB = 1024;

  it("refuses a content-length above the page cap before reading", async () => {
    const target = rig(() => ({
      headers: headersOf("text/html; charset=utf-8", { "content-length": String(512 * KIB + 1) }),
      body: "<p>x</p>",
    }));
    expect(await run(target, "https://a.example.invalid/")).toEqual({
      ok: false,
      code: "oversize",
    });
    expect(target.fake.calls[0]?.bytesDelivered).toBe(0);
    expect(target.fake.calls[0]?.responseDestroyed).toBe(true);
  });

  it("applies the larger feed cap to a feed", async () => {
    const feedHeaders = (length: number) =>
      headersOf("application/atom+xml; charset=utf-8", { "content-length": String(length) });
    const over = rig(() => ({ headers: feedHeaders(1024 * KIB + 1), body: "x" }));
    expect(await run(over, "https://a.example.invalid/", "feed")).toEqual({
      ok: false,
      code: "oversize",
    });
    const within = rig(() => ({
      headers: feedHeaders(600 * KIB),
      body: atomOfSize(600 * KIB),
    }));
    expect((await run(within, "https://a.example.invalid/", "feed")).ok).toBe(true);
  });

  it("accepts a body of exactly the page cap", async () => {
    const body = "a".repeat(512 * KIB);
    const target = rig(() => ({ headers: HTML, body }));
    const result = await run(target, "https://a.example.invalid/");
    expect(result.ok && result.bytes.byteLength).toBe(512 * KIB);
  });

  it("destroys a chunked body that crosses the cap, mid-stream", async () => {
    const chunks = Array.from({ length: 40 }, () => "a".repeat(64 * KIB));
    const target = rig(() => ({ headers: HTML, body: chunks }));
    expect(await run(target, "https://a.example.invalid/")).toEqual({
      ok: false,
      code: "oversize",
    });
    const call = target.fake.calls[0];
    expect(call?.responseDestroyed).toBe(true);
    // 8 chunks fill the cap; the 9th crosses it and nothing more is read.
    expect(call?.bytesDelivered).toBeLessThanOrEqual(9 * 64 * KIB);
  });

  it("counts the stream when the declared length lies", async () => {
    const target = rig(() => ({
      headers: headersOf("text/html; charset=utf-8", { "content-length": "10" }),
      body: ["a".repeat(300 * KIB), "a".repeat(300 * KIB)],
    }));
    expect(await run(target, "https://a.example.invalid/")).toEqual({
      ok: false,
      code: "oversize",
    });
  });

  it("ignores a content-length that is not a number and counts instead", async () => {
    const target = rig(() => ({
      headers: headersOf("text/html; charset=utf-8", { "content-length": "abc" }),
      body: "<p>ok</p>",
    }));
    expect((await run(target, "https://a.example.invalid/")).ok).toBe(true);
  });

  it("returns empty-content for a zero-byte 200", async () => {
    const target = rig(() => ({ headers: HTML }));
    expect(await run(target, "https://a.example.invalid/")).toEqual({
      ok: false,
      code: "empty-content",
    });
  });

  it("holds the run total across sources and destroys the response that crosses it", async () => {
    const budget = createRunBudget(100 * KIB);
    const target = rig(() => ({
      headers: HTML,
      body: ["a".repeat(30 * KIB), "a".repeat(30 * KIB)],
    }));
    expect((await run(target, "https://a.example.invalid/1", "page", budget)).ok).toBe(true);
    expect(budget.remaining()).toBe(40 * KIB);
    expect(await run(target, "https://a.example.invalid/2", "page", budget)).toEqual({
      ok: false,
      code: "oversize",
    });
    expect(target.fake.calls[1]?.responseDestroyed).toBe(true);
    expect(budget.remaining()).toBe(0);
  });

  it("refuses a declared length above what is left of the run total before reading", async () => {
    const budget = createRunBudget(10 * KIB);
    const target = rig(() => ({
      headers: headersOf("text/html; charset=utf-8", { "content-length": String(20 * KIB) }),
      body: "x",
    }));
    expect(await run(target, "https://a.example.invalid/", "page", budget)).toEqual({
      ok: false,
      code: "oversize",
    });
    expect(target.fake.calls[0]?.bytesDelivered).toBe(0);
  });

  it("gives the run total its documented size", () => {
    expect(createRunBudget().remaining()).toBe(RUN_BYTE_CAP);
    expect(RUN_BYTE_CAP).toBe(6 * 1024 * KIB);
  });
});

describe("Task 3 Test 3 (time): idle and total deadlines, with every socket released", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes the socket idle timeout, the header size bound and a live signal to every request", async () => {
    const target = rig(() => OK_PAGE);
    await run(target, "https://a.example.invalid/");
    const options = target.fake.calls[0]?.options;
    expect(options?.timeout).toBe(IDLE_TIMEOUT_MS);
    expect(options?.maxHeaderSize).toBe(MAX_HEADER_BYTES);
    expect(MAX_HEADER_BYTES).toBeLessThanOrEqual(16 * 1024);
  });

  it("answers timeout when the socket reports its idle timeout, and destroys the request", async () => {
    const target = rig(() => ({ socketTimeout: true }));
    expect(await run(target, "https://a.example.invalid/")).toEqual({
      ok: false,
      code: "timeout",
    });
    expect(target.fake.calls[0]?.requestDestroyed).toBe(true);
  });

  it("answers timeout when connect or the handshake never completes (no socket event)", async () => {
    vi.useFakeTimers();
    const target = rig(() => ({ hang: true }));
    const pending = run(target, "https://a.example.invalid/");
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS + 1);
    expect(await pending).toEqual({ ok: false, code: "timeout" });
    expect(target.fake.calls[0]?.requestDestroyed).toBe(true);
    expect(target.fake.calls[0]?.options.signal.aborted).toBe(true);
  });

  it("answers timeout when the headers are slow", async () => {
    vi.useFakeTimers();
    const target = rig(() => ({ headers: HTML, body: "<p>x</p>", responseDelayMs: 9_000 }));
    const pending = run(target, "https://a.example.invalid/");
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS + 1);
    expect(await pending).toEqual({ ok: false, code: "timeout" });
  });

  it("answers timeout when the body stalls past the idle timeout, and destroys the response", async () => {
    vi.useFakeTimers();
    const target = rig(() => ({
      headers: HTML,
      body: ["<p>a</p>", "<p>b</p>"],
      stallAfterChunks: 1,
    }));
    const pending = run(target, "https://a.example.invalid/");
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS + 1);
    expect(await pending).toEqual({ ok: false, code: "timeout" });
    expect(target.fake.calls[0]?.responseDestroyed).toBe(true);
    expect(target.fake.calls[0]?.requestDestroyed).toBe(true);
  });

  it("holds a slow-drip body (one byte every 7 s) to the 15 s total", async () => {
    vi.useFakeTimers();
    const target = rig(() => ({
      headers: HTML,
      body: Array.from({ length: 30 }, () => "x"),
      chunkDelayMs: 7_000,
    }));
    const pending = run(target, "https://a.example.invalid/");
    await vi.advanceTimersByTimeAsync(TOTAL_TIMEOUT_MS + 1);
    expect(await pending).toEqual({ ok: false, code: "timeout" });
    expect(target.fake.calls[0]?.bytesDelivered).toBeLessThanOrEqual(2);
    expect(target.fake.calls[0]?.responseDestroyed).toBe(true);
  });

  it("shares the total deadline across redirect hops", async () => {
    vi.useFakeTimers();
    const target = rig(
      routed({
        "h0.example.invalid/": {
          ...redirect("https://h1.example.invalid/"),
          responseDelayMs: 7_000,
        },
        "h1.example.invalid/": {
          ...redirect("https://h2.example.invalid/"),
          responseDelayMs: 7_000,
        },
        "h2.example.invalid/": {
          ...redirect("https://h3.example.invalid/"),
          responseDelayMs: 7_000,
        },
        "h3.example.invalid/": OK_PAGE,
      }),
    );
    const pending = run(target, "https://h0.example.invalid/");
    await vi.advanceTimersByTimeAsync(TOTAL_TIMEOUT_MS + 1);
    expect(await pending).toEqual({ ok: false, code: "timeout" });
  });

  it("clears every timer on success and on failure", async () => {
    vi.useFakeTimers();
    const ok = rig(() => OK_PAGE);
    expect((await run(ok, "https://a.example.invalid/")).ok).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    const bad = rig(() => ({ status: 404 }));
    await run(bad, "https://a.example.invalid/");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Task 3 Test 4 (errors): one closed code, no remote text", () => {
  const coded = (code: string): Script => ({
    error: Object.assign(new Error("remote said: SECRET-TOKEN"), { code }),
  });

  const MAPPING: readonly (readonly [string, string])[] = [
    ["ENOTFOUND", "dns-failure"],
    ["EAI_AGAIN", "dns-failure"],
    ["ENODATA", "dns-failure"],
    ["CERT_HAS_EXPIRED", "tls-failure"],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "tls-failure"],
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "tls-failure"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "tls-failure"],
    ["ERR_SSL_WRONG_VERSION_NUMBER", "tls-failure"],
    ["EPROTO", "tls-failure"],
    ["ECONNRESET", "network-error"],
    ["ECONNREFUSED", "network-error"],
    ["EHOSTUNREACH", "network-error"],
    ["EPIPE", "network-error"],
    ["ETIMEDOUT", "timeout"],
    ["ESOCKETTIMEDOUT", "timeout"],
    ["ECCC_REFUSED_ADDRESS", "refused-address"],
    ["SOMETHING_ELSE", "network-error"],
  ];
  for (const [code, expected] of MAPPING) {
    it(`maps ${code} to ${expected}`, async () => {
      const target = rig(() => coded(code));
      expect(await run(target, "https://a.example.invalid/")).toEqual({
        ok: false,
        code: expected,
      });
    });
  }

  it("maps a DNS miss from the resolver to dns-failure", async () => {
    const target = rig(() => OK_PAGE);
    expect(await run(target, "https://unknown.invalid/")).toEqual({
      ok: false,
      code: "dns-failure",
    });
  });

  it("maps an error with no code to network-error", async () => {
    const target = rig(() => ({ error: new Error("boom SECRET-TOKEN") }));
    expect(await run(target, "https://a.example.invalid/")).toEqual({
      ok: false,
      code: "network-error",
    });
  });

  it("maps a connection reset in the middle of the body to network-error and releases the socket", async () => {
    const target = rig(() => ({
      headers: HTML,
      body: ["<p>a</p>", "<p>b</p>"],
      failAfterChunks: 1,
    }));
    expect(await run(target, "https://a.example.invalid/")).toEqual({
      ok: false,
      code: "network-error",
    });
    expect(target.fake.calls[0]?.responseDestroyed).toBe(true);
  });

  it("never throws, even when the transport throws", async () => {
    const throwing = createSafeFetcher({
      request: () => {
        throw new Error("synchronous failure SECRET-TOKEN");
      },
      env: {},
      execArgv: [],
    });
    expect(await throwing.fetchSource({ url: "https://a.example.invalid/", kind: "page" })).toEqual(
      {
        ok: false,
        code: "network-error",
      },
    );
  });

  it("returns and logs nothing from the URL query, a header or the body", async () => {
    const target = rig(() => ({
      status: 500,
      headers: { "x-leak": "SECRET-TOKEN", "set-cookie": ["SECRET-TOKEN"] },
      body: "SECRET-TOKEN",
    }));
    const result = await run(target, "https://a.example.invalid/feed?token=SECRET-TOKEN");
    const everything = JSON.stringify({ result, logs: target.logs });
    expect(everything).not.toContain("SECRET-TOKEN");
    expect(everything).not.toContain("token=");
    for (const entry of target.logs) {
      expect(Object.keys(entry).sort()).toEqual(["code", "event"]);
      expect(CLOSED_CODES).toContain(entry.code);
    }
  });

  it("sends no cookie, authorization or referer on any hop", async () => {
    const target = rig(
      routed({
        "a.example.invalid/": redirect("https://b.example.invalid/"),
        "b.example.invalid/": OK_PAGE,
      }),
    );
    await run(target, "https://a.example.invalid/");
    for (const call of target.fake.calls) {
      const names = Object.keys(call.options.headers).map((name) => name.toLowerCase());
      for (const forbidden of ["cookie", "authorization", "referer", "proxy-authorization"]) {
        expect(names).not.toContain(forbidden);
      }
    }
  });
});

describe("Task 3 Test 5 (proxy): an environment proxy makes every source a network error", () => {
  for (const [label, env, execArgv] of [
    ["NODE_USE_ENV_PROXY=1", { NODE_USE_ENV_PROXY: "1" }, []],
    ["--use-env-proxy", {}, ["--use-env-proxy"]],
    ["NODE_OPTIONS", { NODE_OPTIONS: "--use-env-proxy" }, []],
  ] as const) {
    it(`refuses every call without calling request (${label}) and logs one code-only line`, async () => {
      const target = rig(() => OK_PAGE, {}, env, execArgv);
      const first = await run(target, "https://a.example.invalid/");
      const second = await run(target, "https://b.example.invalid/");
      expect(first).toEqual({ ok: false, code: "network-error" });
      expect(second).toEqual({ ok: false, code: "network-error" });
      expect(target.fake.calls).toHaveLength(0);
      const proxyLines = target.logs.filter(
        (entry) => entry.event === "research-fetch-proxy-refused",
      );
      expect(proxyLines).toEqual([
        { event: "research-fetch-proxy-refused", code: "network-error" },
      ]);
    });
  }

  it("works normally when only HTTPS_PROXY is set (the explicit agent is not rerouted)", async () => {
    const target = rig(() => OK_PAGE, {}, { HTTPS_PROXY: "http://proxy.invalid:3128" });
    expect((await run(target, "https://a.example.invalid/")).ok).toBe(true);
  });
});

describe("Task 3 Test 6 (decoding): bytes are read the way a browser reads them, or refused", () => {
  const PAGE_URL_LOCAL = "https://a.example.invalid/";

  it("decodes a UTF-16LE page with a BOM as UTF-16: the hidden block is real markup, never literal text", async () => {
    const markup = "<p>ok</p><div hidden>SECRET</div>";
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(markup, "utf16le")]);
    const target = rig(() => ({ headers: headersOf("text/html"), body: bytes }));
    const result = await run(target, PAGE_URL_LOCAL);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe(markup);
      expect(result.text).not.toContain("\u0000");
    }
  });

  it("refuses a page with no byte-order mark, no charset and no meta as parse-failure", async () => {
    const target = rig(() => ({ headers: headersOf("text/html"), body: "<p>x</p>" }));
    expect(await run(target, PAGE_URL_LOCAL)).toEqual({ ok: false, code: "parse-failure" });
  });

  it("refuses UTF-16 bytes served as UTF-8 without a BOM", async () => {
    const bytes = Buffer.from("<p>ok</p><div hidden>SECRET</div>", "utf16le");
    const target = rig(() => ({ headers: headersOf("text/html; charset=utf-8"), body: bytes }));
    expect(await run(target, PAGE_URL_LOCAL)).toEqual({ ok: false, code: "parse-failure" });
  });

  it("returns the decoded text and charset with the bytes for a page and a feed", async () => {
    const page = rig(() => ({ headers: headersOf("text/html; charset=utf-8"), body: "<p>ok</p>" }));
    const pageResult = await run(page, PAGE_URL_LOCAL);
    expect(pageResult.ok && pageResult.text).toBe("<p>ok</p>");
    expect(pageResult.ok && pageResult.charset).toBe("utf-8");
    const feed = rig(() => ({
      headers: headersOf("application/octet-stream"),
      body: '<?xml version="1.0" encoding="UTF-8"?><feed></feed>',
    }));
    const feedResult = await run(feed, PAGE_URL_LOCAL, "feed");
    expect(feedResult.ok && feedResult.charset).toBe("utf-8");
  });
});

describe("Task 3 Test 7 (concurrency): a run fetches at most three sources at once", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts three requests, then one more as each finishes, and returns results in input order", async () => {
    vi.useFakeTimers();
    const target = rig(() => ({ headers: HTML, body: "<p>ok</p>", responseDelayMs: 100 }));
    const inputs = Array.from({ length: 7 }, (_, index) => ({
      url: `https://s${index}.example.invalid/`,
      kind: "page" as const,
    }));
    const pending = target.fetcher.fetchSources(inputs);
    await vi.advanceTimersByTimeAsync(1);
    expect(target.fake.calls).toHaveLength(FETCH_CONCURRENCY);
    await vi.advanceTimersByTimeAsync(100);
    expect(target.fake.calls).toHaveLength(6);
    await vi.advanceTimersByTimeAsync(100);
    const results = await pending;
    expect(target.fake.calls).toHaveLength(7);
    expect(results).toHaveLength(7);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.map((result) => result.ok && result.finalUrl)).toEqual(
      inputs.map((input) => input.url),
    );
  });

  it("shares one run total across the sources", async () => {
    const target = rig(() => ({ headers: HTML, body: "a".repeat(40 * 1024) }));
    const inputs = Array.from({ length: 4 }, (_, index) => ({
      url: `https://s${index}.example.invalid/`,
      kind: "page" as const,
    }));
    const budget = createRunBudget(100 * 1024);
    const results = await target.fetcher.fetchSources(inputs, budget);
    expect(results.filter((result) => result.ok)).toHaveLength(2);
    expect(results.filter((result) => !result.ok && result.code === "oversize")).toHaveLength(2);
  });

  it("returns one result per input and never rejects, whatever fails", async () => {
    const target = rig(
      routed({
        "ok.example.invalid/": OK_PAGE,
        "bad.example.invalid/": { status: 500 },
      }),
    );
    const results = await target.fetcher.fetchSources([
      { url: "https://ok.example.invalid/", kind: "page" },
      { url: "https://bad.example.invalid/", kind: "page" },
      { url: "https://127.0.0.1/", kind: "page" },
    ]);
    expect(results.map((result) => (result.ok ? "ok" : result.code))).toEqual([
      "ok",
      "http-status",
      "refused-address",
    ]);
  });
});
