import https from "node:https";
import type { SummariserModel } from "@ccc/domain";
import type { TextTransport } from "../untrusted/index.js";
import {
  buildAnthropicRequest,
  DEFAULT_MAX_TOKENS,
  parseAnthropicResponse,
} from "./anthropic-request.js";
import { type ResponseStream, safeLookup } from "./fetch/index.js";
import { SummariserError } from "./summariser-error.js";

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

export interface AnthropicRequestOptions {
  readonly protocol: "https:";
  readonly hostname: typeof ANTHROPIC_HOST;
  readonly port: 443;
  readonly path: typeof ANTHROPIC_PATH;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly lookup: typeof safeLookup;
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
  readonly log?: (entry: AnthropicLogEntry) => void;
}

async function collect(response: AnthropicResponseStream): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of response) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

export function createAnthropicTransport(deps: AnthropicTransportDeps): TextTransport {
  const request = deps.request ?? httpsRequest;
  const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;
  return {
    async complete({ instructions, input }) {
      const body = JSON.stringify(
        buildAnthropicRequest({
          model: deps.model,
          instructions,
          input,
          maxTokens: deps.maxTokens ?? DEFAULT_MAX_TOKENS,
        }),
      );
      const key = await deps.readApiKey();
      if (key === null || key.length === 0) throw new SummariserError("summariser-unconfigured");
      const controller = new AbortController();
      const agent = deps.agentFactory?.() ?? new https.Agent({ keepAlive: false });
      const reply = await new Promise<AnthropicResponseStream>((resolve, reject) => {
        const handle = request(
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
            agent,
            signal: controller.signal,
            timeout: timeoutMs,
            maxHeaderSize: MAX_HEADER_BYTES,
          },
          resolve,
        );
        handle.on("error", () => reject(new SummariserError("summariser-failed")));
        handle.end(body);
      });
      const text = await collect(reply);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new SummariserError("summariser-failed");
      }
      return parseAnthropicResponse(parsed);
    },
  };
}
