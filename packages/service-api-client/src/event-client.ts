import http, { type IncomingMessage } from "node:http";
import {
  AUTH_HEADER,
  EVENTS_PATH,
  LAST_EVENT_ID_HEADER,
  type ServiceEvent,
  ServiceEventSchema,
  SNAPSHOT_PATH,
  type SnapshotResponse,
  SnapshotResponseSchema,
} from "@ccc/domain";
import { createEventStreamParser } from "./sse-parser.js";

export type EventClientState =
  | { kind: "connecting" }
  | { kind: "live" }
  | { kind: "disconnected"; reason: string };

export interface CreateEventClientOptions {
  socketPath: string;
  /** Returns a fresh bearer token for the next connection or snapshot-fetch attempt. */
  getToken: () => Promise<string>;
}

export interface EventClient {
  /**
   * Starts the long-lived subscription. `onEvent` fires for every real
   * event the stream delivers (heartbeats included, `stream.resync`
   * excluded — that control event drives `onSnapshot` instead);
   * `onStateChange` fires on every connection-state transition, including
   * into and out of a retry; `onSnapshot` fires once a full-resync
   * snapshot has been fetched and adopted.
   */
  subscribe(
    onEvent: (event: ServiceEvent) => void,
    onStateChange: (state: EventClientState) => void,
    onSnapshot?: (snapshot: SnapshotResponse) => void,
  ): void;
  /** Tears the subscription down and cancels any pending retry; safe to call more than once. */
  dispose(): void;
}

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;
// Kept well under the 100% growth a doubling backoff produces at each step,
// so a delay's jittered maximum never reaches the next delay's unjittered
// minimum -- the strictly-increasing-delays guarantee holds regardless of
// what Math.random() draws.
const BACKOFF_JITTER_FRACTION = 0.2;

