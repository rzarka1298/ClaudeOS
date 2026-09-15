import http from "node:http";
import { AUTH_HEADER, EVENTS_PATH, type ServiceEvent, ServiceEventSchema } from "@ccc/domain";

export type EventClientState =
  | { kind: "connecting" }
  | { kind: "live" }
  | { kind: "disconnected"; reason: string };

export interface CreateEventClientOptions {
  socketPath: string;
  /** Returns a fresh bearer token for the next connection attempt. */
  getToken: () => Promise<string>;
}

export interface EventClient {
  /**
   * Starts the long-lived subscription. `onEvent` fires for every event the
   * stream delivers (heartbeats included); `onStateChange` fires on every
   * connection-state transition, so a caller can drive a UI signal from it
   * rather than from a one-shot probe.
   */
  subscribe(
    onEvent: (event: ServiceEvent) => void,
    onStateChange: (state: EventClientState) => void,
  ): void;
  /** Tears the subscription down; safe to call more than once. */
  dispose(): void;
}

/**
 * `createEventClient({ socketPath, getToken })` — issues the stream
 * request through `http.request({ socketPath })` with the bearer token
 * attached, feeds the response into a minimal incremental parser, and
 * surfaces connection-state transitions to its caller. This task's parser
 * is intentionally minimal (a single `\n\n`-boundary scan); Task 3 extracts
 * a hardened incremental parser (`sse-parser.ts`) and adds reconnect
 * backoff and resync handling — this version proves the live push path
 * only.
 */
export function createEventClient({ socketPath, getToken }: CreateEventClientOptions): EventClient {
  let disposed = false;
  let subscribed = false;
  let onEventCb: ((event: ServiceEvent) => void) | undefined;
  let onStateCb: ((state: EventClientState) => void) | undefined;
  let buffer = "";
  let currentReq: http.ClientRequest | undefined;

  function setState(state: EventClientState): void {
    onStateCb?.(state);
  }

  function consume(chunk: string): void {
    buffer += chunk;
    let idx = buffer.indexOf("\n\n");
    while (idx !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLine = raw.match(/^data: (.+)$/m);
      if (dataLine) {
        try {
          const parsed: unknown = JSON.parse(dataLine[1] as string);
          const result = ServiceEventSchema.safeParse(parsed);
          if (result.success) onEventCb?.(result.data);
        } catch {
          // A malformed event must not end a long-lived subscription
          // (T-01-36); Task 3's hardened parser reports this as a
          // failure entry instead of silently dropping it.
        }
      }
      idx = buffer.indexOf("\n\n");
    }
  }

  async function connect(): Promise<void> {
    if (disposed) return;
    setState({ kind: "connecting" });
    let token: string;
    try {
      token = await getToken();
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : "unknown error";
      if (!disposed) setState({ kind: "disconnected", reason });
      return;
    }
    if (disposed) return;

    const req = http.request(
      {
        socketPath,
        path: EVENTS_PATH,
        method: "GET",
        headers: { [AUTH_HEADER]: `Bearer ${token}` },
      },
      (res) => {
        if (res.statusCode !== 200) {
          setState({ kind: "disconnected", reason: `unexpected status ${res.statusCode}` });
          res.resume();
          return;
        }
        setState({ kind: "live" });
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => consume(chunk));
        res.on("end", () => {
          if (!disposed) setState({ kind: "disconnected", reason: "stream ended" });
        });
      },
    );
    currentReq = req;
    req.on("error", (err: NodeJS.ErrnoException) => {
      if (!disposed) setState({ kind: "disconnected", reason: err.message });
    });
    req.end();
  }

  return {
    subscribe(onEvent, onStateChange) {
      onEventCb = onEvent;
      onStateCb = onStateChange;
      // Safe to call more than once (e.g. the command-center view is closed
      // and reopened without the plugin unloading): only the first call
      // opens the underlying connection; later calls just re-point the
      // callbacks at whatever connection is already live or retrying.
      if (subscribed) return;
      subscribed = true;
      void connect();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      currentReq?.destroy();
    },
  };
}
