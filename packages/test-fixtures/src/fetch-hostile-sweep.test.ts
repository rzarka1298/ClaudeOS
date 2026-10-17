import type dns from "node:dns";
import { readFileSync } from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import {
  createSafeFetcher,
  createSafeLookup,
  isBlockedAddress,
  REFUSED_ADDRESS_CODE,
  type RequestFn,
  type ResponseStream,
  validateFetchUrl,
} from "@ccc/service/research-fetch";
import { describe, expect, it } from "vitest";
import {
  HOSTILE_FETCH_ADDRESSES,
  HOSTILE_FETCH_HOSTS,
  HOSTILE_FETCH_LOCATIONS,
  HOSTILE_FETCH_RESPONSES,
  HOSTILE_FETCH_URLS,
  PUBLIC_FETCH_ADDRESSES,
} from "./hostile-fetch-targets.js";

/**
 * Plan 07-09 sweep: every hostile target runs through the real fetcher modules with an injected
 * fake transport and resolver. Nothing here opens a socket or resolves a name.
 */

const PUBLIC = "93.184.216.34";

interface Rig {
  readonly request: RequestFn;
  readonly requested: string[];
}

/** A transport that, like Node, calls `lookup` for names (not literals) before answering. */
function fakeTransport(
  respond: (url: string) => {
    status?: number;
    headers?: Record<string, string>;
    body?: Uint8Array;
  },
): Rig {
  const requested: string[] = [];
  const request: RequestFn = (options, onResponse) => {
    requested.push(`${options.hostname}${options.path}`);
    const failures: ((error: Error) => void)[] = [];
    const answer = (): void => {
      const scripted = respond(`${options.hostname}${options.path}`);
      const body = scripted.body ?? new Uint8Array();
      const response: ResponseStream = {
        statusCode: scripted.status ?? 200,
        headers: scripted.headers ?? {},
        socket: { remoteAddress: PUBLIC },
        destroy: () => undefined,
        async *[Symbol.asyncIterator]() {
          if (body.byteLength > 0) yield body;
        },
      };
      onResponse(response);
    };
    const handle = {
      on(event: "error" | "timeout", listener: ((error: Error) => void) | (() => void)) {
        if (event === "error") failures.push(listener as (error: Error) => void);
        return handle;
      },
      destroy: () => undefined,
      end() {
        queueMicrotask(() => {
          const bare = options.hostname.replace(/^\[|\]$/g, "");
          if (net.isIP(bare) !== 0) {
            answer();
            return;
          }
          options.lookup(options.hostname, { all: true, hints: 1024 }, (error) => {
            if (error) {
              for (const listener of failures) listener(error);
              return;
            }
            answer();
          });
        });
      },
    };
    return handle;
  };
  return { request, requested };
}

function resolverFor(table: Readonly<Record<string, readonly string[]>>) {
  return (
    hostname: string,
    options: dns.LookupOptions,
    callback: (
      error: NodeJS.ErrnoException | null,
      address: string | dns.LookupAddress[],
      family?: number,
    ) => void,
  ): void => {
    const answers = table[hostname.toLowerCase()] ?? [PUBLIC];
    const entries = answers.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    if (options.all === true) callback(null, entries);
    else callback(null, entries[0]?.address ?? "", entries[0]?.family ?? 4);
  };
}

function fetcherOver(rig: Rig, table: Readonly<Record<string, readonly string[]>> = {}) {
  return createSafeFetcher({
    request: rig.request,
    lookup: createSafeLookup(resolverFor(table)),
    env: {},
    execArgv: [],
    log: () => undefined,
  });
}

describe("hostile source addresses never reach the transport", () => {
  for (const entry of HOSTILE_FETCH_URLS) {
    it(`${entry.name}: validateFetchUrl refuses it as ${entry.code}`, () => {
      expect(validateFetchUrl(entry.url, "source")).toEqual({ ok: false, code: entry.code });
      expect(validateFetchUrl(entry.url, "redirect")).toEqual({
        ok: false,
        code: "unsafe-redirect",
      });
    });

    it(`${entry.name}: the fetcher answers ${entry.code} without a request`, async () => {
      const rig = fakeTransport(() => ({ status: 200 }));
      const result = await fetcherOver(rig).fetchSource({ url: entry.url, kind: "page" });
      expect(result).toEqual({ ok: false, code: entry.code });
      expect(rig.requested).toEqual([]);
    });
  }
});

