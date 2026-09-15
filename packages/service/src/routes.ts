import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import {
  type ApiErrorBody,
  HANDSHAKE_PATH,
  type HandshakeResponse,
  HEALTH_PATH,
  type HealthResponse,
  TOKEN_TTL_MS,
} from "@ccc/domain";
import type { OperationalStore } from "@ccc/operational-store";
import { requireToken } from "./auth/require-token.js";
import { mintToken } from "./auth/token.js";

export interface RouteContext {
  store: OperationalStore;
  /** Returns the per-install secret used to mint and verify bearer tokens. */
  getSecret: () => Buffer;
}

type Handler = (req: IncomingMessage, res: ServerResponse, ctx: RouteContext) => void;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

const healthHandler: Handler = (_req, res, ctx) => {
  const startedAt = ctx.store.readServiceMeta("started_at");
  const serviceVersion = ctx.store.readServiceMeta("service_version") ?? "0.0.0";
  const body: HealthResponse = {
    status: "ok",
    serviceVersion,
    startedAt: startedAt ?? new Date(0).toISOString(),
    schemaVersion: 1,
  };
  sendJson(res, 200, body);
};

/**
 * `POST /api/v1/handshake` is the only route not wrapped in `withAuth`: the
 * socket's `0600` permission is the authorization event for reaching it at
 * all (ADR-0016) — there is nothing the caller could present yet on a
 * first connection. Mints a fresh bearer token every call.
 */
const handshakeHandler: Handler = (_req, res, ctx) => {
  const nowMs = Date.now();
  const token = mintToken(ctx.getSecret(), { nowMs });
  const body: HandshakeResponse = {
    token,
    expiresAt: new Date(nowMs + TOKEN_TTL_MS).toISOString(),
  };
  sendJson(res, 200, body);
};

/** Wraps a route `Handler` in the bearer-token requirement. Every route this plan and later plans add other than the handshake itself is registered through this. */
function withAuth(handler: Handler): Handler {
  return (req, res, ctx) => requireToken(ctx.getSecret, (r, s) => handler(r, s, ctx))(req, res);
}

const routeTable: Record<string, Record<string, Handler>> = {
  [HANDSHAKE_PATH]: { POST: handshakeHandler },
  [HEALTH_PATH]: { GET: withAuth(healthHandler) },
};

/** Builds the request listener the socket server hands to `http.createServer`. */
export function createRequestListener(ctx: RouteContext): RequestListener {
  return (req, res) => {
    const path = req.url ?? "";
    const method = req.method ?? "GET";
    const handler = routeTable[path]?.[method];
    if (!handler) {
      const body: ApiErrorBody = { error: `No route for ${method} ${path}` };
      sendJson(res, 404, body);
      return;
    }
    handler(req, res, ctx);
  };
}
