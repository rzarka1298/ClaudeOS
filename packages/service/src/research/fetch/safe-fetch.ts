import type { IncomingHttpHeaders } from "node:http";
import https from "node:https";
import type net from "node:net";
import type { SourceFailureCode } from "@ccc/domain";
import { safeLookup } from "./address-policy.js";
import {
  ACCEPT_BY_KIND,
  CONTENT_TYPE_ALLOWLIST,
  OCTET_STREAM,
  type SourceKind,
  USER_AGENT,
} from "./limits.js";
import { validateFetchUrl } from "./url-policy.js";

/**
 * The research fetcher: an HTTPS-only GET with the address validator on the connection, bounded
 * bytes and a closed failure code (D-09, D-10). Completed across the three tasks of plan 07-09.
 *
 * Every failure is one member of SOURCE_FAILURE_CODES; no remote string, header or body is ever
 * returned in a failure.
 */

export interface SafeRequestOptions {
  readonly protocol: "https:";
  readonly hostname: string;
  readonly port: 443;
  readonly path: string;
  readonly method: "GET";
  readonly headers: Readonly<Record<string, string>>;
  readonly lookup: net.LookupFunction;
  readonly agent: https.Agent;
  readonly signal: AbortSignal;
  readonly timeout: number;
}

/** What the fetcher reads of a response; `http.IncomingMessage` satisfies it. */
export interface ResponseStream extends AsyncIterable<Uint8Array> {
  readonly statusCode?: number | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly socket?: { readonly remoteAddress?: string | undefined } | undefined;
  destroy(error?: Error): unknown;
}

/** What the fetcher uses of a request; `http.ClientRequest` satisfies it. */
export interface RequestHandle {
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "timeout", listener: () => void): unknown;
  end(): unknown;
  destroy(error?: Error): unknown;
}

export type RequestFn = (
  options: SafeRequestOptions,
  onResponse: (response: ResponseStream) => void,
) => RequestHandle;

const httpsRequest: RequestFn = (options, onResponse) => https.request(options, onResponse);

export interface SafeFetcherDeps {
  /** Default `https.request`. Tests inject a fake; no test opens a socket. */
  readonly request?: RequestFn;
  /** Default `safeLookup`. */
  readonly lookup?: net.LookupFunction;
  /** Default `new https.Agent({ keepAlive: false })`. */
  readonly agentFactory?: () => https.Agent;
  readonly env?: NodeJS.ProcessEnv;
  readonly execArgv?: readonly string[];
}

export interface FetchSourceInput {
  readonly url: string;
  readonly kind: SourceKind;
}

export type FetchSourceResult =
  | {
      readonly ok: true;
      readonly bytes: Uint8Array;
      readonly contentType: string;
      readonly finalUrl: string;
    }
  | { readonly ok: false; readonly code: SourceFailureCode };

export interface SafeFetcher {
  fetchSource(input: FetchSourceInput): Promise<FetchSourceResult>;
}

function fail(code: SourceFailureCode): FetchSourceResult {
  return { ok: false, code };
}

function headerText(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}

function mediaType(contentType: string | undefined): string | undefined {
  if (contentType === undefined) return undefined;
  const type = contentType.split(";")[0]?.trim().toLowerCase();
  return type === undefined || type === "" ? undefined : type;
}

function startsLikeXml(bytes: Uint8Array): boolean {
  let start = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  while (start < bytes.length && [0x20, 0x09, 0x0a, 0x0d].includes(bytes[start] ?? 0)) start += 1;
  const head = new TextDecoder("latin1").decode(bytes.subarray(start, start + 12)).toLowerCase();
  return ["<?xml", "<feed", "<rss", "<rdf:rdf"].some((prefix) => head.startsWith(prefix));
}

export function createSafeFetcher(deps: SafeFetcherDeps = {}): SafeFetcher {
  const request = deps.request ?? httpsRequest;
  const lookup = deps.lookup ?? safeLookup;
  const agent = (deps.agentFactory ?? (() => new https.Agent({ keepAlive: false })))();

  async function fetchSource(input: FetchSourceInput): Promise<FetchSourceResult> {
    const verdict = validateFetchUrl(input.url, "source");
    if (!verdict.ok) return fail(verdict.code);
    const url = verdict.url;
    const controller = new AbortController();

    return new Promise<FetchSourceResult>((resolve) => {
      let settled = false;
      const finish = (result: FetchSourceResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const req = request(
        {
          protocol: "https:",
          hostname: url.hostname.replace(/^\[|\]$/g, ""),
          port: 443,
          path: `${url.pathname}${url.search}`,
          method: "GET",
          headers: {
            accept: ACCEPT_BY_KIND[input.kind],
            "accept-encoding": "identity",
            "user-agent": USER_AGENT,
          },
          lookup,
          agent,
          signal: controller.signal,
          timeout: 0,
        },
        (response) => {
          void handle(response, input.kind, url).then(finish);
        },
      );
      req.on("error", () => finish(fail("network-error")));
      req.end();
    });
  }

  return { fetchSource };
}

async function handle(
  response: ResponseStream,
  kind: SourceKind,
  url: URL,
): Promise<FetchSourceResult> {
  if (response.statusCode !== 200) {
    response.destroy();
    return fail("http-status");
  }
  const encoding = headerText(response.headers, "content-encoding")?.trim().toLowerCase();
  if (encoding !== undefined && encoding !== "" && encoding !== "identity") {
    response.destroy();
    return fail("content-type");
  }
  const type = mediaType(headerText(response.headers, "content-type"));
  const octet = type === OCTET_STREAM && kind === "feed";
  if (type === undefined || (!CONTENT_TYPE_ALLOWLIST.has(type) && !octet)) {
    response.destroy();
    return fail("content-type");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of response) {
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } catch {
    return fail("network-error");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (octet && !startsLikeXml(bytes)) return fail("content-type");
  return { ok: true, bytes, contentType: type, finalUrl: url.href };
}
