import https from "node:https";
import type { SummariserModel } from "@ccc/domain";
import { childLogger } from "../logging.js";
import type { TextTransport } from "../untrusted/index.js";
import {
  buildAnthropicRequest,
  DEFAULT_MAX_TOKENS,
  parseAnthropicResponse,
} from "./anthropic-request.js";
import { envProxyRequested, type ResponseStream, safeLookup } from "./fetch/index.js";
import { SummariserError, type SummariserErrorCode } from "./summariser-error.js";
import { tlsTrustOverrideRequested } from "./tls-env.js";

/**
 * The live summariser transport (D-04, OD-1, ADR-0014, ADR-0017): a hand-owned POST to the
 * Anthropic Messages API over plain `node:https`, behind the `TextTransport` port. The request is
 * built by `buildAnthropicRequest` (a strict five-key body that cannot declare a tool) and the
 * reply is read by `parseAnthropicResponse` (text only). The API key is read through an injected
 * closure on every call and is never kept in module state.
 */

export const ANTHROPIC_HOST = "api.anthropic.com";
export const ANTHROPIC_PATH = "/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
export const REQUEST_TIMEOUT_MS = 120_000;
export const MAX_HEADER_BYTES = 16 * 1024;
/** The most response bytes read; anything longer ends the call (T-07-28). */
export const RESPONSE_BYTE_CAP = 2 * 1024 * 1024;
/** What a key may look like: the keychain package's own safe alphabet, so a header value is inert. */
const KEY_PATTERN = /^[A-Za-z0-9+/=_-]{1,512}$/;

/**
 * True when a stored key can be sent as a header value: a non-empty string without surrounding
 * whitespace, of header-safe characters, within the length cap. The one definition, used by the
 * transport at call time and by the summariser choice before a run fetches anything, so the two
 * can never disagree about whether a run is able to summarise (wave 5 review, opus m1).
 */
export function isUsableApiKey(key: unknown): key is string {
  return typeof key === "string" && key.trim() !== "" && KEY_PATTERN.test(key);
}

/**
 * True when the environment forbids the key-carrying request: an outbound proxy was asked for, or
 * the TLS trust was widened. The one definition, shared the same way as {@link isUsableApiKey}.
 */
export function liveCallRefusedByEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  execArgv: readonly string[],
): boolean {
  return envProxyRequested(env, execArgv) || tlsTrustOverrideRequested(env);
}

export interface AnthropicRequestOptions {
  readonly protocol: "https:";
  readonly hostname: typeof ANTHROPIC_HOST;
  readonly port: 443;
  readonly path: typeof ANTHROPIC_PATH;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly lookup: typeof safeLookup;
  /** Certificate verification is pinned on, whatever the environment says. */
  readonly rejectUnauthorized: true;
  readonly agent: https.Agent;
  readonly signal: AbortSignal;
  readonly timeout: number;
  readonly maxHeaderSize: number;
}

export type AnthropicResponseStream = ResponseStream;

/** What the transport uses of a request; `http.ClientRequest` satisfies it. */
export interface AnthropicRequestHandle {
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "timeout", listener: () => void): unknown;
  end(body: string): unknown;
  destroy(error?: Error): unknown;
}

export type AnthropicRequestFn = (
  options: AnthropicRequestOptions,
  onResponse: (response: AnthropicResponseStream) => void,
) => AnthropicRequestHandle;

const httpsRequest: AnthropicRequestFn = (options, onResponse) =>
  https.request(options, onResponse);

/** A log entry is a fixed event name and a closed code, never a key, header or remote string. */
export interface AnthropicLogEntry {
  readonly event: string;
  readonly code: string;
}

export interface AnthropicTransportDeps {
  /** Called on every call, at request time; resolves null when no key is stored. */
  readonly readApiKey: () => Promise<string | null>;
  readonly model: SummariserModel;
  /** Default `https.request`. Tests inject a fake; no test opens a socket. */
  readonly request?: AnthropicRequestFn;
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
  readonly agentFactory?: () => https.Agent;
  /** Default: the service logger, as a fixed `{ event, code }` entry. */
  readonly log?: (entry: AnthropicLogEntry) => void;
  /** Default `process.env` and `process.execArgv`; tests inject them. */
  readonly env?: NodeJS.ProcessEnv;
  readonly execArgv?: readonly string[];
}

function defaultLog(entry: AnthropicLogEntry): void {
  childLogger({ component: "research-summariser" }).warn(entry);
}

/** Closes over one call: its request, its response and its timer, so every path can release them. */
interface CallState {
  handle: AnthropicRequestHandle | undefined;
  response: AnthropicResponseStream | undefined;
}

