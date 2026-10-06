import { linkSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Test-only helpers for the hook and status-line wrapper tests. They live in
 * this package (not `@ccc/test-fixtures`) because collectors may import
 * `@ccc/domain` only (eslint.config.mjs), and a collectors test is still a
 * collectors file.
 */

/** macOS `sun_path` cap (ADR-0001); the fixture must respect what the code under test asserts. */
const SUN_PATH_MAX_BYTES = 104;

/**
 * A short, fixed base under `$HOME`, deliberately not `os.tmpdir()` — the
 * randomized macOS `$TMPDIR` is exactly what breaks the `sun_path` cap. Same
 * base as `packages/test-fixtures/src/socket-fixture.ts`.
 */
const TEST_BASE = join(homedir(), ".ccc-test");

/** The token the recording server mints; asserted on the authed request. */
export const TEST_SERVER_TOKEN = "test-token.abc123";

/** How a recording server answers. */
export type UdsServerMode = "accept" | "stall" | "status500";

/** One request the recording server saw, body as UTF-8 text. */
export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

export interface UdsTestServer {
  readonly socketPath: string;
  /** Every request seen so far, in arrival order (recorded once its body ends). */
  readonly requests: RecordedRequest[];
  /** How many requests have started arriving (a stalled request counts before its body ends). */
  readonly started: () => number;
  close(): Promise<void>;
}

/** A fresh short runtime dir under `~/.ccc-test/`, with the socket path it implies. */
export interface TestRuntimeDir {
  readonly dir: string;
  readonly socketPath: string;
  remove(): void;
}

/**
 * Creates a short-path runtime dir and asserts that the socket path under it
 * stays below the `sun_path` cap. The caller removes it (afterEach).
 */
export function makeTestRuntimeDir(): TestRuntimeDir {
  mkdirSync(TEST_BASE, { recursive: true });
  const dir = mkdtempSync(join(TEST_BASE, "h-"));
  const socketPath = join(dir, "svc.sock");
  const byteLength = Buffer.byteLength(socketPath);
  if (byteLength >= SUN_PATH_MAX_BYTES) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`Test socket path is ${byteLength} bytes, at or above the cap: ${socketPath}`);
  }
  return {
    dir,
    socketPath,
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * A small `node:http` server on a Unix socket that records every request.
 * - `accept`: the handshake answers `200 { token, expiresAt }`, every other
 *   route answers `202 {}`.
 * - `stall`: accepts the connection and the request, and never answers.
 * - `status500`: answers every request with `500`.
 */
export function startUdsTestServer(
  socketPath: string,
  mode: UdsServerMode,
): Promise<UdsTestServer> {
  const requests: RecordedRequest[] = [];
  let started = 0;
  const server = http.createServer((req, res) => {
    started += 1;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (mode === "stall") {
        return;
      }
      if (mode === "status500") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end('{"error":"internal"}');
        return;
      }
      if (req.url === "/api/v1/handshake") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            token: TEST_SERVER_TOKEN,
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          }),
        );
        return;
      }
      res.writeHead(202, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      resolve({
        socketPath,
        requests,
        started: () => started,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

/**
 * Leaves a real socket file at `socketPath` with nothing listening, so a
 * connect fails with `ECONNREFUSED` (a crashed service's stale socket). A
 * server's `close()` unlinks its socket, so a hard link taken while it
 * listens is what survives.
 */
export function createStaleSocket(socketPath: string): Promise<void> {
  const liveSocketPath = `${socketPath}.live`;
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(liveSocketPath, () => {
      linkSync(liveSocketPath, `${socketPath}.stale`);
      server.close(() => {
        renameSync(`${socketPath}.stale`, socketPath);
        resolve();
      });
    });
  });
}
