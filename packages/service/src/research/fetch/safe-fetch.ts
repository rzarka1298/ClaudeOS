import type { IncomingHttpHeaders } from "node:http";
import https from "node:https";
import type net from "node:net";
import type { SourceFailureCode } from "@ccc/domain";
import { childLogger } from "../../logging.js";
import { isBlockedAddress, REFUSED_ADDRESS_CODE, safeLookup } from "./address-policy.js";
import { decodeBody } from "./decode-body.js";
import {
  ACCEPT_BY_KIND,
  BYTE_CAP_BY_KIND,
  CONTENT_TYPE_ALLOWLIST,
  FETCH_CONCURRENCY,
  IDLE_TIMEOUT_MS,
  MAX_HEADER_BYTES,
  MAX_REDIRECTS,
  OCTET_STREAM,
  REDIRECT_STATUSES,
  RUN_BYTE_CAP,
  type SourceKind,
  TOTAL_TIMEOUT_MS,
  USER_AGENT,
} from "./limits.js";
import { envProxyRequested } from "./proxy-env.js";
import { resolveRedirectTarget, validateFetchUrl } from "./url-policy.js";

/**
 * The research fetcher: an HTTPS-only GET with the address validator on the connection, manual
 * re-validated redirects, bounded time and bytes, and a closed failure code (D-09, D-10).
 *
 * - Every request carries `lookup` (the validator), so the address that was checked is the address
 *   Node connects to: there is no second resolution between check and connect. IP literals never
 *   call `lookup`, so the URL policy checks them first, on the source and on every redirect target.
 *   The peer address of every response is checked as well, as a last line.
 * - One dedicated keep-alive-free agent, a fixed User-Agent, no cookies, no credentials, no proxy:
 *   when the environment asks Node for an environment proxy every source is refused.
 * - Bytes are counted as they stream and the response is destroyed the moment a cap is crossed;
 *   nothing is buffered and then checked. Only identity encoding is accepted, so nothing is ever
 *   decompressed.
 * - Every failure is one member of SOURCE_FAILURE_CODES. No remote string, header or body is ever
 *   returned in a failure, logged, or thrown.
 * - TLS certificate verification is pinned on in every request (`rejectUnauthorized: true`), so
 *   an environment setting cannot turn it off.
 */

