import type { IncomingMessage, ServerResponse } from "node:http";
import { basename } from "node:path";
import {
  type ApiErrorBody,
  nextFreeDisplayName,
  PinProjectRequestSchema,
  PROJECT_GITHUB_LINK_PATH,
  PROJECT_PIN_PATH,
  PROJECT_REGISTER_PATH,
  PROJECT_REMOVE_PATH,
  PROJECT_RENAME_PATH,
  PROJECTS_REFRESH_PATH,
  type ProjectId,
  type ProjectMutationResponse,
  type ProjectsSnapshot,
  RefreshProjectsRequestSchema,
  RegisterProjectRequestSchema,
  type RegisterProjectResponse,
  RemoveProjectRequestSchema,
  RenameProjectRequestSchema,
  SetGithubLinkRequestSchema,
} from "@ccc/domain";
import {
  getProject,
  insertProject,
  listProjects,
  type OperationalStore,
  removeProject,
  renameProject,
  setGithubUrlOverride,
  setProjectPinned,
} from "@ccc/operational-store";
import { logger } from "../logging.js";
import { resolveRuntimeDir } from "../paths.js";
import type { BodyParser } from "../request-body.js";
import { readJsonBody } from "../request-body.js";
import {
  type Handler,
  INTERNAL_ERROR_BODY,
  INVALID_BODY_BODY,
  type RouteContext,
  sendJson,
  withAuth,
} from "../route-kit.js";
import { recomputeApprovedRoots, VAULT_ROOT_META_KEY } from "./approved-roots.js";
import { resolveHomeDir } from "./project-views.js";
import {
  detectProtectedLocation,
  ProjectRefusedError,
  type RegistrationPolicyContext,
} from "./registration.js";
import { validateAgainstSettledPolicy } from "./settled-policy.js";

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
  /**
   * The home directory displayPaths abbreviate against and protected
   * locations sit under, in `resolveHomeDir` form (resolved once, D-43).
   */
  readonly homeDir: string;
  /** The service's own runtime directory, which can never be a project. */
  readonly runtimeDir: string;
}

/** The one refusal body for a folder that cannot be registered, whatever the reason (D-04). */
export const PROJECT_REFUSED_BODY: ApiErrorBody = { error: "folder cannot be registered" };

/** The one body for a ProjectId the store does not hold. */
export const NO_SUCH_PROJECT_BODY: ApiErrorBody = { error: "no such project" };

/** Every management route's success body; the new state arrives as a `projects.updated` delta. */
const MUTATION_OK: ProjectMutationResponse = { ok: true };

/**
 * The locations a candidate is judged against. Without project services
 * (a partial composition) the real home and runtime directory apply.
 */
export function policyContext(ctx: RouteContext): RegistrationPolicyContext {
  const vaultRoot = ctx.store.readServiceMeta(VAULT_ROOT_META_KEY);
  return {
    homeDir: ctx.projects?.homeDir ?? resolveHomeDir(),
    runtimeDir: ctx.projects?.runtimeDir ?? resolveRuntimeDir(),
    vaultRoot: vaultRoot !== null && vaultRoot.length > 0 ? vaultRoot : null,
  };
}

/** The longest display name the store accepts (RR-11). */
const MAX_DISPLAY_NAME_LENGTH = 64;

/**
 * The display name a newly registered project starts with: the folder's own
 * name, trimmed to the store's limit — or, when another project already
 * carries that name, `name (2)`, `name (3)`, … (judge ruling: duplicate
 * names). Registration order decides the ordinal because each registration
 * reads the names taken at that moment. The owner can rename it afterwards.
 */
export function defaultDisplayName(
  resolvedPath: string,
  takenNames: ReadonlySet<string> = new Set(),
): string {
  const name = basename(resolvedPath).trim().slice(0, MAX_DISPLAY_NAME_LENGTH).trim();
  return nextFreeDisplayName(name.length > 0 ? name : "project", takenNames);
}

/**
 * Every registered project's display name. Read synchronously right before
 * the insert, with no await between, so two registrations cannot both take
 * the same default name.
 */
