import {
  type ApiErrorBody,
  ApiErrorBodySchema,
  type ProjectId,
  type ProjectMutationResponse,
  ProjectMutationResponseSchema,
  PROJECT_REGISTER_PATH,
  PROJECTS_REFRESH_PATH,
  type RegisterProjectResponse,
  RegisterProjectResponseSchema,
} from "@ccc/domain";
import type { SocketApiClient } from "./socket-api-client.js";

/**
 * Typed client helpers for every Phase 4 route (SC-3, D-26, PR-13).
 *
 * The service's refusal bodies are constants by construction (`routes.ts`,
 * `project-routes.ts`), so {@link ProjectsRequestError}'s `message` is safe
 * to display verbatim — unlike `SocketUnreachableError.message`, which
 * embeds the socket path and must never reach the UI; callers classify that
 * one by `errno` instead (SC-3).
 *
 * Every helper here posts a validated body and validates the 200 response
 * with the matching domain schema, exactly like `socket-api-client.ts`'s
 * `postVaultSetupRequest`. This module never runs a timer: the 5 s launch
 * deadline lives in the plugin (plan 04-10), not the client.
 */

export class ProjectsRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ProjectsRequestError";
    this.status = status;
  }
}

const UNRECOGNISED_FAILURE = "The service refused the request.";
const UNRECOGNISED_RESPONSE = "The service returned a response this client does not recognise.";

/** A schema shape, structurally — the same trick `socket-api-client.ts` uses. */
interface ResponseParser<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false };
}

/**
 * The one validating poster every helper in this module is built from:
 * POST `body` to `path`, validate a non-200 as a constant-message refusal,
 * and validate a 200 body against `schema` before returning it.
 */
async function postValidated<T>(
  client: SocketApiClient,
  path: string,
  body: unknown,
  schema: ResponseParser<T>,
): Promise<T> {
  const res = await client.request<unknown>({ method: "POST", path, body });
  if (res.status !== 200) {
    const parsed = ApiErrorBodySchema.safeParse(res.body);
    throw new ProjectsRequestError(
      res.status,
      parsed.success ? (parsed.data as ApiErrorBody).error : UNRECOGNISED_FAILURE,
    );
  }
  const parsed = schema.safeParse(res.body);
  if (!parsed.success) {
    throw new ProjectsRequestError(res.status, UNRECOGNISED_RESPONSE);
  }
  return parsed.data;
}

/** `POST /api/v1/projects/register` — register one folder as a project (PROJ-01). */
export function registerProject(
  client: SocketApiClient,
  path: string,
  opts?: { readonly acknowledgeProtectedLocation?: boolean },
): Promise<RegisterProjectResponse> {
  return postValidated(
    client,
    PROJECT_REGISTER_PATH,
    {
      path,
      ...(opts?.acknowledgeProtectedLocation === undefined
        ? {}
        : { acknowledgeProtectedLocation: opts.acknowledgeProtectedLocation }),
    },
    RegisterProjectResponseSchema,
  );
}

/** `POST /api/v1/projects/refresh` — re-read git state now, for one project or all (D-42). */
export function refreshProjects(
  client: SocketApiClient,
  projectId?: ProjectId,
): Promise<ProjectMutationResponse> {
  return postValidated(
    client,
    PROJECTS_REFRESH_PATH,
    projectId === undefined ? {} : { projectId },
    ProjectMutationResponseSchema,
  );
}