export interface SafeRequestOptions {
  readonly protocol: "https:";
  readonly hostname: string;
  readonly port: 443;
  readonly path: string;
  readonly method: "GET";
  readonly headers: Readonly<Record<string, string>>;
  readonly lookup: net.LookupFunction;
  /** Certificate verification is pinned on, whatever the environment says. */
  readonly rejectUnauthorized: true;
  readonly agent: https.Agent;
  readonly signal: AbortSignal;
  /** The socket idle timeout; Node emits `timeout` on the request when it elapses. */
  readonly timeout: number;
  readonly maxHeaderSize: number;
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

/** A log entry is a fixed event name and a closed code, never a remote string. */
export interface FetchLogEntry {
  readonly event: string;
  readonly code: string;
}

export interface SafeFetcherDeps {
  /** Default `https.request`. Tests inject a fake; no test opens a socket. */
  readonly request?: RequestFn;
  /** Default `safeLookup`. */
  readonly lookup?: net.LookupFunction;
  /** Default `new https.Agent({ keepAlive: false })`. */
  readonly agentFactory?: () => https.Agent;
  readonly env?: NodeJS.ProcessEnv;
  readonly execArgv?: readonly string[];
  /** Default: the service logger. */
  readonly log?: (entry: FetchLogEntry) => void;
}

/** The bytes all sources of one run may hold together (RUN_BYTE_CAP). */
export interface RunBudget {
  remaining(): number;
  /** Take bytes as they arrive; false (and the budget emptied) when they do not fit. */
  take(bytes: number): boolean;
}

export function createRunBudget(total: number = RUN_BYTE_CAP): RunBudget {
  let left = total;
  return {
    remaining: () => left,
    take(bytes) {
      if (bytes <= left) {
        left -= bytes;
        return true;
      }
      left = 0;
      return false;
    },
  };
}

export interface FetchSourceInput {
  readonly url: string;
  readonly kind: SourceKind;
  readonly budget?: RunBudget;
}

export type FetchSourceResult =
  | {
      readonly ok: true;
      readonly bytes: Uint8Array;
      /** The bytes decoded the way a browser would, by BOM, then Content-Type, then meta. */
      readonly text: string;
      readonly charset: string;
      /** The media type without parameters. */
      readonly contentType: string;
      readonly finalUrl: string;
    }
  | { readonly ok: false; readonly code: SourceFailureCode };

export interface SafeFetcher {
  fetchSource(input: FetchSourceInput): Promise<FetchSourceResult>;
  /**
   * Fetch a list with at most FETCH_CONCURRENCY requests in flight, one shared run byte budget
   * (a fresh RUN_BYTE_CAP unless one is passed), one result per input in input order. Never rejects.
   */
  fetchSources(
    inputs: readonly FetchSourceInput[],
    budget?: RunBudget,
  ): Promise<FetchSourceResult[]>;
}

function fail(code: SourceFailureCode): FetchSourceResult {
  return { ok: false, code };
}

function headerText(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}

function mediaType(contentType: string | undefined): string | undefined {
  const type = contentType?.split(";")[0]?.trim().toLowerCase();
  return type === undefined || type === "" ? undefined : type;
}

function startsLikeXml(bytes: Uint8Array): boolean {
  let start = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  while (start < bytes.length && [0x20, 0x09, 0x0a, 0x0d].includes(bytes[start] ?? 0)) start += 1;
  const head = Buffer.from(bytes.subarray(start, start + 12))
    .toString("latin1")
    .toLowerCase();
  return ["<?xml", "<feed", "<rss", "<rdf:rdf"].some((prefix) => head.startsWith(prefix));
}

const TLS_CODES: ReadonlySet<string> = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "HOSTNAME_MISMATCH",
  "EPROTO",
]);
const DNS_CODES: ReadonlySet<string> = new Set([
  "ENOTFOUND",
  "ENODATA",
  "EAI_AGAIN",
  "EAI_FAIL",
  "EAI_NODATA",
  "EAI_NONAME",
  "ESERVFAIL",
]);
const TIMEOUT_CODES: ReadonlySet<string> = new Set(["ETIMEDOUT", "ESOCKETTIMEDOUT"]);

/** Map an error to a closed code by its machine code alone; the message is never read. */
function codeForError(error: unknown): SourceFailureCode {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  if (code === REFUSED_ADDRESS_CODE) return "refused-address";
  if (DNS_CODES.has(code)) return "dns-failure";
  if (TIMEOUT_CODES.has(code)) return "timeout";
  if (
    TLS_CODES.has(code) ||
    code.startsWith("ERR_TLS_") ||
    code.startsWith("ERR_SSL_") ||
    code.startsWith("CERT_")
  ) {
    return "tls-failure";
  }
  return "network-error";
}

type HopOutcome =
  | { readonly type: "fail"; readonly code: SourceFailureCode }
  | { readonly type: "redirect"; readonly location: string | undefined }
  | {
      readonly type: "final";
      readonly headers: IncomingHttpHeaders;
      readonly bytes: Uint8Array;
    };

interface HopContext {
  readonly request: RequestFn;
  readonly lookup: net.LookupFunction;
  readonly agent: https.Agent;
  readonly signal: AbortSignal;
  readonly kind: SourceKind;
  readonly budget: RunBudget | undefined;
}

function declaredLength(headers: IncomingHttpHeaders): number | undefined {
  const text = headerText(headers, "content-length")?.trim();
  if (text === undefined || !/^\d{1,15}$/.test(text)) return undefined;
  return Number(text);
}

