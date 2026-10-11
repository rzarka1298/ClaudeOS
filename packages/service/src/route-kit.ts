import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiErrorBody } from "@ccc/domain";
import type { OperationalStore } from "@ccc/operational-store";
import type { ApprovalServices } from "./approval-wiring/types.js";
import { requireToken } from "./auth/require-token.js";
import type { ClaudeRouteDeps } from "./claude/routes.js";
import type { CodexRouteDeps } from "./codex/routes.js";
import type { EventBus } from "./events/event-bus.js";
import type { LaunchService } from "./projects/launch-service.js";
import type { LauncherServices } from "./projects/launcher-routes.js";
import type { ProjectServices } from "./projects/project-routes.js";
import type { ScanService } from "./projects/scan.js";
import type { TaskServices } from "./tasks/types.js";

/**
 * The shared route toolkit: the handler type, the request context, the JSON
 * writer, the bearer-token wrapper and the constant error bodies every route
 * file uses (SC-1).
 *
 * Extracted verbatim from `routes.ts` so a feature's routes can live in their
 * own file (`projects/project-routes.ts` now, Phase 5's session routes next)
 * and be spread into the one route table. Rejected alternative: each feature
 * file exporting a `routes(ctx)` factory that `routes.ts` calls. The table is
 * a module-level constant built before any context exists, and a factory that
 * imported back from `routes.ts` would form an import cycle; handlers receive
 * the context at call time instead, exactly as they always have.
 */

/**
 * What every handler receives. `projects` is optional (SC-2, under
 * `exactOptionalPropertyTypes`) so a context built without project services —
 * every Phase 1-3 test, and any future partial composition — still compiles
 * and behaves as before: the snapshot answers the empty projects state.
 */
export interface RouteContext {
  store: OperationalStore;
  /** Returns the per-install secret used to mint and verify bearer tokens. */
  getSecret: () => Buffer;
  eventBus: EventBus;
  /** The live project services (snapshot, refresh, registry-change hook); plan 04-04. */
  readonly projects?: ProjectServices | undefined;
  /** The launch pipeline behind `POST /api/v1/projects/launch`; plan 04-06. */
  readonly launch?: LaunchService | undefined;
  /** Detection, launcher setup, Test launches and the System Settings panes; plan 04-11. */
  readonly launchers?: LauncherServices | undefined;
  /** Scan folders and their in-memory suggestions (PROJ-02, PROJ-03, D-07); plan 04-13. */
  readonly scan?: ScanService | undefined;
  /** The Claude session pipeline (Phase 5). Absent in an older composition: its routes answer 503. */
  readonly claude?: ClaudeRouteDeps | undefined;
  /** The approval inbox services (Phase 6, D-28). Absent: its routes answer 503 and the snapshot omits the member. */
  readonly approvals?: ApprovalServices | undefined;
  /** The task store services (Phase 6, D-28). Absent: its routes answer 503. */
  readonly tasks?: TaskServices | undefined;
  /**
   * The Codex services (Phase 05.1, D-25), appended after the Phase 6 members.
   * Absent: every Codex route answers the constant 503 and the snapshot omits
   * the optional `codex` member.
   */
  readonly codex?: CodexRouteDeps | undefined;
}

export type Handler = (req: IncomingMessage, res: ServerResponse, ctx: RouteContext) => void;

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

/** Wraps a route `Handler` in the bearer-token requirement. Every route this plan and later plans add other than the handshake itself is registered through this. */
export function withAuth(handler: Handler): Handler {
  return (req, res, ctx) => requireToken(ctx.getSecret, (r, s) => handler(r, s, ctx))(req, res);
}

/**
 * Constant error bodies shared by every route file. None names a directory,
 * a file, or any part of this machine's filesystem layout; the specifics stay
 * in the local redacting log (threat T-02-19).
 */
export const INVALID_BODY_BODY: ApiErrorBody = { error: "invalid request body" };
export const INTERNAL_ERROR_BODY: ApiErrorBody = { error: "internal error" };
