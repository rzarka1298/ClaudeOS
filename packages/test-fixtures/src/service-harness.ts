import { type ChildProcess, spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVICE_ENTRY = path.resolve(__dirname, "../../service/dist/main.js");

export interface StartServiceForTestOptions {
  socketPath: string;
  /**
   * The operational store's expected path. Not forwarded as an env
   * override — `@ccc/service` always derives it from `CCC_RUNTIME_DIR`
   * (`<runtimeDir>/operational.db`) — but callers pass it so they can
   * open the same file directly once the service is listening.
   */
  dbPath: string;
}

export interface TestServiceHandle {
  pid: number | undefined;
  stop(): Promise<void>;
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
}: StartServiceForTestOptions): Promise<TestServiceHandle> {
  const child: ChildProcess = spawn(process.execPath, [SERVICE_ENTRY], {
    env: {
      ...process.env,
      CCC_SOCKET_PATH: socketPath,
      CCC_RUNTIME_DIR: path.dirname(socketPath),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  await waitForSocket(socketPath);

  return {
    pid: child.pid,
    stop(): Promise<void> {
      return new Promise((resolve) => {
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      });
    },
  };
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
