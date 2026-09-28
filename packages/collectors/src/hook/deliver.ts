// Imports node: builtins and ./ files only (D-10, purity.test.ts). No
// @ccc/service-api-client: the hook re-implements the two raw requests.
import { appendFileSync, chmodSync, mkdirSync, statSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { HANDSHAKE_PATH, SOCKET_FILE_NAME, SPOOL_DIR_NAME, SPOOL_FILE_NAME } from "./limits.js";

/** Group/other permission bits; any of them set on the spool dir or file is repaired. */
const GROUP_OTHER_PERMISSION_MASK = 0o077;

/** A handshake response larger than this is not the service's; the delivery fails. */
const MAX_HANDSHAKE_RESPONSE_BYTES = 4096;

/**
 * A bearer token shape: printable token characters only, so nothing the
 * socket's peer returns can inject a header line.
 */
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]{1,2048}$/;

export interface DeliverOptions {
  /** ONE deadline across both round trips (handshake, then POST). */
  readonly deadlineMs: number;
}

interface RawResponse {
  readonly status: number;
  readonly body: string;
}

/**
 * Delivers one JSON record to the service over its Unix socket: `POST
 * /api/v1/handshake` for a fresh token, then an authed `POST <path>` (D-06).
 * A single timer covers both round trips; when it fires the in-flight
 * request is destroyed and the result is `false`. Resolves `true` only on a
 * 2xx POST. Never throws, never caches or persists the token, never writes
 * to stdout.
 */
export function deliver(
  runtimeDir: string,
  path: string,
  record: object,
  options: DeliverOptions,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let inFlight: http.ClientRequest | undefined;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      inFlight?.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), Math.max(0, options.deadlineMs));
    const socketPath = join(runtimeDir, SOCKET_FILE_NAME);

    const send = (
      requestPath: string,
      headers: Record<string, string>,
      body: string | undefined,
    ): Promise<RawResponse> =>
      new Promise((resolveResponse, rejectResponse) => {
        const req = http.request(
          { socketPath, path: requestPath, method: "POST", headers },
          (res) => {
            const chunks: Buffer[] = [];
            let received = 0;
            res.on("data", (chunk: Buffer) => {
              received += chunk.length;
              if (received <= MAX_HANDSHAKE_RESPONSE_BYTES) chunks.push(chunk);
            });
            res.on("end", () =>
              resolveResponse({
                status: res.statusCode ?? 0,
                body:
                  received <= MAX_HANDSHAKE_RESPONSE_BYTES
                    ? Buffer.concat(chunks).toString("utf8")
                    : "",
              }),
            );
            res.on("error", rejectResponse);
          },
        );
        inFlight = req;
        req.on("error", rejectResponse);
        req.end(body);
      });

    const run = async (): Promise<boolean> => {
      const handshake = await send(HANDSHAKE_PATH, { "content-length": "0" }, undefined);
      if (handshake.status !== 200) return false;
      const token = (JSON.parse(handshake.body) as { token?: unknown }).token;
      if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return false;
      const body = JSON.stringify(record);
      const post = await send(
        path,
        {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
        },
        body,
      );
      return post.status >= 200 && post.status < 300;
    };

    run().then(finish, () => finish(false));
  });
}

/**
 * Appends one line to `<runtimeDir>/spool/hooks.ndjson`: the spool dir is
 * created `0700` (and repaired to it), the file `0600`, one `appendFileSync`
 * per record (D-08). Returns whether the line was written.
 */
export function appendSpool(runtimeDir: string, line: string): boolean {
  const spoolDir = join(runtimeDir, SPOOL_DIR_NAME);
  mkdirSync(spoolDir, { recursive: true, mode: 0o700 });
  if ((statSync(spoolDir).mode & GROUP_OTHER_PERMISSION_MASK) !== 0) {
    chmodSync(spoolDir, 0o700);
  }
  const text = line.endsWith("\n") ? line : `${line}\n`;
  appendFileSync(join(spoolDir, SPOOL_FILE_NAME), text, { flag: "a", mode: 0o600 });
  return true;
}
