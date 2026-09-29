import type { Freshness, ProjectsSnapshot, ServiceEvent, SnapshotResponse } from "@ccc/domain";
import { compareProjectViews, ProjectsUpdatedPayloadSchema } from "@ccc/domain";
import { computed, signal } from "@preact/signals";
import type { ConnectionState } from "../connection-state.js";
import { connectionState } from "../connection-state.js";
import { nowTick } from "../widgets/clock.js";
import type { ProjectRow, ProjectShortcutsData } from "../widgets/panels.js";
import type { WidgetState } from "../widgets/contract.js";

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
 * listed ids, re-sorts with `compareProjectViews` (PROJ-15 — a delta's
 * arrival order is not the display order), and replaces `launchers` only
 * when the delta carries it — keeping the previous value otherwise. A delta arriving before any
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
    projects: [...survivors, ...upserted].sort(compareProjectViews),
    launchers: launchers ?? current.launchers,
  };
}

/** Resets the signal to its initial (unset) value. Test-only. */
export function resetProjectsState(): void {
  projectsSnapshot.value = undefined;
}

/**
 * The `ProjectShortcutsData` live window (D-12): a row observed within this
 * many milliseconds of `now` counts toward an overall `live` freshness.
 * Evaluated against the 60 s {@link nowTick} signal, so in the worst case (a
 * read landing just after one tick) a row can read `live` for up to ~120 s —
 * documented and accepted (RESEARCH Pattern 4), not a bug.
 */
const LIVE_WINDOW_MS = 60_000;

/** Builds the S1 rows from a snapshot, in the one PROJ-15 order (D-43, D-15). */
export function projectRowsFrom(snapshot: ProjectsSnapshot): readonly ProjectRow[] {
  return [...snapshot.projects].sort(compareProjectViews).map((view) => ({
    id: view.projectId,
    name: view.displayName,
    pinned: view.pinned,
    git: view.git,
    gitReadFailed: view.gitReadFailed,
    github: view.github,
    observedAt: view.observedAt,
    // Never populated in Phase 4 (D-15) — Phases 5-7 fill these in.
    openItems: null,
    sessionCount: null,
    nextTask: null,
  }));
}

/** The newest row `observedAt`, or `nowIso` when every row is still `pending`. */
function newestObservedAt(rows: readonly ProjectRow[], nowIso: string): string {
  let newest: string | null = null;
  for (const row of rows) {
    if (row.observedAt !== null && (newest === null || row.observedAt > newest)) {
      newest = row.observedAt;
    }
  }
  return newest ?? nowIso;
}

/**
 * The pure `WidgetState` derivation for the Project shortcuts card
 * (`service-health.tsx`'s `…StateFor` + `computed` pattern).
 *
 * `undefined` snapshot: `loading` while the connection is still resolving,
 * `unavailable` otherwise (live-with-no-snapshot-yet reads the same as
 * disconnected — there is nothing to show either way).
 *
 * A defined snapshot is always `ready`: freshness is `live` only while the
 * connection itself is live AND every row's `observedAt` is within
 * {@link LIVE_WINDOW_MS} of `nowIso` (a `pending` row's `null` observedAt
 * never counts against it); otherwise `stale`. Any row whose last git read
 * failed marks the whole card `Partial`, naming `Local git status` (ADR-0002,
 * D-12) — the row itself keeps its last-good values and gains `◔ Stale` in
 * its own meta (panels.tsx).
 */
export function projectShortcutsStateFor(
  snapshot: ProjectsSnapshot | undefined,
  connection: ConnectionState,
  nowIso: string,
): WidgetState<ProjectShortcutsData> {
  // TDD-RED-STUB(04-07-task1): real derivation lands in the GREEN commit.
  void connection;
  void nowIso;
  return snapshot === undefined ? { kind: "loading" } : { kind: "unavailable" };
}

/** The Project shortcuts card's live signal — replaces `widget-data.ts`'s constant. */
export const projectShortcutsState = computed<WidgetState<ProjectShortcutsData>>(() =>
  projectShortcutsStateFor(
    projectsSnapshot.value,
    connectionState.value,
    new Date(nowTick.value).toISOString(),
  ),
);