describe("hostile addresses", () => {
  for (const address of HOSTILE_FETCH_ADDRESSES) {
    it(`blocks ${JSON.stringify(address)}`, () => {
      expect(isBlockedAddress(address)).toBe(true);
    });
  }
  for (const address of PUBLIC_FETCH_ADDRESSES) {
    it(`keeps ${address} allowed`, () => {
      expect(isBlockedAddress(address)).toBe(false);
    });
  }
});

describe("hostile names are allowed only by the address they resolve to", () => {
  const table = Object.fromEntries(HOSTILE_FETCH_HOSTS.map((host) => [host.name, host.answers]));
  for (const host of HOSTILE_FETCH_HOSTS) {
    it(`${host.name}: the lookup refuses the whole answer`, async () => {
      const lookup = createSafeLookup(resolverFor(table));
      const code = await new Promise<string | undefined>((resolve) => {
        lookup(host.name, { all: true, hints: 1024 }, (error) => resolve(error?.code));
      });
      expect(code).toBe(REFUSED_ADDRESS_CODE);
    });

    it(`${host.name}: the fetcher answers refused-address as a source, and unsafe-redirect as another host's redirect target`, async () => {
      const direct = fakeTransport(() => ({
        status: 200,
        headers: { "content-type": "text/html" },
      }));
      expect(
        await fetcherOver(direct, table).fetchSource({
          url: `https://${host.name}/`,
          kind: "page",
        }),
      ).toEqual({ ok: false, code: "refused-address" });

      const hop = fakeTransport((url) =>
        url.startsWith("start.example.invalid")
          ? { status: 302, headers: { location: `https://${host.name}/next` } }
          : { status: 200, headers: { "content-type": "text/html" } },
      );
      // 07-FIX8: a redirect off the source's host is refused before any lookup of the new name.
      expect(
        await fetcherOver(hop, table).fetchSource({
          url: "https://start.example.invalid/",
          kind: "page",
        }),
      ).toEqual({ ok: false, code: "unsafe-redirect" });
      expect(hop.requested).toEqual(["start.example.invalid/"]);
    });
  }
});

describe("hostile redirect targets end in unsafe-redirect after one request", () => {
  for (const entry of HOSTILE_FETCH_LOCATIONS) {
    it(`${entry.name}`, async () => {
      const rig = fakeTransport(() => ({
        status: 301,
        headers: entry.location === undefined ? {} : { location: entry.location },
      }));
      const result = await fetcherOver(rig).fetchSource({
        url: "https://start.example.invalid/",
        kind: "page",
      });
      expect(result).toEqual({ ok: false, code: "unsafe-redirect" });
      expect(rig.requested).toEqual(["start.example.invalid/"]);
    });
  }
});

describe("hostile responses are decoded as a browser would, or refused", () => {
  for (const entry of HOSTILE_FETCH_RESPONSES) {
    it(`${entry.name}`, async () => {
      const rig = fakeTransport(() => ({
        status: 200,
        headers: { "content-type": entry.contentType },
        body: entry.body,
      }));
      const result = await fetcherOver(rig).fetchSource({
        url: "https://start.example.invalid/",
        kind: entry.kind,
      });
      if ("refused" in entry.expect) {
        expect(result.ok).toBe(false);
        expect(result.ok ? undefined : result.code).toBeOneOf(["parse-failure", "content-type"]);
      } else {
        expect(result.ok && result.text).toBe(entry.expect.text);
        // A hidden block is real markup after decoding, never literal text between NULs.
        expect(result.ok && result.text.includes(String.fromCharCode(0))).toBe(false);
      }
    });
  }
});

describe("the corpus file", () => {
  it("is pure ASCII (every special character is an escape sequence)", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./hostile-fetch-targets.ts", import.meta.url)),
    );
    expect([...source].every((byte) => byte > 0 && byte < 128)).toBe(true);
  });
});
