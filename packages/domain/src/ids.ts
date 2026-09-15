import { randomUUID } from "node:crypto";

declare const brand: unique symbol;

/** A nominal type helper: `T` branded with the literal string `B`. */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

/**
 * A knowledge scope inside the managed vault, identified by a stable,
 * opaque ID that survives display-name changes (ADR-0005). Distinct from
 * {@link ProjectId} — a Project may bind to exactly one Workspace; a
 * Workspace needs no Project (ADR-0003).
 */
export type WorkspaceId = Brand<string, "WorkspaceId">;

/**
 * A registered directory on disk with a path, git state, and launchers
 * (ADR-0003). Its absolute path is private configuration and never a
 * ProjectId's own shape; the Project-to-Workspace binding lives in the
 * operational store (ADR-0005), never in vault content.
 */
export type ProjectId = Brand<string, "ProjectId">;

/**
 * The service-minted identifier every Run (Session or Automation Run)
 * receives. Per ADR-0006, a Session's Claude-assigned identity is carried
 * separately as a nullable correlation field, never as the primary key —
 * a Run must be able to exist in the store before its Claude session ID is
 * known (SESS-17).
 */
export type RunId = Brand<string, "RunId">;

/**
 * Mints a sortable, opaque, service-side RunId: a millisecond-timestamp
 * prefix (so IDs sort lexicographically by creation time) followed by a
 * random suffix. This is the only minting function in `@ccc/domain` — per
 * ADR-0006 every Run's identity originates here, never from an externally
 * supplied Claude session ID.
 */
export function newRunId(): RunId {
  const time = Date.now().toString(36).padStart(9, "0");
  const random = randomUUID().replace(/-/g, "").slice(0, 16);
  return `${time}${random}` as RunId;
}
