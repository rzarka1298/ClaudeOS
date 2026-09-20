import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import http from "node:http";
import { join } from "node:path";
import {
  AUTH_HEADER,
  EVENTS_PATH,
  HANDSHAKE_PATH,
  type HandshakeResponse,
  LAST_EVENT_ID_HEADER,
  type ServiceEvent,
  ServiceEventSchema,
  SNAPSHOT_PATH,
  type SnapshotResponse,
} from "@ccc/domain";
import {
  createEventClient,
  type EventClientState,
  createSocketApiClient,
} from "@ccc/service-api-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServiceForTest } from "./service-harness.js";
import { withTempSocketDir } from "./socket-fixture.js";

const KEYCHAIN_SERVICE_NAME = "com.claude-command-center";
const ITEM_NOT_FOUND_EXIT_CODE = 44;

/**
 * Same throwaway-Keychain-account convention as `authenticated-roundtrip
 * .test.ts` (plan 01-02): every test here spawns the real, built
 * `@ccc/service` entry point, which persists the per-install secret to the
 * real macOS Keychain under a fresh account, deleted in teardown.
 * `CCC_HEARTBEAT_INTERVAL_MS` is set short so the tests observe a real
 * heartbeat push within their own timeout rather than the production
 * 30-second default.
 */
let throwawayAccount: string;

beforeEach(() => {
  throwawayAccount = `install-secret-test-${randomBytes(6).toString("hex")}`;
  process.env.CCC_INSTALL_SECRET_ACCOUNT = throwawayAccount;
  process.env.CCC_HEARTBEAT_INTERVAL_MS = "150";
});

afterEach(() => {
  delete process.env.CCC_INSTALL_SECRET_ACCOUNT;
  delete process.env.CCC_HEARTBEAT_INTERVAL_MS;
  try {
    execFileSync(
      "security",
      ["delete-generic-password", "-a", throwawayAccount, "-s", KEYCHAIN_SERVICE_NAME],
      { stdio: "ignore" },
    );
  } catch (err: unknown) {
    const status = (err as { status?: number }).status;
    if (status !== ITEM_NOT_FOUND_EXIT_CODE) throw err;
  }
});

/** Builds the same `getToken` shape `packages/plugin/src/main.ts` constructs. */
function tokenGetter(socketPath: string): () => Promise<string> {
  const handshakeClient = createSocketApiClient({ socketPath });
  return async () => {
    const res = await handshakeClient.request<HandshakeResponse>({
      method: "POST",
      path: HANDSHAKE_PATH,
    });
    return res.body.token;
  };
}

/**
 * Opens the raw event stream (optionally carrying a last-event header) and
 * resolves with the first record matching `predicate`, then tears the
 * request down. Task 2's own replay/resync end-to-end proof needs to set
 * `X-Last-Event-Id` explicitly on a fresh connection — `createEventClient`
 * doesn't expose that yet (it tracks its own `lastEventId` internally,
 * Task 3), so this is a minimal, test-only stand-in for exactly that one
 * capability, using the same wire format the production parser reads.
 *
 * A predicate (rather than "just the first record") is required because
 * Task 2 makes every connection carrying no last-event header resolve to
 * resync (`resolveReplayMode`) — including a client's very first-ever
 * connect. The first record on such a connection is always the
 * `stream.resync` control event, not the first real `service.heartbeat`;
 * callers that want the first heartbeat specifically must filter for it.
 */
function waitForMatchingEvent(
  socketPath: string,
  token: string,
  predicate: (event: ServiceEvent) => boolean,
  lastEventId?: number,
  timeoutMs = 5000,
): Promise<ServiceEvent> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const headers: Record<string, string> = { [AUTH_HEADER]: `Bearer ${token}` };
    if (lastEventId !== undefined) {
      headers[LAST_EVENT_ID_HEADER] = String(lastEventId);
    }

    const req = http.request({ socketPath, path: EVENTS_PATH, method: "GET", headers }, (res) => {
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        if (settled) return;
        buffer += chunk;
        let idx = buffer.indexOf("\n\n");
        while (idx !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLine = raw.match(/^data: (.+)$/m);
          if (dataLine) {
            const parsed: unknown = JSON.parse(dataLine[1] as string);
            const result = ServiceEventSchema.safeParse(parsed);
            if (result.success && predicate(result.data)) {
              settled = true;
              clearTimeout(timer);
              req.destroy();
              resolve(result.data);
              return;
            }
          }
          idx = buffer.indexOf("\n\n");
        }
      });
    });
    req.on("error", (err) => {
      if (settled) return;
      if ((err as NodeJS.ErrnoException).code === "ECONNRESET") return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    req.end();

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new Error("timed out waiting for a matching event"));
    }, timeoutMs);
  });
}

