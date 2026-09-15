import http from "node:http";

/**
 * Thrown when the socket cannot be reached at all — connection refused, no
 * such file, or a request timeout. Carries the underlying errno so callers
 * can distinguish "service not running" from "service refused."
 */
export class SocketUnreachableError extends Error {
  readonly errno: string | undefined;

  constructor(socketPath: string, cause: NodeJS.ErrnoException) {
    super(`Could not reach the service socket at ${socketPath}: ${cause.message}`);
    this.name = "SocketUnreachableError";
    this.errno = cause.code;
    this.cause = cause;
  }
}

export interface SocketApiClientOptions {
  socketPath: string;
  timeoutMs?: number;
}

export interface SocketRequestOptions {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface SocketResponse<T> {
  status: number;
  body: T;
}

export interface SocketApiClient {
  request<T>(opts: SocketRequestOptions): Promise<SocketResponse<T>>;
}

/**
 * Builds a typed client over `http.request({ socketPath })` — this is the
 * one package permitted to speak the Unix-domain-socket transport
 * directly (research §Recommended Project Structure); the Obsidian plugin
 * imports this client rather than speaking HTTP itself.
 */
export function createSocketApiClient({
  socketPath,
  timeoutMs = 5000,
}: SocketApiClientOptions): SocketApiClient {
  return {
    request<T>(opts: SocketRequestOptions): Promise<SocketResponse<T>> {
      return new Promise((resolve, reject) => {
        const payload = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
        const req = http.request(
          {
            socketPath,
            path: opts.path,
            method: opts.method,
            timeout: timeoutMs,
            headers: {
              ...(payload ? { "Content-Type": "application/json" } : {}),
              ...opts.headers,
            },
          },
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

        req.once("timeout", () => {
          req.destroy();
          const timeoutErr = Object.assign(new Error("request timed out"), {
            code: "ETIMEDOUT",
          }) as NodeJS.ErrnoException;
          reject(new SocketUnreachableError(socketPath, timeoutErr));
        });
        req.once("error", (err: NodeJS.ErrnoException) => {
          reject(new SocketUnreachableError(socketPath, err));
        });

        if (payload) req.write(payload);
        req.end();
      });
    },
  };
}
