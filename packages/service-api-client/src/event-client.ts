import http, { type IncomingMessage } from "node:http";
import {
  AUTH_HEADER,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  EVENTS_PATH,
  HEARTBEAT_LIVENESS_MULTIPLIER,
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
  /**
   * The server's heartbeat cadence, matching `CCC_HEARTBEAT_INTERVAL_MS`
   * on the service side. Defaults to `DEFAULT_HEARTBEAT_INTERVAL_MS`
   * (`@ccc/domain`) -- the same default the service itself falls back to.
   * Sizes the liveness watchdog (`HEARTBEAT_LIVENESS_MULTIPLIER` times
   * this value); a test spinning up a real service with a short interval
   * passes the matching short value here so the watchdog fires within its
   * own timeout instead of the production 30s default.
   */
  heartbeatIntervalMs?: number;
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
export function createEventClient({
  socketPath,
  getToken,
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
}: CreateEventClientOptions): EventClient {
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

  // Liveness watchdog (#PLUG-04 UAT fix): a `launchctl bootout` SIGTERM
  // (and observed SIGKILL) of the service can leave the client's response
  // object with no observable transport-level signal at all in the real
  // Electron/Node runtime -- no 'close', no 'end', no 'error'. Without this
  // watchdog, a stream that simply goes silent leaves the client frozen on
  // a stale "live" state forever. Reset on every byte received from the
  // server (heartbeats included) and on issuing each new request; fires a
  // disconnect + reconnect if the window elapses with nothing at all.
  const livenessWindowMs = heartbeatIntervalMs * HEARTBEAT_LIVENESS_MULTIPLIER;
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  // Always points at the currently-open connection attempt's own
  // `endConnection`, so the one shared watchdog timer always tears down
  // whichever connection is actually live when it expires.
  let currentEndConnection: ((reason: string) => void) | undefined;

  function clearWatchdog(): void {
    if (watchdogTimer !== undefined) {
      clearTimeout(watchdogTimer);
      watchdogTimer = undefined;
    }
  }

  function resetWatchdog(): void {
    clearWatchdog();
    if (disposed) return;
    watchdogTimer = setTimeout(() => {
      watchdogTimer = undefined;
      currentEndConnection?.("no event received within the liveness window");
    }, livenessWindowMs);
  }

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

    // Scoped to this one connection attempt: collapses every terminal
    // signal (whichever of 'end'/'close'/'aborted'/'error' the runtime
    // happens to surface, on either req or res -- observed to vary between
    // a graceful SIGTERM and a SIGKILL/hard-crash in the real runtime)
    // into a single disconnected transition, and guards against a stray
    // late-firing event from THIS connection double-scheduling a reconnect
    // after a newer connection has already been opened.
    let connectionSettled = false;
    function endConnection(reason: string): void {
      if (disposed || connectionSettled) return;
      connectionSettled = true;
      clearWatchdog();
      currentReq?.destroy();
      setState({ kind: "disconnected", reason });
      // A fresh handshake (getToken()) happens at the top of the next
      // connect() call regardless of why this one ended -- including a
      // 401 from a stale token after the service restarted with a new
      // install secret, so reconnect never wedges waiting on a token that
      // can never become valid again.
      scheduleReconnect();
    }
    currentEndConnection = endConnection;

    const req = http.request({ socketPath, path: EVENTS_PATH, method: "GET", headers }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        endConnection(`unexpected status ${res.statusCode}`);
        return;
      }
      attempt = 0;
      setState({ kind: "live" });
      resetWatchdog();
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
        // Any byte from the server proves this connection is still alive,
        // not just a fully-parsed event -- reset before processing so a
        // slow/partial chunk still counts.
        resetWatchdog();
        processingChain = processingChain.then(() => handleChunk(chunk, res)).catch(() => {});
      });
      res.on("end", () => endConnection("stream ended"));
      res.on("close", () => endConnection("stream closed"));
      res.on("aborted", () => endConnection("stream aborted"));
      res.on("error", (err: Error) => endConnection(err.message));
    });
    currentReq = req;
    req.on("error", (err: NodeJS.ErrnoException) => endConnection(err.message));
    req.on("close", () => endConnection("request closed"));
    req.end();
    // Covers a hang before the response callback ever fires at all (the
    // request is accepted at the transport level but the server never
    // responds and never surfaces an error) -- the same watchdog also
    // protects the post-connect silent-stream case once reset above.
    resetWatchdog();
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
      clearWatchdog();
      currentReq?.destroy();
      onEventCb = undefined;
      onStateCb = undefined;
      onSnapshotCb = undefined;
    },
  };
}
