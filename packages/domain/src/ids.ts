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
 * The stable identifier every durable managed note carries in its
 * frontmatter (VAULT-07). It is the note's identity, not its path: a note
 * may be renamed or moved between lifecycle folders and still be the same
 * note, which is why indexes resolve a note by this ID rather than by
 * title or location.
 */
export type NoteId = Brand<string, "NoteId">;

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

/**
 * Mints a sortable, opaque NoteId using the exact shape {@link newRunId}
 * established: a base-36 millisecond-timestamp prefix (so IDs sort
 * lexicographically by creation time, which is what lets an index order
 * notes without reading every body) followed by a random suffix. Opaque by
 * construction — nothing about the note's title, path, or workspace is
 * recoverable from the ID, so a note can be renamed or moved without its
 * identity changing (VAULT-07, ADR-0021).
 */
export function newNoteId(): NoteId {
  const time = Date.now().toString(36).padStart(9, "0");
  const random = randomUUID().replace(/-/g, "").slice(0, 16);
  return `${time}${random}` as NoteId;
}

/**
 * Mints a sortable, opaque WorkspaceId — same shape as {@link newRunId}
 * and {@link newNoteId}.
 *
 * This function deliberately takes NO arguments, and that absence is the
 * VAULT-09 mechanism rather than an oversight: because no display name (or
 * anything derived from one) can reach the minting site, a later rename
 * cannot change the ID, and therefore cannot change the `workspaces/<id>/`
 * directory the workspace's knowledge lives under. Display names are
 * presentation data held beside the ID (ADR-0005); they never enter a
 * filesystem path.
 */
export function newWorkspaceId(): WorkspaceId {
  const time = Date.now().toString(36).padStart(9, "0");
  const random = randomUUID().replace(/-/g, "").slice(0, 16);
  return `${time}${random}` as WorkspaceId;
}
