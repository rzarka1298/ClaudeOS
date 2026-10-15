import type { IncomingHttpHeaders } from "node:http";
import type {
  AnthropicRequestFn,
  AnthropicRequestHandle,
  AnthropicRequestOptions,
  AnthropicResponseStream,
} from "../anthropic-transport.js";

/**
 * A fake of `https.request` for the summariser transport's tests (D-27: no test touches the
 * network). It records the options and the body of every call and plays one scripted response.
 * Nothing here opens a socket, resolves a name or reads a key store.
 */

export interface AnthropicScriptedResponse {
  readonly status?: number;
  readonly headers?: IncomingHttpHeaders;
  /** One piece or chunks; strings are encoded as UTF-8. */
  readonly body?: Uint8Array | string | readonly (Uint8Array | string)[];
  /** After this many chunks the body never yields again (a stalled connection). */
  readonly stallAfterChunks?: number;
  /** After this many chunks the body fails with a connection reset. */
  readonly failAfterChunks?: number;
  /** Wait this long before the response arrives (global timer, so fake timers apply). */
  readonly responseDelayMs?: number;
}

export type AnthropicScript =
  | AnthropicScriptedResponse
  | { readonly error: Error }
  | { readonly hang: true }
  | { readonly socketTimeout: true };

export interface AnthropicRecordedCall {
  readonly options: AnthropicRequestOptions;
  /** The body written to the request, once `end(body)` was called. */
  body: string | undefined;
  requestDestroyed: boolean;
  responseDestroyed: boolean;
  bytesDelivered: number;
}

export interface FakeAnthropic {
  readonly request: AnthropicRequestFn;
  readonly calls: AnthropicRecordedCall[];
}

function bytesOf(piece: Uint8Array | string): Uint8Array {
  return typeof piece === "string" ? new TextEncoder().encode(piece) : piece;
}

function chunksOf(body: AnthropicScriptedResponse["body"]): Uint8Array[] {
  if (body === undefined) return [];
  if (typeof body === "string" || body instanceof Uint8Array) return [bytesOf(body)];
  return body.map(bytesOf);
}

function buildResponse(
  scripted: AnthropicScriptedResponse,
  call: AnthropicRecordedCall,
): AnthropicResponseStream {
  let destroyed = false;
  let wake: (() => void) | undefined;
  const destroySignal = new Promise<void>((resolve) => {
    wake = resolve;
  });
  async function* iterate(): AsyncGenerator<Uint8Array> {
    let sent = 0;
    for (const chunk of chunksOf(scripted.body)) {
      if (scripted.stallAfterChunks !== undefined && sent >= scripted.stallAfterChunks) {
        await destroySignal;
        return;
      }
      if (scripted.failAfterChunks !== undefined && sent >= scripted.failAfterChunks) {
        throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
      }
      if (destroyed) return;
      sent += 1;
      call.bytesDelivered += chunk.byteLength;
      yield chunk;
    }
    if (scripted.stallAfterChunks !== undefined && sent >= scripted.stallAfterChunks) {
      await destroySignal;
    }
  }
  return {
    statusCode: scripted.status ?? 200,
    headers: scripted.headers ?? { "content-type": "application/json" },
    destroy() {
      destroyed = true;
      call.responseDestroyed = true;
      wake?.();
    },
    [Symbol.asyncIterator]: iterate,
  };
}

export function createFakeAnthropic(
  script: (call: AnthropicRecordedCall) => AnthropicScript,
): FakeAnthropic {
  const calls: AnthropicRecordedCall[] = [];
  const request: AnthropicRequestFn = (options, onResponse) => {
    const call: AnthropicRecordedCall = {
      options,
      body: undefined,
      requestDestroyed: false,
      responseDestroyed: false,
      bytesDelivered: 0,
    };
    calls.push(call);
    const errorListeners: ((error: Error) => void)[] = [];
    const timeoutListeners: (() => void)[] = [];
    let destroyed = false;
    let started = false;
    const emitError = (error: Error): void => {
      if (destroyed) return;
      destroyed = true;
      for (const listener of errorListeners) listener(error);
    };
    options.signal.addEventListener("abort", () => {
      call.requestDestroyed = true;
      emitError(Object.assign(new Error("aborted"), { name: "AbortError", code: "ABORT_ERR" }));
    });
    const flow = async (): Promise<void> => {
      const scripted = script(call);
      if ("hang" in scripted) return;
      if ("socketTimeout" in scripted) {
        for (const listener of timeoutListeners) listener();
        return;
      }
      if ("error" in scripted) {
        emitError(scripted.error);
        return;
      }
      if (scripted.responseDelayMs !== undefined && scripted.responseDelayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, scripted.responseDelayMs));
      }
      if (destroyed) return;
      onResponse(buildResponse(scripted, call));
    };
    const handle: AnthropicRequestHandle = {
      on(event: "error" | "timeout", listener: ((error: Error) => void) | (() => void)) {
        if (event === "error") errorListeners.push(listener as (error: Error) => void);
        else timeoutListeners.push(listener as () => void);
        return handle;
      },
      end(body: string) {
        if (started) return;
        started = true;
        call.body = body;
        flow().catch((error: unknown) => {
          emitError(error instanceof Error ? error : new Error("fake-anthropic failure"));
        });
      },
      destroy() {
        destroyed = true;
        call.requestDestroyed = true;
      },
    };
    return handle;
  };
  return { request, calls };
}

/** A 200 Messages API reply with the given content blocks. */
export function messageReply(
  content: readonly unknown[],
  stopReason: string | null = "end_turn",
  extra: Record<string, unknown> = {},
): AnthropicScriptedResponse {
  return {
    status: 200,
    body: JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "test",
      content,
      stop_reason: stopReason,
      usage: { input_tokens: 1, output_tokens: 1 },
      ...extra,
    }),
  };
}

export function textReply(text: string): AnthropicScriptedResponse {
  return messageReply([{ type: "text", text }]);
}
