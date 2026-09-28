import type { IncomingMessage, ServerResponse } from "node:http";
import { basename } from "node:path";
import {
  type ApiErrorBody,
  PROJECT_REGISTER_PATH,
  type ProjectId,
  type ProjectsSnapshot,
  RegisterProjectRequestSchema,
  type RegisterProjectResponse,
} from "@ccc/domain";
import { insertProject } from "@ccc/operational-store";
import { logger } from "../logging.js";
import { readJsonBody } from "../request-body.js";
import {
  type Handler,
  INTERNAL_ERROR_BODY,
  INVALID_BODY_BODY,
  type RouteContext,
  sendJson,
  withAuth,
} from "../route-kit.js";
import { recomputeApprovedRoots } from "./approved-roots.js";
import { ProjectRefusedError, validateProjectCandidate } from "./registration.js";

/**
 * The project routes (PROJ-01, D-04, D-08): register a folder by path, and —
 * once registered — address it by ProjectId only (D-06). Every route is a
 * POST with a strict JSON body wrapped in `withAuth` (ADR-0016), and every
 * refusal is a constant body that names nothing on disk; the specifics stay
 * in the local 0700 log (Shared Pattern 1, D-46). Logs identify a project by
 * its ProjectId, never by its path.
 *
 * The table is a static constant spread into `routes.ts`'s route table
 * (SC-1); handlers receive the running service's project services through
 * `ctx.projects` at call time. When those are absent the registry is still
 * the store, so registration still works — only the live snapshot and
 * refresh are missing.
 */

/** What the project routes and the snapshot need from the running service. */
export interface ProjectServices {
  /** The whole projects picture, read synchronously (the snapshot's `state.projects`). */
  snapshot(): ProjectsSnapshot;
  /** Called after the store's project set or a project's fields changed. */
  onRegistryChanged(): void;
  /** Re-read git state now for one project (or all), without awaiting it (D-42). */
  refresh(projectId?: ProjectId): void;
  /** The home directory displayPaths abbreviate against and protected locations sit under. */
  readonly homeDir: string;
  /** The service's own runtime directory, which can never be a project. */
  readonly runtimeDir: string;
}

/** The one refusal body for a folder that cannot be registered, whatever the reason (D-04). */
export const PROJECT_REFUSED_BODY: ApiErrorBody = { error: "folder cannot be registered" };

/** The longest display name the store accepts (RR-11). */
const MAX_DISPLAY_NAME_LENGTH = 64;

/**
 * The display name a newly registered project starts with: the folder's own
 * name, trimmed to the store's limit. The owner can rename it afterwards.
 */
function defaultDisplayName(resolvedPath: string): string {
  const name = basename(resolvedPath).trim().slice(0, MAX_DISPLAY_NAME_LENGTH).trim();
  return name.length > 0 ? name : "project";
}

/** Logs an unexpected failure by error class only: an fs or sqlite message can carry a path. */
function sendInternalError(res: ServerResponse, route: string, err: unknown): void {
  logger.error(
    { route, errorName: err instanceof Error ? err.name : typeof err },
    "project route failed",
  );
  sendJson(res, 500, INTERNAL_ERROR_BODY);
}

async function handleRegister(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const parsed = await readJsonBody(req, RegisterProjectRequestSchema);
  if (!parsed.ok) {
    logger.warn({ route: PROJECT_REGISTER_PATH, reason: parsed.reason }, "rejected request body");
    sendJson(res, 400, INVALID_BODY_BODY);
    return;
  }
  try {
    const resolved = validateProjectCandidate(parsed.value.path);
    const { created, record } = insertProject(ctx.store.db, {
      path: resolved,
      displayName: defaultDisplayName(resolved),
    });
    if (created) {
      recomputeApprovedRoots(ctx.store);
      ctx.projects?.onRegistryChanged();
    }
    logger.info({ projectId: record.projectId, created }, "project registered");
    const body: RegisterProjectResponse = created
      ? { kind: "registered", projectId: record.projectId }
      : { kind: "already-registered", projectId: record.projectId };
    sendJson(res, 200, body);
  } catch (err: unknown) {
    if (err instanceof ProjectRefusedError) {
      logger.warn({ reason: err.reason, candidate: err.candidate }, "project refused");
      sendJson(res, 422, PROJECT_REFUSED_BODY);
      return;
    }
    sendInternalError(res, PROJECT_REGISTER_PATH, err);
  }
}

const registerHandler: Handler = (req, res, ctx) => {
  // `Handler` is synchronous by contract; every path inside resolves to a
  // written response, so the floating promise carries nothing to act on.
  void handleRegister(req, res, ctx);
};

export const projectRoutes: Record<string, Record<string, Handler>> = {
  [PROJECT_REGISTER_PATH]: { POST: withAuth(registerHandler) },
};