export function takenDisplayNames(db: OperationalStore["db"]): Set<string> {
  return new Set(listProjects(db).map((record) => record.displayName));
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
  const policy = policyContext(ctx);
  const acknowledged = parsed.value.acknowledgeProtectedLocation === true;
  // D-29 / PR-10: nothing under a protected folder is read before the owner
  // acknowledges — the lexical check runs before any filesystem call.
  const lexicalLocation = acknowledged
    ? null
    : detectProtectedLocation(parsed.value.path, policy.homeDir);
  if (lexicalLocation !== null) {
    const body: RegisterProjectResponse = { kind: "protected-location", location: lexicalLocation };
    sendJson(res, 200, body);
    return;
  }
  try {
    const resolved = await validateAgainstSettledPolicy(parsed.value.path, policy, () =>
      policyContext(ctx),
    );
    // Nothing below awaits until the row is inserted: the policy just
    // confirmed current is still current at insert time (codex review 2).
    // A symlink outside the protected folders can still resolve into one;
    // the realpath is judged too before anything is stored.
    const resolvedLocation = acknowledged
      ? null
      : detectProtectedLocation(resolved, policy.homeDir);
    if (resolvedLocation !== null) {
      const body: RegisterProjectResponse = {
        kind: "protected-location",
        location: resolvedLocation,
      };
      sendJson(res, 200, body);
      return;
    }
    const { created, record } = insertProject(ctx.store.db, {
      path: resolved,
      displayName: defaultDisplayName(resolved, takenDisplayNames(ctx.store.db)),
    });
    if (created) {
      recomputeApprovedRoots(ctx.store);
      ctx.projects?.onRegistryChanged();
      // Read the new project's git state now, without waiting for it: the
      // reply goes out while git runs, and the result arrives as a
      // `projects.updated` delta (D-42).
      ctx.projects?.refresh(record.projectId);
    }
    logger.info({ projectId: record.projectId, created }, "project registered");
    const body: RegisterProjectResponse = created
      ? { kind: "registered", projectId: record.projectId }
      : { kind: "already-registered", projectId: record.projectId };
    sendJson(res, 200, body);
  } catch (err: unknown) {
    if (err instanceof ProjectRefusedError) {
      logger.warn({ reason: err.reason, candidate: err.candidate }, "project refused");
      // PR-10: TCC refused a candidate that leads into a protected folder
      // through a symlink. Before acknowledgement that is the explanation the
      // owner needs, exactly as for a lexically protected path; after it,
      // macOS blocked the read and the constant refusal stands.
      if (err.protectedLocation !== null && !acknowledged) {
        const body: RegisterProjectResponse = {
          kind: "protected-location",
          location: err.protectedLocation,
        };
        sendJson(res, 200, body);
        return;
      }
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

/**
 * Builds a management handler: parse the strict body (constant 400), apply
 * the store change, answer the constant 404 when the ProjectId is unknown,
 * otherwise tell the project services and answer `{ ok: true }`. None of
 * these handlers touches the filesystem (D-08): remove deletes the store row
 * only, and the folder on disk is never moved, modified or deleted.
 */
function manageHandler<T extends { projectId: ProjectId }>(
  route: string,
  schema: BodyParser<T>,
  apply: (ctx: RouteContext, body: T) => boolean,
  options: { pathSetChanges: boolean },
): Handler {
  const handle = async (req: IncomingMessage, res: ServerResponse, ctx: RouteContext) => {
    const parsed = await readJsonBody(req, schema);
    if (!parsed.ok) {
      logger.warn({ route, reason: parsed.reason }, "rejected request body");
      sendJson(res, 400, INVALID_BODY_BODY);
      return;
    }
    const { projectId } = parsed.value;
    try {
      if (!apply(ctx, parsed.value)) {
        logger.warn({ route, projectId }, "no such project");
        sendJson(res, 404, NO_SUCH_PROJECT_BODY);
        return;
      }
      if (options.pathSetChanges) {
        // D-05: a removed project's files are refused again immediately.
        recomputeApprovedRoots(ctx.store);
      }
      ctx.projects?.onRegistryChanged();
      logger.info({ route, projectId }, "project updated");
      sendJson(res, 200, MUTATION_OK);
    } catch (err: unknown) {
      sendInternalError(res, route, err);
    }
  };
  return withAuth((req, res, ctx) => {
    void handle(req, res, ctx);
  });
}

/**
 * `POST /api/v1/projects/refresh` — queue a git read for one project (or
 * all) and answer at once; the result arrives as a `projects.updated`
 * delta. Every Phase 4 success is a 200, so the client has one success path.
 */
async function handleRefresh(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const parsed = await readJsonBody(req, RefreshProjectsRequestSchema);
  if (!parsed.ok) {
    logger.warn({ route: PROJECTS_REFRESH_PATH, reason: parsed.reason }, "rejected request body");
    sendJson(res, 400, INVALID_BODY_BODY);
    return;
  }
  const { projectId } = parsed.value;
  try {
    if (projectId !== undefined && getProject(ctx.store.db, projectId) === null) {
      sendJson(res, 404, NO_SUCH_PROJECT_BODY);
      return;
    }
    ctx.projects?.refresh(projectId);
    sendJson(res, 200, MUTATION_OK);
  } catch (err: unknown) {
    sendInternalError(res, PROJECTS_REFRESH_PATH, err);
  }
}

const refreshHandler: Handler = (req, res, ctx) => {
  void handleRefresh(req, res, ctx);
};

export const projectRoutes: Record<string, Record<string, Handler>> = {
  [PROJECTS_REFRESH_PATH]: { POST: withAuth(refreshHandler) },
  [PROJECT_REGISTER_PATH]: { POST: withAuth(registerHandler) },
  [PROJECT_REMOVE_PATH]: {
    POST: manageHandler(
      PROJECT_REMOVE_PATH,
      RemoveProjectRequestSchema,
      (ctx, body) => removeProject(ctx.store.db, body.projectId),
      { pathSetChanges: true },
    ),
  },
  [PROJECT_RENAME_PATH]: {
    POST: manageHandler(
      PROJECT_RENAME_PATH,
      RenameProjectRequestSchema,
      (ctx, body) => renameProject(ctx.store.db, body.projectId, body.displayName),
      { pathSetChanges: false },
    ),
  },
  [PROJECT_PIN_PATH]: {
    POST: manageHandler(
      PROJECT_PIN_PATH,
      PinProjectRequestSchema,
      (ctx, body) => setProjectPinned(ctx.store.db, body.projectId, body.pinned),
      { pathSetChanges: false },
    ),
  },
  [PROJECT_GITHUB_LINK_PATH]: {
    POST: manageHandler(
      PROJECT_GITHUB_LINK_PATH,
      SetGithubLinkRequestSchema,
      (ctx, body) => setGithubUrlOverride(ctx.store.db, body.projectId, body.url),
      { pathSetChanges: false },
    ),
  },
};
