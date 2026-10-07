import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import http from "node:http";
import {
  AUTH_HEADER,
  EVENTS_PATH,
  HANDSHAKE_PATH,
  type HandshakeResponse,
  type ServiceEvent,
  ServiceEventSchema,
} from "@ccc/domain";
import { requestJsonOverSocket, requestOverSocket } from "./service-harness.js";

/**
 * Shared support for the approval integration tests (plan 06-21): the
 * throwaway Keychain account convention, the raw event collector, and an
 * authenticated JSON request helper. Test support only.
 */

const KEYCHAIN_SERVICE_NAME = "com.claude-command-center";
const ITEM_NOT_FOUND_EXIT_CODE = 44;

/** Sets the throwaway install-secret account and the short timers; returns the account name. */
export function setUpServiceEnvironment(extra: Record<string, string> = {}): string {
  const account = `install-secret-test-${randomBytes(6).toString("hex")}`;
  process.env.CCC_INSTALL_SECRET_ACCOUNT = account;
  process.env.CCC_HEARTBEAT_INTERVAL_MS = "150";
  process.env.CCC_LIVENESS_SWEEP_MS = "200";
  process.env.CCC_LIVENESS_GRACE_MS = "500";
  for (const [key, value] of Object.entries(extra)) process.env[key] = value;
  return account;
}

/** Removes the environment and deletes the throwaway Keychain item. */
export function tearDownServiceEnvironment(account: string, extraKeys: string[] = []): void {
  for (const key of [
    "CCC_INSTALL_SECRET_ACCOUNT",
    "CCC_HEARTBEAT_INTERVAL_MS",
    "CCC_LIVENESS_SWEEP_MS",
    "CCC_LIVENESS_GRACE_MS",
    "CLAUDE_CONFIG_DIR",
    ...extraKeys,
  ]) {
    delete process.env[key];
  }
  try {
    execFileSync(
      "security",
      ["delete-generic-password", "-a", account, "-s", KEYCHAIN_SERVICE_NAME],
      { stdio: "ignore" },
    );
  } catch (err: unknown) {
    const status = (err as { status?: number }).status;
    if (status !== ITEM_NOT_FOUND_EXIT_CODE) throw err;
  }
}

export async function handshake(socketPath: string): Promise<string> {
  const res = await requestOverSocket<HandshakeResponse>(socketPath, {
    method: "POST",
    path: HANDSHAKE_PATH,
  });
  return res.body.token;
}

/** An authenticated JSON request; `headers` may add the decision-channel header. */
export function authedRequest<T>(
  socketPath: string,
  token: string,
  opts: { method: string; path: string; body?: unknown; headers?: Record<string, string> },
): Promise<{ status: number; body: T }> {
  return requestJsonOverSocket<T>(socketPath, {
    method: opts.method,
    path: opts.path,
    body: opts.body,
    headers: { [AUTH_HEADER]: `Bearer ${token}`, ...opts.headers },
  });
}

export interface EventCollector {
  readonly events: ServiceEvent[];
  waitFor(predicate: (event: ServiceEvent) => boolean, timeoutMs: number): Promise<ServiceEvent>;
  close(): void;
}

/** One long-lived subscription to the raw event stream. */
export function collectEvents(socketPath: string, token: string): EventCollector {
  const events: ServiceEvent[] = [];
  const waiters = new Set<() => void>();
  const headers: Record<string, string> = { [AUTH_HEADER]: `Bearer ${token}` };
  const req = http.request({ socketPath, path: EVENTS_PATH, method: "GET", headers }, (res) => {
    let buffer = "";
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      buffer += chunk;
      let idx = buffer.indexOf("\n\n");
      while (idx !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLine = raw.match(/^data: (.+)$/m);
        if (dataLine) {
          const parsed = ServiceEventSchema.safeParse(JSON.parse(dataLine[1] as string));
          if (parsed.success) events.push(parsed.data);
        }
        idx = buffer.indexOf("\n\n");
      }
      for (const wake of waiters) wake();
    });
  });
  req.on("error", () => {});
  req.end();

  return {
    events,
    waitFor(predicate, timeoutMs) {
      return new Promise((resolveWait, reject) => {
        const check = (): boolean => {
          const hit = events.find(predicate);
          if (hit === undefined) return false;
          waiters.delete(wake);
          clearTimeout(timer);
          resolveWait(hit);
          return true;
        };
        const wake = (): void => {
          check();
        };
        const timer = setTimeout(() => {
          waiters.delete(wake);
          reject(new Error(`no matching event within ${timeoutMs} ms`));
        }, timeoutMs);
        if (!check()) waiters.add(wake);
      });
    },
    close() {
      req.destroy();
    },
  };
}