const isHeartbeat = (event: ServiceEvent): boolean => event.type === "service.heartbeat";
const isResync = (event: ServiceEvent): boolean => event.type === "stream.resync";

/**
 * Polls `getStates()` until `kind` appears at or after `fromIndex`, or
 * rejects after `timeoutMs`. Used by the liveness/recovery tests below in
 * place of a fresh `subscribe()` per phase, since `EventClient.subscribe`
 * only opens one underlying connection for the client's whole lifetime —
 * one persistent state log, sliced per phase, is the natural fit.
 */
function waitForState(
  getStates: () => EventClientState["kind"][],
  kind: EventClientState["kind"],
  fromIndex: number,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = (): void => {
      const states = getStates();
      if (states.slice(fromIndex).includes(kind)) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(
          new Error(`timed out waiting for state "${kind}"; saw: ${JSON.stringify(states)}`),
        );
        return;
      }
      setTimeout(check, 25);
    };
    check();
  });
}

describe("live push: one event, pushed from the service, received by the same client the plugin uses", () => {
  it("the client receives a heartbeat event whose envelope validates and whose id is 1", async () => {
    await withTempSocketDir(async ({ dir, socketPath }) => {
      const dbPath = join(dir, "operational.db");
      const handle = await startServiceForTest({ socketPath, dbPath });
      try {
        const client = createEventClient({ socketPath, getToken: tokenGetter(socketPath) });

        // The very first connection carries no last-event header, so it
        // always resolves to resync (Task 2) -- the client may see that
        // bootstrap control event before its first real heartbeat; only
        // the heartbeat itself is asserted on here.
        const firstHeartbeat = await new Promise<ServiceEvent>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("timed out waiting for the first heartbeat")),
            5000,
          );
          client.subscribe(
            (event) => {
              if (event.type === "service.heartbeat") {
                clearTimeout(timeout);
                resolve(event);
              }
            },
            () => {},
          );
        });

        expect(firstHeartbeat.id).toBe(1);
        expect(firstHeartbeat.type).toBe("service.heartbeat");
        client.dispose();
      } finally {
        await handle.stop();
      }
    });
  });

  it("GET /api/v1/events with no bearer token returns 401 and establishes no stream", async () => {
    await withTempSocketDir(async ({ dir, socketPath }) => {
      const dbPath = join(dir, "operational.db");
      const handle = await startServiceForTest({ socketPath, dbPath });
      try {
        const client = createSocketApiClient({ socketPath });
        const res = await client.request<unknown>({ method: "GET", path: EVENTS_PATH });
        expect(res.status).toBe(401);
      } finally {
        await handle.stop();
      }
    });
  });
});

