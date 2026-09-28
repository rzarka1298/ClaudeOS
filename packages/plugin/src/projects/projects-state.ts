import type { ProjectsSnapshot, ServiceEvent, SnapshotResponse } from "@ccc/domain";
import { ProjectsUpdatedPayloadSchema } from "@ccc/domain";
import { signal } from "@preact/signals";

/**
 * The plugin's one in-memory picture of Projects (D-43, D-11).
 *
 * `projectsSnapshot` holds the LAST-GOOD value only, memory only — nothing
 * here is persisted. A malformed snapshot or delta payload is dropped and
 * the previous value is kept (the zod-before-read rule): a service that
 * sends garbage never corrupts what the owner already sees.
 *
 * Plan 04-07 adds the computed per-card widget state derived from this
 * signal; this module owns only ingestion and storage.
 */
export const projectsSnapshot = signal<ProjectsSnapshot | undefined>(undefined);

/** Applies a full-resync snapshot's `projects` field (D-43). */
export function applyProjectsSnapshot(snapshot: SnapshotResponse): void {
  projectsSnapshot.value = snapshot.state.projects;
}

/**
 * Applies a `projects.updated` delta: upserts by `projectId`, removes
 * listed ids, and replaces `launchers` only when the delta carries it —
 * keeping the previous value otherwise. A delta arriving before any
 * snapshot, or one that fails validation, is a no-op (D-11, the
 * zod-before-read rule): the last-good value is kept either way.
 */
export function applyProjectsDelta(event: ServiceEvent): void {
  const current = projectsSnapshot.value;
  if (current === undefined) return;

  const parsed = ProjectsUpdatedPayloadSchema.safeParse(event.payload);
  if (!parsed.success) return;

  const { upserted, removed, launchers } = parsed.data;
  const removedIds = new Set<string>(removed);
  const upsertedIds = new Set(upserted.map((project) => project.projectId));
  const survivors = current.projects.filter(
    (project) => !removedIds.has(project.projectId) && !upsertedIds.has(project.projectId),
  );

  projectsSnapshot.value = {
    projects: [...survivors, ...upserted],
    launchers: launchers ?? current.launchers,
  };
}

/** Resets the signal to its initial (unset) value. Test-only. */
export function resetProjectsState(): void {
  projectsSnapshot.value = undefined;
}
