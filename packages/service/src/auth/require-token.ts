import type { IncomingMessage, ServerResponse } from "node:http";
import { AUTH_HEADER } from "@ccc/domain";
import { verifyToken } from "./token.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

const UNAUTHENTICATED_BODY = JSON.stringify({ error: "authentication required" });
const BEARER_PREFIX = "Bearer ";

function rejectUnauthenticated(res: ServerResponse, reason: string): void {
  // Plan 01-02 Task 2 wires the redacting pino logger; until then this is
  // the service's only diagnostic signal for a rejected request. The
  // reason itself never carries a credential — only one of "missing",
  // "malformed", "signature", or "expired" — so this line is safe on its
  // own, but it is deliberately never written to the response body below.
  console.warn(`[ccc-service] authentication rejected: ${reason}`);
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(UNAUTHENTICATED_BODY);
}

/**
 * Wraps a route handler so it only runs once the request carries a valid
 * bearer token signed with the per-install secret `getSecret` returns.
 * The 401 body is deliberately identical across every failure reason
 * (missing header, malformed token, wrong signature, expired token) so a
 * caller cannot use the endpoint as an oracle for which part of its token
 * is wrong — the specific reason stays local to the log.
 */
export function requireToken(getSecret: () => Buffer, handler: Handler): Handler {
  return (req, res) => {
    const header = req.headers[AUTH_HEADER];
    const headerValue = Array.isArray(header) ? header[0] : header;
    if (!headerValue || !headerValue.startsWith(BEARER_PREFIX)) {
      rejectUnauthenticated(res, "missing");
      return;
    }
    const token = headerValue.slice(BEARER_PREFIX.length);
    const result = verifyToken(getSecret(), token, { nowMs: Date.now() });
    if (!result.ok) {
      rejectUnauthenticated(res, result.reason);
      return;
    }
    handler(req, res);
  };
}