describe("recovery: reconnect resumes from a held identifier, or resynchronizes when it has aged out", () => {
  it("reconnecting with an identifier still held replays only the newer events, never a duplicate", async () => {
    await withTempSocketDir(async ({ dir, socketPath }) => {
      const dbPath = join(dir, "operational.db");
      const handle = await startServiceForTest({ socketPath, dbPath });
      try {
        const token = await tokenGetter(socketPath)();

        const firstHeartbeat = await waitForMatchingEvent(socketPath, token, isHeartbeat);
        expect(firstHeartbeat.id).toBe(1);

        // Reconnect presenting id 1 (still well within the default
        // capacity) -- the replay branch (no resync control event mixed
        // in) must deliver only what comes after it, never id 1 itself
        // again.
        const next = await waitForMatchingEvent(socketPath, token, isHeartbeat, firstHeartbeat.id);
        expect(next.id).toBeGreaterThan(firstHeartbeat.id);
      } finally {
        await handle.stop();
      }
    });
  });

  it("publishing past capacity then reconnecting with the now-evicted identifier triggers a resync, and the snapshot's lastEventId is at or beyond the client's own", async () => {
    await withTempSocketDir(async ({ dir, socketPath }) => {
      const dbPath = join(dir, "operational.db");
      // A tiny capacity and a fast heartbeat make eviction observable
      // quickly rather than needing two hundred real heartbeats.
      process.env.CCC_EVENT_BUFFER_CAPACITY = "3";
      process.env.CCC_HEARTBEAT_INTERVAL_MS = "20";
      const handle = await startServiceForTest({ socketPath, dbPath });
      try {
        const handshakeClient = createSocketApiClient({ socketPath });
        const handshake = await handshakeClient.request<HandshakeResponse>({
          method: "POST",
          path: HANDSHAKE_PATH,
        });
        const token = handshake.body.token;

        // At a 20ms heartbeat interval, several heartbeats can already have
        // fired by the time this connection completes (handshake + connect
        // round trip) -- unlike the other tests in this file, the exact
        // starting id doesn't matter here, only that it's a real,
        // known id this connection can later present as stale.
        const firstHeartbeat = await waitForMatchingEvent(socketPath, token, isHeartbeat);
        expect(firstHeartbeat.id).toBeGreaterThan(0);

        // Let enough further heartbeats fire, with nobody subscribed, that
        // this id is evicted well past the capacity-3 buffer's retained range.
        await new Promise((resolve) => setTimeout(resolve, 500));

        const resyncEvent = await waitForMatchingEvent(
          socketPath,
          token,
          isResync,
          firstHeartbeat.id,
        );
        expect(resyncEvent.type).toBe("stream.resync");

        const snapshotRes = await handshakeClient.request<SnapshotResponse>({
          method: "GET",
          path: SNAPSHOT_PATH,
          headers: { [AUTH_HEADER]: `Bearer ${token}` },
        });
        expect(snapshotRes.status).toBe(200);
        expect(snapshotRes.body.lastEventId).toBeGreaterThanOrEqual(resyncEvent.id);
      } finally {
        delete process.env.CCC_EVENT_BUFFER_CAPACITY;
        delete process.env.CCC_HEARTBEAT_INTERVAL_MS;
        await handle.stop();
      }
    });
  });
});

describe("liveness: the client detects the service disappearing with no clean stream close, and recovers automatically on restart", () => {
  // Reproduces the real-world UAT failure: `pnpm run service:uninstall`
  // (launchctl bootout) SIGTERMs the service; the plugin's indicator froze
  // on a stale "Live" line forever and never recovered after the service
  // was reinstalled. `heartbeatIntervalMs: 150` matches the beforeEach's
  // `CCC_HEARTBEAT_INTERVAL_MS`, so the 3x liveness window is ~450ms --
  // fast enough to assert within the test's own timeout, not the
  // production 30s default.
  it("SIGTERM: the client reports disconnected within the liveness window, then recovers to live automatically after restart with no manual re-handshake", async () => {
    await withTempSocketDir(async ({ dir, socketPath }) => {
      const dbPath = join(dir, "operational.db");
      let handle = await startServiceForTest({ socketPath, dbPath });
      const client = createEventClient({
        socketPath,
        getToken: tokenGetter(socketPath),
        heartbeatIntervalMs: 150,
      });
      try {
        const states: EventClientState["kind"][] = [];
        client.subscribe(
          () => {},
          (s) => states.push(s.kind),
        );
        await waitForState(() => states, "live", 0, 5000);

        await handle.stop(); // real SIGTERM, waits for the process to actually exit

        const idxAfterStop = states.length;
        await waitForState(() => states, "disconnected", idxAfterStop, 2000);

        handle = await startServiceForTest({ socketPath, dbPath });

        const idxAfterRestart = states.length;
        await waitForState(() => states, "live", idxAfterRestart, 10_000);
      } finally {
        client.dispose();
        await handle.stop().catch(() => {});
      }
    });
  }, 20_000);

  it("SIGKILL: the same detection and recovery holds with no graceful shutdown at all", async () => {
    await withTempSocketDir(async ({ dir, socketPath }) => {
      const dbPath = join(dir, "operational.db");
      let handle = await startServiceForTest({ socketPath, dbPath });
      const client = createEventClient({
        socketPath,
        getToken: tokenGetter(socketPath),
        heartbeatIntervalMs: 150,
      });
      try {
        const states: EventClientState["kind"][] = [];
        client.subscribe(
          () => {},
          (s) => states.push(s.kind),
        );
        await waitForState(() => states, "live", 0, 5000);

        const pid = handle.pid;
        if (pid === undefined) throw new Error("service pid unavailable");
        process.kill(pid, "SIGKILL");

        const idxAfterKill = states.length;
        await waitForState(() => states, "disconnected", idxAfterKill, 2000);

        handle = await startServiceForTest({ socketPath, dbPath });

        const idxAfterRestart = states.length;
        await waitForState(() => states, "live", idxAfterRestart, 10_000);
      } finally {
        client.dispose();
        await handle.stop().catch(() => {});
      }
    });
  }, 20_000);
});
