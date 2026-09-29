import type { IncomingMessage, ServerResponse } from "node:http";
import { requireToken } from "../auth/require-token.js";
import type { RouteContext } from "../routes.js";

/**
 * The Claude route helpers (PR-18). Phase 4 owns any extraction of the
 * shared route kit out of `routes.ts`, so Phase 5 keeps its own three small
 * helpers here instead of moving code out of that file. They are the same
 * shapes as `routes.ts`'s private `Handler`, `sendJson` and `withAuth`.
 * `RouteContext` is imported type-only, so there is no runtime cycle.
 */
export type ClaudeHandler = (req: IncomingMessage, res: ServerResponse, ctx: RouteContext) => void;

/** Writes `body` as JSON with `status`, exactly as `routes.ts`'s `sendJson` does. */
export function sendClaudeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

/**
 * Wraps a Claude route in the bearer-token requirement, exactly as
 * `routes.ts`'s `withAuth` does. Every Claude route goes through this; only
 * the handshake is ever unwrapped (D-06, ADR-0016).
 */
export function withClaudeAuth(handler: ClaudeHandler): ClaudeHandler {
  return (req, res, ctx) => requireToken(ctx.getSecret, (r, s) => handler(r, s, ctx))(req, res);
}
