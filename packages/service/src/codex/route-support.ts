import type { IncomingMessage, ServerResponse } from "node:http";
import type { CodexActionErrorBody } from "@ccc/domain";
import { logger } from "../logging.js";
import {
  type Handler,
  INTERNAL_ERROR_BODY,
  type RouteContext,
  sendJson,
  withAuth,
} from "../route-kit.js";

/**
 * Shared helpers for every Codex route file (plan 05.1-15). A Codex route reads
 * its services through a {@link DepsGetter} instead of naming a `RouteContext`
 * member, so these files compile before `RouteContext.codex` exists (plan 28
 * adds it and passes `(ctx) => ctx.codex?.headroom` and so on).
 */

/** Resolves a route file's dependencies from the request context; undefined when absent. */
export type DepsGetter<D> = (ctx: RouteContext) => D | undefined;

/** The constant 503 body when the Codex services are absent (T-02-19: nothing but a code). */
export const CODEX_UNAVAILABLE_BODY: CodexActionErrorBody = { error: "unavailable" };

export type CodexRouteHandler<D> = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
  deps: D,
) => Promise<void> | void;

/**
 * Composes the bearer-token requirement, the dependency lookup (503 when absent)
 * and a catch-all 500, so a handler body only holds the happy path. `Handler` is
 * synchronous by contract; every path here resolves to a written response.
 */
export function withCodexDeps<D>(getDeps: DepsGetter<D>, handler: CodexRouteHandler<D>): Handler {
  return withAuth((req, res, ctx) => {
    const deps = getDeps(ctx);
    if (deps === undefined) {
      req.resume();
      sendJson(res, 503, CODEX_UNAVAILABLE_BODY);
      return;
    }
    void (async () => {
      try {
        await handler(req, res, ctx, deps);
      } catch (error: unknown) {
        // The error's message and stack can carry a rollout path or a cwd (an ENOENT
        // names the file), so only its class and a short code are logged (T-05.1-23).
        const code = (error as { code?: unknown } | null)?.code;
        logger.error(
          {
            reason: "handler-threw",
            errorName: error instanceof Error ? error.name : "non-error",
            ...(typeof code === "string" && /^[A-Z0-9_-]{1,40}$/.test(code) ? { code } : {}),
          },
          "codex route failed",
        );
        if (!res.headersSent) sendJson(res, 500, INTERNAL_ERROR_BODY);
      }
    })();
  });
}
