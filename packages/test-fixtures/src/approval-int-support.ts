import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import http from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUTH_HEADER,
  EVENTS_PATH,
  HANDSHAKE_PATH,
  type HandshakeResponse,
  type ServiceEvent,
  ServiceEventSchema,
  SessionUpsertedPayloadSchema,
  type SessionView,
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

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPILED_HOOK = resolve(HERE, "../../collectors/dist/hook/entry.js");

/** Throwaway children this test run spawned; only these are ever signalled. */
export const sacrificialChildren: ChildProcess[] = [];

/** Kills (SIGKILL) every throwaway child that is still running. */
export function reapSacrificialChildren(): void {
  for (const child of sacrificialChildren.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

/** A harmless idle `node` process standing in for a Claude process. */
export async function spawnSacrificialChild(): Promise<ChildProcess & { pid: number }> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  sacrificialChildren.push(child);
  await new Promise<void>((resolveSpawn, reject) => {
    child.once("spawn", () => resolveSpawn());
    child.once("error", reject);
  });
  if (child.pid === undefined) throw new Error("child has no pid");
  return child as ChildProcess & { pid: number };
}

/** True while the child has neither exited nor been signalled to death. */
export function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

/** Resolves when the child exits, or rejects after `timeoutMs`. */
export function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolveExit, reject) => {
    if (!isRunning(child)) {
      resolveExit();
      return;
    }
    const timer = setTimeout(() => reject(new Error("child did not exit in time")), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}

/** Runs the compiled hook once, exactly as Claude Code spawns it, with CLAUDE_PID = `pid`. */
export async function runHook(
  runtimeDir: string,
  pid: number,
  record: Record<string, unknown>,
): Promise<void> {
  const child = spawn(process.execPath, [COMPILED_HOOK, "--runtime-dir", runtimeDir], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/",
      CLAUDE_PID: String(pid),
    },
    stdio: ["pipe", "ignore", "ignore"],
  });
  const done = new Promise<void>((resolveDone) => child.once("close", () => resolveDone()));
  child.stdin.end(JSON.stringify(record));
  await done;
}

export function sessionStartRecord(sessionId: string, cwd: string): Record<string, unknown> {
  return {
    session_id: sessionId,
    cwd,
    permission_mode: "default",
    model: "claude-test-model",
    hook_event_name: "SessionStart",
    source: "startup",
  };
}

export function sessionOf(event: ServiceEvent): SessionView | null {
  if (event.type !== "session.upserted") return null;
  const parsed = SessionUpsertedPayloadSchema.safeParse(event.payload);
  return parsed.success ? parsed.data.session : null;
}
