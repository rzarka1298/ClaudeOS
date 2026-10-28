import { EventEmitter } from "node:events";
import http from "node:http";
import { EMPTY_PROJECTS_SNAPSHOT, SERVICE_EVENT_TYPES, SNAPSHOT_PATH } from "@ccc/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEventClient,
  EVENT_SNAPSHOT_COVERAGE,
  type EventClientState,
} from "./event-client.js";

vi.mock("node:http", () => ({
  default: { request: vi.fn() },
}));

interface FakeReq extends EventEmitter {
  end: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

interface FakeRes extends EventEmitter {
  statusCode: number;
  setEncoding: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
}

interface PendingCall {
  options: { path: string; headers?: Record<string, string> };
  req: FakeReq;
  res: FakeRes;
  /** Simulates a response arriving (never called == the request never gets a response, only req-level events like "error" are possible). */
  respond: (statusCode?: number) => void;
}

function makeFakeReq(): FakeReq {
  const req = new EventEmitter() as FakeReq;
  req.end = vi.fn();
  req.destroy = vi.fn();
  return req;
}

let pendingCalls: PendingCall[];

/**
 * Fake timers plus a chain of real Promises (getToken() -> .then -> new
 * Promise(...) -> ...) can need more than one microtask-queue drain to
 * fully settle -- `vi.advanceTimersByTimeAsync(0)` drains one cycle
 * reliably; calling it a few times in a row is the simplest robust way to
 * let a multi-hop async chain (e.g. fetchSnapshotAndResume) fully settle
 * before the test's next assertion.
 */
async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  pendingCalls = [];
  const requestMock = http.request as unknown as ReturnType<typeof vi.fn>;
  requestMock.mockReset();
  requestMock.mockImplementation(
    (
      options: { path: string; headers?: Record<string, string> },
      callback: (res: FakeRes) => void,
    ) => {
      const req = makeFakeReq();
      const res = new EventEmitter() as FakeRes;
      res.setEncoding = vi.fn();
      res.pause = vi.fn();
      res.resume = vi.fn();
      const respond = (statusCode = 200): void => {
        res.statusCode = statusCode;
        callback(res);
      };
      pendingCalls.push({ options, req, res, respond });
      return req;
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
});

const connectionRefused = () => Object.assign(new Error("boom"), { code: "ECONNREFUSED" });

const heartbeatRecord = (id: number) =>
  `id: ${id}\ndata: {"id":${id},"type":"service.heartbeat","occurredAt":"t","payload":{}}\n\n`;

const resyncRecord = (id: number) =>
  `id: ${id}\ndata: {"id":${id},"type":"stream.resync","occurredAt":"t","payload":{"lastEventId":${id}}}\n\n`;

describe("createEventClient", () => {
  it("sends no last-event header on first subscribe", async () => {
    const getToken = vi.fn().mockResolvedValue("tok");
    const client = createEventClient({ socketPath: "/tmp/sock", getToken });
    client.subscribe(
      () => {},
      () => {},
    );
    await flush();

    expect(pendingCalls).toHaveLength(1);
    expect(pendingCalls[0]?.options.headers?.["X-Last-Event-Id"]).toBeUndefined();
    client.dispose();
  });

  it("sends the last received identifier in the header on the next reconnect", async () => {
    const getToken = vi.fn().mockResolvedValue("tok");
    const client = createEventClient({ socketPath: "/tmp/sock", getToken });
    client.subscribe(
      () => {},
      () => {},
    );
    await flush();

    const first = pendingCalls[0];
    first?.respond();
    first?.res.emit("data", heartbeatRecord(7));
    await flush();
    first?.res.emit("end");
    await flush();
    // advance past the scheduled backoff delay to trigger the next connect
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();

    expect(pendingCalls).toHaveLength(2);
    expect(pendingCalls[1]?.options.headers?.["X-Last-Event-Id"]).toBe("7");
    client.dispose();
  });

  it("receiving stream.resync fetches the snapshot before emitting any further event, and adopts its lastEventId", async () => {
    const getToken = vi.fn().mockResolvedValue("tok");
    const events: unknown[] = [];
    const snapshots: unknown[] = [];
    const client = createEventClient({ socketPath: "/tmp/sock", getToken });
    client.subscribe(
      (e) => events.push(e),
      () => {},
      (s) => snapshots.push(s),
    );
    await flush();

    const stream = pendingCalls[0];
    stream?.respond();
    stream?.res.emit("data", resyncRecord(5));
    await flush();

    // The resync branch opened a second request (the snapshot fetch).
    expect(pendingCalls).toHaveLength(2);
    expect(pendingCalls[1]?.options.path).toBe(SNAPSHOT_PATH);

    // A heartbeat arriving on the ORIGINAL stream while the snapshot fetch
    // is still pending must not be emitted yet.
    stream?.res.emit("data", heartbeatRecord(6));
    await flush();
    expect(events).toHaveLength(0);

    const snapshotCall = pendingCalls[1];
    snapshotCall?.respond();
    snapshotCall?.res.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          lastEventId: 5,
          state: { serviceStartedAt: "t", projects: EMPTY_PROJECTS_SNAPSHOT },
        }),
      ),
    );
    snapshotCall?.res.emit("end");
    await flush();