/** One request, one response, bounded in time and bytes. Never rejects. */
function fetchHop(url: URL, context: HopContext): Promise<HopOutcome> {
  return new Promise<HopOutcome>((resolve) => {
    let settled = false;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let handle: RequestHandle | undefined;
    let response: ResponseStream | undefined;

    const onAbort = (): void => finish({ type: "fail", code: "timeout" });

    function disarm(): void {
      if (idle !== undefined) clearTimeout(idle);
      idle = undefined;
    }
    function arm(): void {
      disarm();
      idle = setTimeout(() => finish({ type: "fail", code: "timeout" }), IDLE_TIMEOUT_MS);
    }
    function finish(outcome: HopOutcome): void {
      if (settled) return;
      settled = true;
      disarm();
      context.signal.removeEventListener("abort", onAbort);
      if (outcome.type === "fail") {
        response?.destroy();
        handle?.destroy();
      }
      resolve(outcome);
    }

    const cap = BYTE_CAP_BY_KIND[context.kind];

    async function consume(res: ResponseStream): Promise<void> {
      // Fail closed: a response that cannot name its peer cannot be shown to be public.
      const peer = res.socket?.remoteAddress;
      if (peer === undefined || isBlockedAddress(peer)) {
        finish({ type: "fail", code: "refused-address" });
        return;
      }
      const status = res.statusCode ?? 0;
      if (REDIRECT_STATUSES.has(status)) {
        const location = headerText(res.headers, "location");
        res.destroy();
        finish({ type: "redirect", location });
        return;
      }
      if (status !== 200) {
        finish({ type: "fail", code: "http-status" });
        return;
      }
      const encoding = headerText(res.headers, "content-encoding")?.trim().toLowerCase();
      if (encoding !== undefined && encoding !== "" && encoding !== "identity") {
        finish({ type: "fail", code: "content-type" });
        return;
      }
      const type = mediaType(headerText(res.headers, "content-type"));
      const octet = type === OCTET_STREAM && context.kind === "feed";
      if (type === undefined || (!CONTENT_TYPE_ALLOWLIST.has(type) && !octet)) {
        finish({ type: "fail", code: "content-type" });
        return;
      }
      const declared = declaredLength(res.headers);
      const allowed = Math.min(cap, context.budget?.remaining() ?? cap);
      if (declared !== undefined && declared > allowed) {
        finish({ type: "fail", code: "oversize" });
        return;
      }

      const chunks: Uint8Array[] = [];
      let total = 0;
      arm();
      try {
        for await (const chunk of res) {
          if (settled) return;
          total += chunk.byteLength;
          if (total > cap || context.budget?.take(chunk.byteLength) === false) {
            finish({ type: "fail", code: "oversize" });
            return;
          }
          chunks.push(chunk);
          arm();
        }
      } catch (error) {
        finish({ type: "fail", code: codeForError(error) });
        return;
      }
      if (settled) return;
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      finish({ type: "final", headers: res.headers, bytes });
    }

    try {
      // Registered before the request so a total-deadline abort is read as a timeout, not as the
      // transport error the abort then raises.
      context.signal.addEventListener("abort", onAbort);
      handle = context.request(
        {
          protocol: "https:",
          hostname: url.hostname.replace(/^\[|\]$/g, ""),
          port: 443,
          path: `${url.pathname}${url.search}`,
          method: "GET",
          headers: {
            accept: ACCEPT_BY_KIND[context.kind],
            "accept-encoding": "identity",
            "user-agent": USER_AGENT,
          },
          lookup: context.lookup,
          rejectUnauthorized: true,
          agent: context.agent,
          signal: context.signal,
          timeout: IDLE_TIMEOUT_MS,
          maxHeaderSize: MAX_HEADER_BYTES,
        },
        (res) => {
          response = res;
          arm();
          void consume(res).catch(() => finish({ type: "fail", code: "network-error" }));
        },
      );
      handle.on("error", (error) => finish({ type: "fail", code: codeForError(error) }));
      handle.on("timeout", () => finish({ type: "fail", code: "timeout" }));
      arm();
      handle.end();
    } catch {
      finish({ type: "fail", code: "network-error" });
    }
  });
}

