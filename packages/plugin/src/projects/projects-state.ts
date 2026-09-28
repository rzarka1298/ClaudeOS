import type { ProjectsSnapshot, ServiceEvent, SnapshotResponse } from "@ccc/domain";
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

/** RED skeleton — see the GREEN commit for the real implementation. */
export function applyProjectsSnapshot(_snapshot: SnapshotResponse): void {
  throw new Error("applyProjectsSnapshot: not implemented");
}

/** RED skeleton — see the GREEN commit for the real implementation. */
export function applyProjectsDelta(_event: ServiceEvent): void {
  throw new Error("applyProjectsDelta: not implemented");
}

/** Resets the signal to its initial (unset) value. Test-only. */
export function resetProjectsState(): void {
  projectsSnapshot.value = undefined;
}