    expect(snapshots).toEqual([
      { lastEventId: 5, state: { serviceStartedAt: "t", projects: EMPTY_PROJECTS_SNAPSHOT } },
    ]);
    expect(events).toHaveLength(1);
    expect((events[0] as { id: number }).id).toBe(6);
    client.dispose();
  });

  describe("the position is monotonic across a resync (folded todo 2026-10-25-event-client-last-id-regress)", () => {
    function answerSnapshot(call: PendingCall | undefined, lastEventId: number): void {
      call?.respond();
      call?.res.emit(
        "data",
        Buffer.from(
          JSON.stringify({
            lastEventId,
            state: { serviceStartedAt: "t", projects: EMPTY_PROJECTS_SNAPSHOT },
          }),
        ),
      );
      call?.res.emit("end");
    }

    async function reconnectHeader(): Promise<string | undefined> {
      const before = pendingCalls.length;
      pendingCalls[0]?.res.emit("end");
      await flush();
      await vi.advanceTimersByTimeAsync(60_000);
      await flush();
      return pendingCalls.slice(before).find((call) => call.options.path !== SNAPSHOT_PATH)?.options
        .headers?.["X-Last-Event-Id"];
    }

    it("does not deliver events already in the snapshot that were queued in the same chunk, and keeps the position at the snapshot", async () => {
      const getToken = vi.fn().mockResolvedValue("tok");
      const events: Array<{ id: number }> = [];
      const client = createEventClient({ socketPath: "/tmp/sock", getToken });
      client.subscribe(
        (e) => events.push(e as { id: number }),
        () => {},
        () => {},
      );
      await flush();

      const stream = pendingCalls[0];
      stream?.respond();
      // One chunk: the resync, then two deltas the snapshot (lastEventId 9) already contains.
      stream?.res.emit("data", resyncRecord(5) + heartbeatRecord(7) + heartbeatRecord(8));
      await flush();
      answerSnapshot(pendingCalls[1], 9);
      await flush();

      expect(events.map((e) => e.id)).toEqual([]);
      expect(await reconnectHeader()).toBe("9");
      client.dispose();
    });

    it("delivers an event past the snapshot and moves the position to it", async () => {
      const getToken = vi.fn().mockResolvedValue("tok");
      const events: Array<{ id: number }> = [];
      const client = createEventClient({ socketPath: "/tmp/sock", getToken });
      client.subscribe(
        (e) => events.push(e as { id: number }),
        () => {},
        () => {},
      );
      await flush();

      const stream = pendingCalls[0];
      stream?.respond();
      stream?.res.emit("data", resyncRecord(5) + heartbeatRecord(8) + heartbeatRecord(10));
      await flush();
      answerSnapshot(pendingCalls[1], 9);
      await flush();

      expect(events.map((e) => e.id)).toEqual([10]);
      expect(await reconnectHeader()).toBe("10");
      client.dispose();
    });

    it("never reports an older position after a newer one", async () => {
      const getToken = vi.fn().mockResolvedValue("tok");
      const client = createEventClient({ socketPath: "/tmp/sock", getToken });
      client.subscribe(
        () => {},
        () => {},
      );
      await flush();

      const stream = pendingCalls[0];
      stream?.respond();
      stream?.res.emit("data", heartbeatRecord(12));
      await flush();
      stream?.res.emit("data", heartbeatRecord(11));
      await flush();

      expect(await reconnectHeader()).toBe("12");
      client.dispose();
    });

    it("resets the floor with the position: a reconnect to a restarted service whose ids restart is accepted", async () => {
      const getToken = vi.fn().mockResolvedValue("tok");
      const events: Array<{ id: number }> = [];
      const client = createEventClient({ socketPath: "/tmp/sock", getToken });
      client.subscribe(
        (e) => events.push(e as { id: number }),
        () => {},
        () => {},
      );
      await flush();

      // First stream: a snapshot at 9 sets the floor to 9.
      const first = pendingCalls[0];
      first?.respond();
      first?.res.emit("data", resyncRecord(5));
      await flush();
      answerSnapshot(pendingCalls[1], 9);
      await flush();
      // A second resync whose snapshot cannot be fetched sends the position back to undefined.
      first?.res.emit("data", resyncRecord(11));
      await flush();
      pendingCalls[2]?.req.emit("error", connectionRefused());
      await flush();
      await vi.advanceTimersByTimeAsync(60_000);
      await flush();

      const reconnect = pendingCalls.find(
        (call, index) => index > 2 && call.options.path !== SNAPSHOT_PATH,
      );
      expect(reconnect?.options.headers?.["X-Last-Event-Id"]).toBeUndefined();
      reconnect?.respond();
      reconnect?.res.emit("data", heartbeatRecord(1));
      await flush();

      expect(events.map((e) => e.id)).toEqual([1]);
      client.dispose();
    });

    it("adopts a snapshot at a LOWER id than the current position as-is (a restarted service restarts its ids): the reconnect carries the snapshot's id", async () => {
      const getToken = vi.fn().mockResolvedValue("tok");
      const client = createEventClient({ socketPath: "/tmp/sock", getToken });
      client.subscribe(
        () => {},
        () => {},
        () => {},
      );
      await flush();

      const stream = pendingCalls[0];
      stream?.respond();
      stream?.res.emit("data", heartbeatRecord(500));
      await flush();
      // The service restarted: its resync is answered by a snapshot far below the old position.
      stream?.res.emit("data", resyncRecord(0));
      await flush();
      answerSnapshot(pendingCalls[1], 3);
      await flush();

      expect(await reconnectHeader()).toBe("3");
      client.dispose();
    });

    // Fix round FIX2B (C1): an invalidation event is not "contained" in a snapshot that carries no
    // state for its domain, so the floor must not discard it.
    describe("invalidation-only events at or below the floor (FIX2B C1)", () => {
      const eventRecord = (id: number, type: string) =>
        `id: ${id}\ndata: {"id":${id},"type":"${type}","occurredAt":"t","payload":{}}\n\n`;

      it.each(["tasks.changed", "research.updated"])(
        "still delivers %s with an id at or below the snapshot, without moving the position back",
        async (type) => {
          const getToken = vi.fn().mockResolvedValue("tok");
          const events: Array<{ id: number; type: string }> = [];
          const client = createEventClient({ socketPath: "/tmp/sock", getToken });
          client.subscribe(
            (e) => events.push(e as { id: number; type: string }),
            () => {},
            () => {},
          );
          await flush();

          const stream = pendingCalls[0];
          stream?.respond();
          stream?.res.emit(
            "data",
            resyncRecord(5) + eventRecord(7, type) + eventRecord(9, type) + heartbeatRecord(8),
          );
          await flush();
          answerSnapshot(pendingCalls[1], 9);
          await flush();

          // The invalidations reach subscribers; the snapshot-contained heartbeat does not.
          expect(events.map((e) => `${e.type}#${e.id}`)).toEqual([`${type}#7`, `${type}#9`]);
          expect(await reconnectHeader()).toBe("9");
          client.dispose();
        },
      );

      it.each([
        "session.upserted",
        "usage.updated",
        "claude-integration.updated",
        "approval.upserted",
        "projects.updated",
        "codex.sessions.updated",
        "codex.usage.updated",
        "codex.tokens.updated",
        "codex.integration.updated",
      ])(
        "still discards %s at or below the snapshot: the snapshot carries that state",
        async (type) => {
          const getToken = vi.fn().mockResolvedValue("tok");
          const events: Array<{ id: number }> = [];
          const client = createEventClient({ socketPath: "/tmp/sock", getToken });
          client.subscribe(
            (e) => events.push(e as { id: number }),
            () => {},
            () => {},
          );
          await flush();

          const stream = pendingCalls[0];
          stream?.respond();
          stream?.res.emit("data", resyncRecord(5) + eventRecord(7, type));
          await flush();
          answerSnapshot(pendingCalls[1], 9);
          await flush();

          expect(events).toEqual([]);
          client.dispose();
        },
      );

      it("pins the classification: every event type is exactly one of snapshot-carried, invalidation-only, transport", () => {
        const classes = new Map<string, string[]>();
        for (const [type, kind] of Object.entries(EVENT_SNAPSHOT_COVERAGE)) {
          classes.set(kind, [...(classes.get(kind) ?? []), type]);
        }
        expect(Object.keys(EVENT_SNAPSHOT_COVERAGE).sort()).toEqual(
          [...SERVICE_EVENT_TYPES].sort(),
        );
        expect(classes.get("invalidation-only")?.sort()).toEqual([
          "research.updated",
          "tasks.changed",
        ]);
        expect(classes.get("transport")?.sort()).toEqual([
          "connection.state",
          "service.heartbeat",
          "stream.resync",
        ]);
        expect(classes.get("snapshot-carried")?.sort()).toEqual([
          "approval.upserted",
          "claude-integration.updated",
          "codex.integration.updated",
          "codex.sessions.updated",
          "codex.tokens.updated",
          "codex.usage.updated",
          "projects.updated",
          "session.upserted",
          "usage.updated",
        ]);
      });
    });
  });

  it.each([
    [
      "an unusable snapshot body",
      (call: PendingCall) => {
        call.respond(500);
        call.res.emit("data", Buffer.from(JSON.stringify({ error: "internal error" })));
        call.res.emit("end");
      },
    ],
    [
      "a failed snapshot request",
      (call: PendingCall) => {
        call.req.emit("error", connectionRefused());
      },
    ],
  ])(
    "%s forces a full resync: the stream is dropped, no later event is delivered, and the reconnect carries no last-event header",
    async (_label, fail) => {
      const getToken = vi.fn().mockResolvedValue("tok");
      const events: unknown[] = [];
      const snapshots: unknown[] = [];
      const states: EventClientState[] = [];
      const client = createEventClient({ socketPath: "/tmp/sock", getToken });
      client.subscribe(
        (e) => events.push(e),
        (s) => states.push(s),
        (s) => snapshots.push(s),
      );
      await flush();

      const stream = pendingCalls[0];
      stream?.respond();
      stream?.res.emit("data", resyncRecord(5));
      await flush();
      const snapshotCall = pendingCalls[1];
      expect(snapshotCall?.options.path).toBe(SNAPSHOT_PATH);

      // A delta queued behind the resync on the same stream: with no adopted
      // base it must never be delivered, nor may its id become the resume point.
      stream?.res.emit("data", heartbeatRecord(6));
      if (snapshotCall) fail(snapshotCall);
      await flush();

      expect(snapshots).toEqual([]);
      expect(events).toEqual([]);
      expect(states.at(-1)?.kind).toBe("disconnected");

      await vi.advanceTimersByTimeAsync(60_000);
      await flush();
      const reconnect = pendingCalls.find(
        (call, index) => index > 1 && call.options.path !== SNAPSHOT_PATH,
      );
      expect(reconnect).toBeDefined();
      expect(reconnect?.options.headers?.["X-Last-Event-Id"]).toBeUndefined();
      client.dispose();
    },
  );

  it("consecutive reconnect failures produce strictly increasing delays capped at 30 seconds", async () => {
    const getToken = vi.fn().mockResolvedValue("tok");
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const client = createEventClient({ socketPath: "/tmp/sock", getToken });
    client.subscribe(
      () => {},
      () => {},
    );

    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      await flush();
      const call = pendingCalls[pendingCalls.length - 1];
      // Never respond() -- a bare connection-level error, never a response.
      call?.req.emit("error", connectionRefused());
      await flush();
      const lastTimeoutCall = setTimeoutSpy.mock.calls.at(-1);
      const delay = lastTimeoutCall?.[1] as number;
      delays.push(delay);
      await vi.advanceTimersByTimeAsync(delay);
    }

    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThan(delays[i - 1] as number);
    }
    expect(Math.max(...delays)).toBeLessThanOrEqual(30_000);
    client.dispose();
  });

  it("dispose() during a pending backoff cancels the retry -- no further request is made", async () => {
    const getToken = vi.fn().mockResolvedValue("tok");
    const client = createEventClient({ socketPath: "/tmp/sock", getToken });
    client.subscribe(
      () => {},
      () => {},
    );
    await flush();
    pendingCalls[0]?.req.emit("error", connectionRefused());
    await flush();
    expect(pendingCalls).toHaveLength(1);

    client.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(pendingCalls).toHaveLength(1);
  });

  it("never reports a live connection state while retrying", async () => {
    const getToken = vi.fn().mockResolvedValue("tok");
    const states: EventClientState["kind"][] = [];
    const client = createEventClient({ socketPath: "/tmp/sock", getToken });
    client.subscribe(
      () => {},
      (s) => states.push(s.kind),
    );
    await flush();
    // Never respond() -- this connection attempt fails outright.
    pendingCalls[0]?.req.emit("error", connectionRefused());
    await flush();

    expect(states).not.toContain("live");
    expect(states.at(-1)).toBe("disconnected");
    client.dispose();
  });

  it("drives connecting -> live on a successful connect", async () => {
    const getToken = vi.fn().mockResolvedValue("tok");
    const states: EventClientState["kind"][] = [];
    const client = createEventClient({ socketPath: "/tmp/sock", getToken });
    client.subscribe(
      () => {},
      (s) => states.push(s.kind),
    );
    await flush();
    pendingCalls[0]?.respond();
    await flush();

    expect(states).toEqual(["connecting", "live"]);
    client.dispose();
  });

  it("a bare 'close' with no preceding 'end' (e.g. the server process disappears) is treated as a disconnect and reconnects", async () => {
    // Reproduces the real-world UAT failure: `launchctl bootout` SIGTERMs
    // the service, and in the real Electron/Node runtime the UDS response
    // can surface only a socket-level 'close', never 'end'. Before the
    // fix, only 'end'/'error' drove a disconnect transition, so this event
    // was silently ignored and the client stayed frozen on "live" forever.
    const getToken = vi.fn().mockResolvedValue("tok");
    const states: EventClientState["kind"][] = [];
    const client = createEventClient({ socketPath: "/tmp/sock", getToken });
    client.subscribe(
      () => {},
      (s) => states.push(s.kind),
    );
    await flush();
    pendingCalls[0]?.respond();
    await flush();
    expect(states.at(-1)).toBe("live");

    pendingCalls[0]?.res.emit("close");
    await flush();
    expect(states.at(-1)).toBe("disconnected");

    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(pendingCalls).toHaveLength(2);
    client.dispose();
  });

  it("no event received within 3x the heartbeat interval transitions to disconnected and engages reconnect, even with no close/error at all", async () => {
    // This is the second half of the same real-world failure: a UDS
    // response that never surfaces ANY terminal event (no 'close', no
    // 'end', no 'error') must still be caught by a liveness watchdog, not
    // wait forever for a transport signal that may never arrive.
    const getToken = vi.fn().mockResolvedValue("tok");
    const states: EventClientState["kind"][] = [];
    const client = createEventClient({
      socketPath: "/tmp/sock",
      getToken,
      heartbeatIntervalMs: 1000,
    });
    client.subscribe(
      () => {},
      (s) => states.push(s.kind),
    );
    await flush();
    pendingCalls[0]?.respond();
    await flush();
    expect(states.at(-1)).toBe("live");

    // No data, no close, no error -- just silence. Advance past 3x the
    // 1000ms heartbeat interval.
    await vi.advanceTimersByTimeAsync(3_000);
    await flush();
    expect(states.at(-1)).toBe("disconnected");

    // Advance only past the first backoff delay (capped well under the
    // second connection's own 3000ms watchdog window) so exactly one
    // reconnect attempt is observed, not a cascade of further
    // watchdog-driven retries against a mock that never responds.
    await vi.advanceTimersByTimeAsync(700);
    await flush();
    expect(pendingCalls).toHaveLength(2);
    client.dispose();
  });

  it("receiving a heartbeat resets the liveness watchdog", async () => {
    const getToken = vi.fn().mockResolvedValue("tok");
    const states: EventClientState["kind"][] = [];
    const client = createEventClient({
      socketPath: "/tmp/sock",
      getToken,
      heartbeatIntervalMs: 1000,
    });
    client.subscribe(
      () => {},
      (s) => states.push(s.kind),
    );
    await flush();
    pendingCalls[0]?.respond();
    await flush();

    // Reset the watchdog just before it would have expired.
    await vi.advanceTimersByTimeAsync(2_000);
    pendingCalls[0]?.res.emit("data", heartbeatRecord(1));
    await flush();
    // Total elapsed is now 4000ms since connect, past the 3000ms window --
    // but only 2000ms since the reset, so it must still report live.
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();

    expect(states.at(-1)).toBe("live");
    client.dispose();
  });
});