function declaredLength(response: AnthropicResponseStream): number | undefined {
  const raw = response.headers["content-length"];
  if (typeof raw !== "string") return undefined;
  return /^\d{1,15}$/.test(raw) ? Number(raw) : Number.POSITIVE_INFINITY;
}

async function readText(response: AnthropicResponseStream): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response) {
    total += chunk.byteLength;
    if (total > RESPONSE_BYTE_CAP) {
      response.destroy();
      throw new SummariserError("summariser-failed");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The exchange itself: one request, one response. Throws only SummariserError. An HTTP 401
 * is the key being refused (unconfigured); any other non-200 status, 403 included (a permission or
 * region block, not a bad key), is a failure. Error bodies are
 * never read, so nothing of them can reach an error or a log.
 */
async function exchange(
  state: CallState,
  request: AnthropicRequestFn,
  options: AnthropicRequestOptions,
  body: string,
): Promise<string> {
  const response = await new Promise<AnthropicResponseStream>((resolve, reject) => {
    const handle = request(options, resolve);
    state.handle = handle;
    handle.on("error", () => reject(new SummariserError("summariser-failed")));
    handle.on("timeout", () => reject(new SummariserError("summariser-failed")));
    handle.end(body);
  });
  state.response = response;
  const status = response.statusCode;
  if (status === 401) throw new SummariserError("summariser-unconfigured");
  if (status !== 200) throw new SummariserError("summariser-failed");
  const encoding = response.headers["content-encoding"];
  if (encoding !== undefined && String(encoding).trim().toLowerCase() !== "identity") {
    throw new SummariserError("summariser-failed");
  }
  const length = declaredLength(response);
  if (length !== undefined && length > RESPONSE_BYTE_CAP) {
    throw new SummariserError("summariser-failed");
  }
  const text = await readText(response);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SummariserError("summariser-failed");
  }
  return parseAnthropicResponse(parsed);
}

export function createAnthropicTransport(deps: AnthropicTransportDeps): TextTransport {
  const request = deps.request ?? httpsRequest;
  const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const log = deps.log ?? defaultLog;

  const fail = (code: SummariserErrorCode): SummariserError => {
    try {
      log({ event: "research-summariser-failed", code });
    } catch {
      // A broken log sink never changes the outcome of the call.
    }
    return new SummariserError(code);
  };

  return {
    async complete({ instructions, input }) {
      let body: string;
      try {
        body = JSON.stringify(
          buildAnthropicRequest({
            model: deps.model,
            instructions,
            input,
            maxTokens: deps.maxTokens ?? DEFAULT_MAX_TOKENS,
          }),
        );
      } catch {
        throw fail("summariser-failed");
      }
      // The environment must not widen who may read the key: refused before the key is read.
      if (
        liveCallRefusedByEnvironment(deps.env ?? process.env, deps.execArgv ?? process.execArgv)
      ) {
        throw fail("summariser-failed");
      }
      let key: string | null;
      try {
        key = await deps.readApiKey();
      } catch {
        throw fail("summariser-failed");
      }
      if (!isUsableApiKey(key)) {
        throw fail("summariser-unconfigured");
      }

      const controller = new AbortController();
      const agent = deps.agentFactory?.() ?? new https.Agent({ keepAlive: false });
      const state: CallState = { handle: undefined, response: undefined };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new SummariserError("summariser-failed")), timeoutMs);
      });
      const work = exchange(
        state,
        request,
        {
          protocol: "https:",
          hostname: ANTHROPIC_HOST,
          port: 443,
          path: ANTHROPIC_PATH,
          method: "POST",
          headers: {
            accept: "application/json",
            "accept-encoding": "identity",
            "anthropic-version": ANTHROPIC_VERSION,
            "content-length": String(Buffer.byteLength(body, "utf8")),
            "content-type": "application/json",
            "x-api-key": key,
          },
          lookup: safeLookup,
          rejectUnauthorized: true,
          agent,
          signal: controller.signal,
          timeout: timeoutMs,
          maxHeaderSize: MAX_HEADER_BYTES,
        },
        body,
      );
      // Once the deadline wins, `work` may still settle later; its outcome is dropped.
      work.catch(() => undefined);
      try {
        return await Promise.race([work, deadline]);
      } catch (error) {
        throw fail(error instanceof SummariserError ? error.code : "summariser-failed");
      } finally {
        clearTimeout(timer);
        deadline.catch(() => undefined);
        controller.abort();
        state.response?.destroy();
        state.handle?.destroy();
        agent.destroy();
      }
    },
  };
}