function nextBackoffDelay(attempt: number): number {
  const base = Math.min(INITIAL_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  const jitter = Math.random() * base * BACKOFF_JITTER_FRACTION;
  return Math.min(base + jitter, MAX_BACKOFF_MS);
}

/**
 * `createEventClient({ socketPath, getToken })` — issues the stream
 * request through `http.request({ socketPath })` with the bearer token
 * attached, feeds the response into the hardened incremental parser
 * (`sse-parser.ts`), tracks `lastEventId` and sends it in the
 * `X-Last-Event-Id` header on every connection after the first, handles
 * `stream.resync` by fetching and adopting the snapshot before resuming
 * event delivery, and reconnects with exponential backoff on stream end or
 * transport error.
 */
export function createEventClient({ socketPath, getToken }: CreateEventClientOptions): EventClient {
  let disposed = false;
  let subscribed = false;
  let onEventCb: ((event: ServiceEvent) => void) | undefined;
  let onStateCb: ((state: EventClientState) => void) | undefined;
  let onSnapshotCb: ((snapshot: SnapshotResponse) => void) | undefined;
  let currentReq: http.ClientRequest | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let lastEventId: number | undefined;
  let parser = createEventStreamParser();

  function setState(state: EventClientState): void {
    if (disposed) return;
    onStateCb?.(state);
  }

  function scheduleReconnect(): void {
    if (disposed) return;
    const delay = nextBackoffDelay(attempt);
    attempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void connect();
    }, delay);
  }

  /**
   * Fetches `GET /api/v1/snapshot`, adopts its `lastEventId`, and hands the
   * snapshot to the caller. Runs on the plain `node:http` transport
   * directly (not through the JSON-response-shaped `SocketApiClient`) to
   * keep this module's only outbound surface `http.request({socketPath})`,
   * matching `socket-api-client.ts`'s own convention.
   */
  function fetchSnapshotAndResume(): Promise<void> {
    return getToken()
      .then(
        (token) =>
          new Promise<void>((resolve, reject) => {
            const req = http.request(
              {
                socketPath,
                path: SNAPSHOT_PATH,
                method: "GET",
                headers: { [AUTH_HEADER]: `Bearer ${token}` },
              },
              (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (c: Buffer) => chunks.push(c));
                res.on("end", () => {
                  try {
                    const raw = Buffer.concat(chunks).toString("utf8");
                    const parsed: unknown = raw.length > 0 ? JSON.parse(raw) : undefined;
                    const result = SnapshotResponseSchema.safeParse(parsed);
                    if (result.success) {
                      lastEventId = result.data.lastEventId;
                      onSnapshotCb?.(result.data);
                    }
                    resolve();
                  } catch (err) {
                    reject(err instanceof Error ? err : new Error(String(err)));
                  }
                });
              },
            );
            req.on("error", reject);
            req.end();
          }),
      )
      .catch(() => {
        // A failed snapshot fetch is not fatal to the subscription: the
        // next reconnect (stream end/error already schedules one) retries
        // the whole handshake -> connect -> resync flow from scratch.
      });
  }

  async function handleChunk(chunk: string, res: IncomingMessage): Promise<void> {
    const results = parser.feed(chunk);
    for (const result of results) {
      if (disposed) return;
      if (result.kind !== "event") continue; // parse-error entries are dropped; logging them is a later phase's concern
      const parsed = ServiceEventSchema.safeParse(result.data);
      if (!parsed.success) continue;
      const event = parsed.data;
      if (event.type === "stream.resync") {
        // Pause the underlying stream so no event arriving after this one
        // in the same or a later chunk is emitted before the snapshot is
        // fetched and adopted -- the ordering the resync path depends on
        // being race-free.
        res.pause();
        await fetchSnapshotAndResume();
        res.resume();
        continue;
      }
      if (event.id > 0) lastEventId = event.id;
      onEventCb?.(event);
    }
  }

  async function connect(): Promise<void> {
    if (disposed) return;
    setState({ kind: "connecting" });
    parser = createEventStreamParser();

    let token: string;
    try {
      token = await getToken();
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : "unknown error";
      if (!disposed) {
        setState({ kind: "disconnected", reason });
        scheduleReconnect();
      }
      return;
    }
    if (disposed) return;

    const headers: Record<string, string> = { [AUTH_HEADER]: `Bearer ${token}` };
    if (lastEventId !== undefined) {
      headers[LAST_EVENT_ID_HEADER] = String(lastEventId);
    }

    const req = http.request({ socketPath, path: EVENTS_PATH, method: "GET", headers }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        if (!disposed) {
          setState({ kind: "disconnected", reason: `unexpected status ${res.statusCode}` });
          scheduleReconnect();
        }
        return;
      }
      attempt = 0;
      setState({ kind: "live" });
      res.setEncoding("utf8");
      // Chunks are chained onto one FIFO promise rather than handled with
      // an independent "fire and forget" call each: without this, a
      // resync event's await on fetchSnapshotAndResume() only blocks
      // further emission of events parsed from that SAME chunk (already
      // handled by handleChunk's own sequential for-loop) -- a heartbeat
      // arriving in a LATER chunk could otherwise still race ahead of the
      // snapshot fetch and be emitted first.
      let processingChain: Promise<void> = Promise.resolve();
      res.on("data", (chunk: string) => {
        if (disposed) return;
        processingChain = processingChain.then(() => handleChunk(chunk, res)).catch(() => {});
      });
      res.on("end", () => {
        if (disposed) return;
        setState({ kind: "disconnected", reason: "stream ended" });
        scheduleReconnect();
      });
    });
    currentReq = req;
    req.on("error", (err: NodeJS.ErrnoException) => {
      if (disposed) return;
      setState({ kind: "disconnected", reason: err.message });
      scheduleReconnect();
    });
    req.end();
  }

  return {
    subscribe(onEvent, onStateChange, onSnapshot) {
      onEventCb = onEvent;
      onStateCb = onStateChange;
      onSnapshotCb = onSnapshot;
      // Safe to call more than once (e.g. the command-center view is
      // closed and reopened without the plugin unloading): only the first
      // call opens the underlying connection.
      if (subscribed) return;
      subscribed = true;
      void connect();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      currentReq?.destroy();
      onEventCb = undefined;
      onStateCb = undefined;
      onSnapshotCb = undefined;
    },
  };
}
