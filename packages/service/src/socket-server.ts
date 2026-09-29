import { lstatSync, unlinkSync } from "node:fs";
import http, { type Server } from "node:http";
import net from "node:net";

export interface StartSocketServerOptions {
  socketPath: string;
  requestListener: http.RequestListener;
}

/** How long a probe waits for an existing socket to accept a connection. */
export const SOCKET_PROBE_TIMEOUT_MS = 1000;

/**
 * Thrown when another process is already listening on the socket path — a
 * second service instance (a manual `node dist/main.js` beside the
 * LaunchAgent, a test pointed at the real runtime directory). Startup
 * refuses and the live socket file is left exactly where it is.
 */
export class SocketInUseError extends Error {
  readonly socketPath: string;

  constructor(socketPath: string) {
    super(`another process is already listening on ${socketPath}; refusing to start`);
    this.name = "SocketInUseError";
    this.socketPath = socketPath;
  }
}

/**
 * Thrown when the existing socket path cannot be classified as live or
 * stale (the probe timed out, or failed with an unexpected error). Startup
 * refuses rather than guess: deleting a socket a live service still holds
 * is the failure this check exists to prevent.
 */
export class SocketProbeError extends Error {
  readonly code: string;

  constructor(socketPath: string, code: string) {
    super(`could not tell whether ${socketPath} is in use (${code}); refusing to start`);
    this.name = "SocketProbeError";
    this.code = code;
  }
}

/**
 * A connect error that proves nobody is listening: `ECONNREFUSED` (a socket
 * file left by an unclean shutdown), `ENOENT` (it vanished mid-probe) and
 * `ENOTSOCK` (a regular file sits at the path, which no process can be
 * listening on).
 */
const STALE_CODES = new Set(["ECONNREFUSED", "ENOENT", "ENOTSOCK"]);

type ProbeResult =
  | { readonly kind: "live" }
  | { readonly kind: "stale" }
  | { readonly kind: "unknown"; readonly code: string };

function probeSocket(socketPath: string, timeoutMs: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const socket = net.connect({ path: socketPath });
    const settle = (result: ProbeResult): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => settle({ kind: "unknown", code: "ETIMEDOUT" }), timeoutMs);
    socket.once("connect", () => settle({ kind: "live" }));
    socket.once("error", (err: NodeJS.ErrnoException) => {
      const code = err.code ?? "UNKNOWN";
      settle(STALE_CODES.has(code) ? { kind: "stale" } : { kind: "unknown", code });
    });
  });
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Makes `socketPath` free to bind, without ever taking it from a live
 * process: nothing there resolves at once; a live listener throws
 * {@link SocketInUseError} and leaves the file alone; a stale file (nobody
 * listening) is unlinked; anything unclassifiable throws
 * {@link SocketProbeError}.
 */
export async function claimSocketPath(
  socketPath: string,
  { timeoutMs = SOCKET_PROBE_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<void> {
  if (!pathExists(socketPath)) return;
  const probe = await probeSocket(socketPath, timeoutMs);
  if (probe.kind === "live") throw new SocketInUseError(socketPath);
  if (probe.kind === "unknown") throw new SocketProbeError(socketPath, probe.code);
  try {
    unlinkSync(socketPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * Binds an HTTP server to a Unix domain socket at `socketPath`.
 *
 * Order is fixed and load-bearing (ADR-0001; research §Pattern 1 / Pitfall
 * 1): claim the path — refusing if a live service holds it, unlinking a
 * stale socket left by an unclean shutdown ({@link claimSocketPath}) — set
 * the umask to deny group/other access BEFORE `listen()` so the kernel
 * creates the socket file at `0600` atomically, then restore the previous
 * umask. The permission bits must be correct at file-creation time — a
 * `chmod()` call after `listen()` resolves reopens the exact TOCTOU window
 * this ordering exists to close, so this module never does that. It also
 * never binds a numeric port or a network interface: `readableAll` and
 * `writableAll` are left `false`, and `server.listen()` is only ever
 * called with a `path`, never a `port`.
 */
export async function startSocketServer({
  socketPath,
  requestListener,
}: StartSocketServerOptions): Promise<Server> {
  await claimSocketPath(socketPath);

  return new Promise((resolve, reject) => {
    const server = http.createServer(requestListener);

    const previousUmask = process.umask(0o177);
    try {
      server.listen({ path: socketPath, readableAll: false, writableAll: false });
    } finally {
      process.umask(previousUmask);
    }

    server.once("listening", () => resolve(server));
    server.once("error", reject);
  });
}
