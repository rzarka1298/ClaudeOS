import { existsSync, unlinkSync } from "node:fs";
import http, { type Server } from "node:http";

export interface StartSocketServerOptions {
  socketPath: string;
  requestListener: http.RequestListener;
}

/**
 * Binds an HTTP server to a Unix domain socket at `socketPath`.
 *
 * Order is fixed and load-bearing (ADR-0001; research §Pattern 1 / Pitfall
 * 1): unlink any stale socket file left by an unclean shutdown, set the
 * umask to deny group/other access BEFORE `listen()` so the kernel creates
 * the socket file at `0600` atomically, then restore the previous umask.
 * The permission bits must be correct at file-creation time — a
 * `chmod()` call after `listen()` resolves reopens the exact TOCTOU window
 * this ordering exists to close, so this module never does that. It also
 * never binds a numeric port or a network interface: `readableAll` and
 * `writableAll` are left `false`, and `server.listen()` is only ever
 * called with a `path`, never a `port`.
 */
export function startSocketServer({
  socketPath,
  requestListener,
}: StartSocketServerOptions): Promise<Server> {
  return new Promise((resolve, reject) => {
    if (existsSync(socketPath)) {
      unlinkSync(socketPath);
    }

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