function defaultLog(entry: FetchLogEntry): void {
  childLogger({ component: "research-fetch" }).warn(entry);
}

export function createSafeFetcher(deps: SafeFetcherDeps = {}): SafeFetcher {
  const log = deps.log ?? defaultLog;
  const env = deps.env ?? process.env;
  const execArgv = deps.execArgv ?? process.execArgv;

  // An environment proxy would receive the TCP connection, so the connect-time check would validate
  // the proxy and not the target. Refuse every source instead of trusting the explicit agent.
  if (envProxyRequested(env, execArgv)) {
    log({ event: "research-fetch-proxy-refused", code: "network-error" });
    const refuse = async (): Promise<FetchSourceResult> => fail("network-error");
    return {
      fetchSource: refuse,
      fetchSources: async (inputs) => Promise.all(inputs.map(refuse)),
    };
  }

  const request = deps.request ?? httpsRequest;
  const lookup = deps.lookup ?? safeLookup;
  const agent = (deps.agentFactory ?? (() => new https.Agent({ keepAlive: false })))();

  async function fetchInner(input: FetchSourceInput): Promise<FetchSourceResult> {
    const first = validateFetchUrl(input.url, "source");
    if (!first.ok) return fail(first.code);

    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS);
    const context: HopContext = {
      request,
      lookup,
      agent,
      signal: controller.signal,
      kind: input.kind,
      budget: input.budget,
    };
    try {
      let current = first.url;
      let redirects = 0;
      for (;;) {
        const outcome = await fetchHop(current, context);
        if (outcome.type === "fail") return fail(outcome.code);
        if (outcome.type === "redirect") {
          if (redirects >= MAX_REDIRECTS) return fail("redirect-limit");
          if (outcome.location === undefined) return fail("unsafe-redirect");
          const next = resolveRedirectTarget(outcome.location, current);
          if (!next.ok) return fail(next.code);
          current = next.url;
          redirects += 1;
          continue;
        }
        if (outcome.bytes.byteLength === 0) return fail("empty-content");
        const contentType = headerText(outcome.headers, "content-type");
        const type = mediaType(contentType) ?? "";
        if (type === OCTET_STREAM && !startsLikeXml(outcome.bytes)) return fail("content-type");
        const decoded = decodeBody(outcome.bytes, contentType);
        if (!decoded.ok) return fail("parse-failure");
        return {
          ok: true,
          bytes: outcome.bytes,
          text: decoded.text,
          charset: decoded.charset,
          contentType: type,
          finalUrl: current.href,
        };
      }
    } finally {
      clearTimeout(deadline);
      // Releases anything still open on every path; harmless after a clean finish.
      controller.abort();
    }
  }

  async function fetchSource(input: FetchSourceInput): Promise<FetchSourceResult> {
    let result: FetchSourceResult;
    try {
      result = await fetchInner(input);
    } catch {
      result = fail("network-error");
    }
    if (!result.ok) log({ event: "research-fetch-failed", code: result.code });
    return result;
  }

  async function fetchSources(
    inputs: readonly FetchSourceInput[],
    budget: RunBudget = createRunBudget(),
  ): Promise<FetchSourceResult[]> {
    const results: FetchSourceResult[] = inputs.map(() => fail("network-error"));
    let next = 0;
    async function worker(): Promise<void> {
      for (;;) {
        const index = next;
        next += 1;
        const input = inputs[index];
        if (input === undefined) return;
        results[index] = await fetchSource(
          input.budget === undefined ? { ...input, budget } : input,
        );
      }
    }
    await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, inputs.length) }, worker));
    return results;
  }

  return { fetchSource, fetchSources };
}
