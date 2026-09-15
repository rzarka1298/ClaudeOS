import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { API_BASE, type ApiErrorBody, type HealthResponse } from "@ccc/domain";
import type { OperationalStore } from "@ccc/operational-store";

export interface RouteContext {
  store: OperationalStore;
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

/** `GET /api/v1/health` is the only route the walking skeleton registers. */
const routeTable: Record<string, Record<string, Handler>> = {
  [`${API_BASE}/health`]: { GET: healthHandler },
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
