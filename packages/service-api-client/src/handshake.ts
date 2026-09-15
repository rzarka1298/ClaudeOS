import { AUTH_HEADER, HANDSHAKE_PATH, type HandshakeResponse } from "@ccc/domain";
import {
  createSocketApiClient,
  type SocketApiClient,
  type SocketRequestOptions,
  type SocketResponse,
} from "./socket-api-client.js";

/** Re-handshake once fewer than this many milliseconds remain on the cached token. */
const REHANDSHAKE_MARGIN_MS = 5 * 60 * 1000;

export interface AuthenticatedSocketApiClient extends SocketApiClient {
  /** Drops the cached token, forcing the next request to re-handshake first. */
  invalidateToken(): void;
}

export interface CreateAuthenticatedClientOptions {
  socketPath: string;
  timeoutMs?: number;
}

/**
 * Wraps the plan 01-01 {@link createSocketApiClient} with automatic token
 * acquisition and refresh: calls `POST /api/v1/handshake` on first use,
 * caches the token with its expiry, re-handshakes when fewer than five
 * minutes remain or when a request comes back 401, and attaches
 * `authorization: Bearer <token>` to every request. Token values live in
 * memory for the process lifetime only — this client never writes one to
 * disk. `invalidateToken()` lets the caller (e.g. the plugin's
 * `onunload()`) proactively drop its token.
 */
export function createAuthenticatedClient({
  socketPath,
  timeoutMs,
}: CreateAuthenticatedClientOptions): AuthenticatedSocketApiClient {
  const inner =
    timeoutMs === undefined
      ? createSocketApiClient({ socketPath })
      : createSocketApiClient({ socketPath, timeoutMs });
  let cachedToken: string | undefined;
  let cachedExpiresAtMs: number | undefined;

  function invalidateToken(): void {
    cachedToken = undefined;
    cachedExpiresAtMs = undefined;
  }

  async function ensureToken(): Promise<string> {
    const now = Date.now();
    if (cachedToken && cachedExpiresAtMs && cachedExpiresAtMs - now > REHANDSHAKE_MARGIN_MS) {
      return cachedToken;
    }
    const res = await inner.request<HandshakeResponse>({
      method: "POST",
      path: HANDSHAKE_PATH,
    });
    cachedToken = res.body.token;
    cachedExpiresAtMs = new Date(res.body.expiresAt).getTime();
    return cachedToken;
  }

  return {
    invalidateToken,
    async request<T>(opts: SocketRequestOptions): Promise<SocketResponse<T>> {
      const token = await ensureToken();
      const res = await inner.request<T>({
        ...opts,
        headers: { ...opts.headers, [AUTH_HEADER]: `Bearer ${token}` },
      });
      if (res.status === 401) {
        invalidateToken();
        const retryToken = await ensureToken();
        return inner.request<T>({
          ...opts,
          headers: { ...opts.headers, [AUTH_HEADER]: `Bearer ${retryToken}` },
        });
      }
      return res;
    },
  };
}
