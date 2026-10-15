import type { IncomingHttpHeaders } from "node:http";
import { isIP } from "node:net";
import { safeLookup } from "../address-policy.js";
import type {
  RequestFn,
  RequestHandle,
  ResponseStream,
  SafeRequestOptions,
} from "../safe-fetch.js";

/**
 * A fake of `https.request` for the fetcher's tests (D-27: no test touches the network). It records
 * the options of every call and plays a scripted response. Like Node, it asks the `lookup` option
 * to resolve a host NAME before answering (an IP literal skips the lookup), so a test that injects
 * a lookup built on a fake resolver exercises the real address policy end to end. Nothing here opens
 * a socket or resolves a name: the real, DNS-touching `safeLookup` is refused loudly.
 */

export interface ScriptedResponse {
  readonly status?: number;
  readonly headers?: IncomingHttpHeaders;
  /** The body, as one piece or as chunks; strings are encoded as UTF-8. */
  readonly body?: Uint8Array | string | readonly (Uint8Array | string)[];
  /** A delay before each chunk, in milliseconds (uses the global timer, so fake timers apply). */
  readonly chunkDelayMs?: number;
  /** After this many chunks the body never yields again (a stalled connection). */
  readonly stallAfterChunks?: number;
  /** The address of the peer socket reported on the response. */
  readonly remoteAddress?: string;
}

export interface ScriptedError {
  readonly error: Error;
}

export type Script = ScriptedResponse | ScriptedError;

export interface RecordedCall {
  readonly options: SafeRequestOptions;
  /** `https://host/path`, rebuilt from the options. */
  readonly url: string;
  /** The addresses the lookup handed back for the host, when it resolved a name. */
  resolved: readonly string[];
}

export interface FakeHttps {
  readonly request: RequestFn;
  readonly calls: RecordedCall[];
}

export interface FakeHttpsOptions {
  /** True (default): ask `options.lookup` to resolve host names, as Node does. */
  readonly exerciseLookup?: boolean;
}

export function createFakeHttps(
  script: (call: RecordedCall) => Script,
  fakeOptions: FakeHttpsOptions = {},
): FakeHttps {
  const exerciseLookup = fakeOptions.exerciseLookup ?? true;
  const calls: RecordedCall[] = [];

  const request: RequestFn = (options, onResponse) => {
    const call: RecordedCall = {
      options,
      url: `https://${options.hostname}${options.path}`,
      resolved: [],
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
      emitError(Object.assign(new Error("aborted"), { name: "AbortError", code: "ABORT_ERR" }));
    });

    const flow = async (): Promise<void> => {
      if (exerciseLookup) {
        const bare = options.hostname.replace(/^\[|\]$/g, "");
        if (isIP(bare) === 0) {
          if (options.lookup === safeLookup) {
            throw new Error("fake-https: the real safeLookup would resolve a name over DNS");
          }
          const addresses = await new Promise<readonly string[]>((resolve, reject) => {
            options.lookup(options.hostname, { hints: 1024, all: true }, (error, address) => {
              if (error) {
                reject(error);
                return;
              }
              resolve(
                Array.isArray(address) ? address.map((entry) => entry.address) : [String(address)],
              );
            });
          });
          call.resolved = addresses;
        }
      }
      const scripted = script(call);
      if ("error" in scripted) {
        emitError(scripted.error);
        return;
      }
      if (destroyed) return;
      onResponse(buildResponse(scripted, call.resolved[0]));
    };

    const handle: RequestHandle = {
      on(event: "error" | "timeout", listener: ((error: Error) => void) | (() => void)) {
        if (event === "error") errorListeners.push(listener as (error: Error) => void);
        else timeoutListeners.push(listener as () => void);
        return handle;
      },
      end() {
        if (started) return;
        started = true;
        flow().catch((error: unknown) => {
          emitError(error instanceof Error ? error : new Error("fake-https failure"));
        });
      },
      destroy() {
        destroyed = true;
      },
    };
    void timeoutListeners;
    return handle;
  };

  return { request, calls };
}

function toBytes(piece: Uint8Array | string): Uint8Array {
  return typeof piece === "string" ? new TextEncoder().encode(piece) : piece;
}

function chunksOf(body: ScriptedResponse["body"]): Uint8Array[] {
  if (body === undefined) return [];
  if (typeof body === "string" || body instanceof Uint8Array) return [toBytes(body)];
  return body.map(toBytes);
}

function buildResponse(scripted: ScriptedResponse, peer: string | undefined): ResponseStream {
  let destroyed = false;
  let wake: (() => void) | undefined;
  const destroySignal = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const delay = scripted.chunkDelayMs ?? 0;

  async function* iterate(): AsyncGenerator<Uint8Array> {
    let sent = 0;
    // Read lazily: a test can prove the body was never touched.
    for (const chunk of chunksOf(scripted.body)) {
      if (scripted.stallAfterChunks !== undefined && sent >= scripted.stallAfterChunks) {
        await destroySignal;
        return;
      }
      if (delay > 0) {
        await Promise.race([
          new Promise<void>((resolve) => setTimeout(resolve, delay)),
          destroySignal,
        ]);
      }
      if (destroyed) return;
      sent += 1;
      yield chunk;
    }
    if (scripted.stallAfterChunks !== undefined && sent >= scripted.stallAfterChunks) {
      await destroySignal;
    }
  }

  return {
    statusCode: scripted.status ?? 200,
    headers: scripted.headers ?? {},
    socket: { remoteAddress: scripted.remoteAddress ?? peer },
    destroy() {
      destroyed = true;
      wake?.();
    },
    [Symbol.asyncIterator]: iterate,
  };
}

/** Header sets used by many tests. */
export function headersOf(
  contentType: string,
  extra: IncomingHttpHeaders = {},
): IncomingHttpHeaders {
  return { "content-type": contentType, ...extra };
}

/** A resolver (the shape `dns.lookup` has) that answers from a table and never touches DNS. */
export type ResolverTable = Readonly<Record<string, readonly string[]>>;

export function tableResolver(table: ResolverTable) {
  return (
    hostname: string,
    options: { all?: boolean | undefined; family?: number | string | undefined },
    callback: (
      error: NodeJS.ErrnoException | null,
      address: string | { address: string; family: number }[],
      family?: number,
    ) => void,
  ): void => {
    const found = table[hostname.toLowerCase()];
    if (found === undefined) {
      callback(Object.assign(new Error("not found"), { code: "ENOTFOUND" }), "", 0);
      return;
    }
    const entries = found.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    if (options.all === true) callback(null, entries);
    else callback(null, entries[0]?.address ?? "", entries[0]?.family ?? 4);
  };
}
