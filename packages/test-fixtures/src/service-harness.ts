import { type ChildProcess, spawn } from "node:child_process";
import http from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVICE_ENTRY = path.resolve(__dirname, "../../service/dist/main.js");
const REAL_RUNTIME_DIR = path.join(homedir(), ".claude-command-center");

export interface StartServiceForTestOptions {
  socketPath: string;
  /**
   * The operational store's expected path. Not forwarded as an env
   * override — `@ccc/service` always derives it from `CCC_RUNTIME_DIR`
   * (`<runtimeDir>/operational.db`) — but callers pass it so they can
   * open the same file directly once the service is listening.
   */
  dbPath: string;
  /** Extra environment for the child, on top of the test process's own (append-only, 06-21). */
  env?: Record<string, string>;
  /** How many 100 ms polls to wait for the socket (append-only, 06-25): a service that walks a large vault first needs longer than the default five seconds on a loaded machine. */
  waitAttempts?: number;
}

export interface TestServiceHandle {
  pid: number | undefined;
  stop(): Promise<void>;
  /** Ends the service with an uncatchable signal, as a crash would; resolves once it has exited. */
  kill(): Promise<void>;
}

function waitForSocket(socketPath: string, attempts = 50, delayMs = 100): Promise<void> {
  return new Promise((resolve, reject) => {
    const attempt = (remaining: number): void => {
      const req = http.request({ socketPath, path: "/", method: "GET" }, () => {
        req.destroy();
        resolve();
      });
      req.on("error", () => {
        if (remaining <= 0) {
          reject(new Error(`Service socket never became reachable at ${socketPath}`));
          return;
        }
        setTimeout(() => attempt(remaining - 1), delayMs);
      });
      req.end();
    };
    attempt(attempts);
  });
}

/**
 * Spawns the real, built `@ccc/service` entry point as a child process
 * with `CCC_SOCKET_PATH`/`CCC_RUNTIME_DIR` pointed at the fixture
 * directory, polls for the socket to accept a connection with a bounded
 * retry, and returns a handle to stop it. This is the same production
 * `dist/main.js` the launchd LaunchAgent would run — no mocking.
 */
export async function startServiceForTest({
  socketPath,
  env,
  waitAttempts,
}: StartServiceForTestOptions): Promise<TestServiceHandle> {
  // Belt and braces beside the service's own RealRuntimeDirUnderTestError:
  // never even spawn a service aimed at the real runtime directory.
  if (path.resolve(path.dirname(socketPath)) === path.resolve(REAL_RUNTIME_DIR)) {
    throw new Error(
      "startServiceForTest refuses the real runtime directory; use withTempSocketDir.",
    );
  }
  const child: ChildProcess = spawn(process.execPath, [SERVICE_ENTRY], {
    env: {
      ...process.env,
      CCC_SOCKET_PATH: socketPath,
      CCC_RUNTIME_DIR: path.dirname(socketPath),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  await waitForSocket(socketPath, waitAttempts);

  return {
    pid: child.pid,
    stop(): Promise<void> {
      return new Promise((resolve) => {
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      });
    },
    kill(): Promise<void> {
      return new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once("exit", () => resolve());
        child.kill("SIGKILL");
      });
    },
  };
}

/**
 * Like {@link requestOverSocket} with a JSON body (append-only, 06-21): the
 * request helper the approval and task routes need. A non-JSON answer body
 * comes back as `undefined`.
 */
export function requestJsonOverSocket<T>(
  socketPath: string,
  opts: { method: string; path: string; headers?: Record<string, string>; body?: unknown },
): Promise<{ status: number; body: T }> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = { ...opts.headers };
    if (payload !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(payload));
    }
    const req = http.request(
      { socketPath, path: opts.path, method: opts.method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let body: T = undefined as T;
          if (raw.length > 0) {
            try {
              body = JSON.parse(raw) as T;
            } catch {
              body = undefined as T;
            }
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

/** Built on the same `node:http` + `socketPath` shape as the real client. */
export function requestOverSocket<T>(
  socketPath: string,
  opts: { method: string; path: string; headers?: Record<string, string> },
): Promise<{ status: number; body: T }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath, path: opts.path, method: opts.method, headers: opts.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          const body = raw.length > 0 ? (JSON.parse(raw) as T) : (undefined as T);
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}
