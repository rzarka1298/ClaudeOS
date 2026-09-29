import type { ProjectId, ProtectedLocation } from "@ccc/domain";
import {
  pinProject,
  ProjectsRequestError,
  refreshProjects,
  registerProject,
  removeProject,
  renameProject,
  type SocketApiClient,
  SocketUnreachableError,
  setGithubLink,
} from "@ccc/service-api-client";

/**
 * The one outcome every {@link ProjectsActions} method resolves to (Task 1,
 * D-04, D-26, SC-3). Only `register` ever produces `registered`,
 * `already-registered` or `protected-location`; every method can produce the
 * generic `ok` / `refused` / `invalid` / `service-disconnected` / `failed`
 * set. A single shared union — rather than one per method — is what lets a
 * caller (`register-flow.tsx`, `project-manage-toolbar.tsx`) switch on
 * `.kind` with one set of cases instead of five near-identical ones.
 *
 * No method ever rejects: every service or transport failure is caught here
 * and turned into one of these kinds, so a caller never needs a `try/catch`
 * to stay honest about what went wrong (D-26's "never a message with a
 * path" extends to this layer — nothing here carries a message at all).
 */
export type ProjectActionOutcome =
  | { readonly kind: "registered"; readonly projectId: ProjectId }
  | { readonly kind: "already-registered"; readonly projectId: ProjectId }
  | { readonly kind: "protected-location"; readonly location: ProtectedLocation }
  | { readonly kind: "ok" }
  | { readonly kind: "refused" }
  | { readonly kind: "invalid" }
  | { readonly kind: "service-disconnected" }
  | { readonly kind: "failed" };

/**
 * Every project-management action the Projects destination and its register
 * flow need, bound to one authenticated client (Task 1). This is the only
 * seam `packages/plugin/src/view/**` and `packages/plugin/src/widgets/**`
 * reach for `@ccc/service-api-client` behavior through — those directories
 * never import the client package directly (PATTERNS host-seam rule); the
 * view host constructs one real instance via {@link createProjectsActions}.
 */
export interface ProjectsActions {
  /** Registers a folder as a project (D-03, D-04). */
  register(path: string, acknowledgeProtectedLocation?: boolean): Promise<ProjectActionOutcome>;
  /** Removes a project from the registry; never touches disk (D-08). */
  remove(projectId: ProjectId): Promise<ProjectActionOutcome>;
  /** Renames a project's display name (RR-11). */
  rename(projectId: ProjectId, displayName: string): Promise<ProjectActionOutcome>;
  /** Pins or unpins a project (PROJ-15). */
  pin(projectId: ProjectId, pinned: boolean): Promise<ProjectActionOutcome>;
  /** Sets or clears the GitHub link override (RR-12). */
  setGithubLink(projectId: ProjectId, url: string | null): Promise<ProjectActionOutcome>;
  /** Re-reads git state now, for one project or every project (D-42). */
  refresh(projectId?: ProjectId): Promise<ProjectActionOutcome>;
}

/**
 * Classifies a caught failure into the generic slice of
 * {@link ProjectActionOutcome} (SC-3): a `SocketUnreachableError` is
 * classified by `errno` alone — its `.message` embeds the socket path and
 * must never be read — and a `ProjectsRequestError`'s constant-body status
 * separates a policy refusal (422) from a rejected body shape (400).
 * Anything else becomes the generic `failed`.
 */
function classifyFailure(
  error: unknown,
): Extract<ProjectActionOutcome, { kind: "refused" | "invalid" | "service-disconnected" | "failed" }> {
  if (error instanceof SocketUnreachableError) {
    return error.errno === "ECONNREFUSED" || error.errno === "ENOENT"
      ? { kind: "service-disconnected" }
      : { kind: "failed" };
  }
  if (error instanceof ProjectsRequestError) {
    if (error.status === 422) return { kind: "refused" };
    if (error.status === 400) return { kind: "invalid" };
    return { kind: "failed" };
  }
  return { kind: "failed" };
}

/** The production {@link ProjectsActions}, bound to one authenticated client. */
export function createProjectsActions(client: SocketApiClient): ProjectsActions {
  return {
    async register(path, acknowledgeProtectedLocation) {
      try {
        return await registerProject(
          client,
          path,
          acknowledgeProtectedLocation === undefined ? {} : { acknowledgeProtectedLocation },
        );
      } catch (error: unknown) {
        return classifyFailure(error);
      }
    },
    async remove(projectId) {
      try {
        await removeProject(client, { projectId });
        return { kind: "ok" };
      } catch (error: unknown) {
        return classifyFailure(error);
      }
    },
    async rename(projectId, displayName) {
      try {
        await renameProject(client, { projectId, displayName });
        return { kind: "ok" };
      } catch (error: unknown) {
        return classifyFailure(error);
      }
    },
    async pin(projectId, pinned) {
      try {
        await pinProject(client, { projectId, pinned });
        return { kind: "ok" };
      } catch (error: unknown) {
        return classifyFailure(error);
      }
    },
    async setGithubLink(projectId, url) {
      try {
        await setGithubLink(client, { projectId, url });
        return { kind: "ok" };
      } catch (error: unknown) {
        return classifyFailure(error);
      }
    },
    async refresh(projectId) {
      try {
        await refreshProjects(client, projectId);
        return { kind: "ok" };
      } catch (error: unknown) {
        return classifyFailure(error);
      }
    },
  };
}
