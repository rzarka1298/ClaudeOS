import type {
  Freshness,
  ProjectsSnapshot,
  ProjectView,
  ServiceEvent,
  SnapshotResponse,
} from "@ccc/domain";
// `@ccc/domain/browser`, not `@ccc/domain`: this module is reachable from
// `@ccc/plugin`'s public entry, which the visual-regression harness bundles
// for a plain browser page. The full barrel re-exports `path-containment.js`
// (genuine `node:fs` need), which is fatal for that bundle even though
// nothing here uses it (`index.browser.ts`'s docblock has the full story).
import { compareProjectViews, ProjectsUpdatedPayloadSchema } from "@ccc/domain/browser";
import { batch, computed, signal } from "@preact/signals";
import type { ConnectionState } from "../connection-state.js";
import { connectionState } from "../connection-state.js";
import { nowTick } from "../widgets/clock.js";
import type { WidgetState } from "../widgets/contract.js";
import type { ProjectRow, ProjectShortcutsData } from "../widgets/panels.js";

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

/**
 * When the plugin last received projects state from the service (a snapshot
 * or an applied delta) — the honest "last updated" for what the registry
 * itself says while no git read has been observed yet (an empty registry,
 * or a first read that failed). Never used as a git observation time.
 */
export const projectsReceivedAt = signal<string | null>(null);

/** Applies a full-resync snapshot's `projects` field (D-43). */
export function applyProjectsSnapshot(snapshot: SnapshotResponse): void {
  batch(() => {
    projectsSnapshot.value = snapshot.state.projects;
    projectsReceivedAt.value = new Date().toISOString();
  });
}

/**
 * Applies a `projects.updated` delta: upserts by `projectId`, removes
 * listed ids, re-sorts with `compareProjectViews` (PROJ-15 — a delta's
 * arrival order is not the display order), and replaces `launchers` only
 * when the delta carries it — keeping the previous value otherwise. A delta arriving before any
 * snapshot, or one that fails validation, is a no-op (D-11, the
 * zod-before-read rule): the last-good value is kept either way.
 *
 * `observed` (the collector's freshness heartbeat) moves a known row's
 * `observedAt` forward — never backwards, and never onto a row the plugin
 * does not hold — so an unchanged repository the service keeps reading
 * stays `live`, while one it stopped reading ages into `stale`.
 */
export function applyProjectsDelta(event: ServiceEvent): void {
  const current = projectsSnapshot.value;
  if (current === undefined) return;

  const parsed = ProjectsUpdatedPayloadSchema.safeParse(event.payload);
  if (!parsed.success) return;

  const { upserted, removed, launchers, observed } = parsed.data;
  const removedIds = new Set<string>(removed);
  const upsertedIds = new Set(upserted.map((project) => project.projectId));
  const survivors = current.projects.filter(
    (project) => !removedIds.has(project.projectId) && !upsertedIds.has(project.projectId),
  );
  const projects = [...survivors, ...upserted];
  const readAt = new Map((observed ?? []).map((beat) => [beat.projectId, beat.observedAt]));

  batch(() => {
    projectsSnapshot.value = {
      projects: (readAt.size === 0
        ? projects
        : projects.map((view) => withReadAt(view, readAt))
      ).sort(compareProjectViews),
      launchers: launchers ?? current.launchers,
    };
    projectsReceivedAt.value = new Date().toISOString();
  });
}

/** A view with its `observedAt` moved forward to the heartbeat's, when that is newer. */
function withReadAt(view: ProjectView, readAt: ReadonlyMap<string, string>): ProjectView {
  const observedAt = readAt.get(view.projectId);
  if (observedAt === undefined) return view;
  if (view.observedAt !== null && Date.parse(observedAt) <= Date.parse(view.observedAt))
    return view;
  return { ...view, observedAt };
}

/** Resets the signal to its initial (unset) value. Test-only. */
export function resetProjectsState(): void {
  projectsSnapshot.value = undefined;
  projectsReceivedAt.value = null;
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

/** The newest row `observedAt`, or `null` when no row has been observed yet. */
function newestObservedAt(rows: readonly ProjectRow[]): string | null {
  let newest: string | null = null;
  for (const row of rows) {
    if (row.observedAt !== null && (newest === null || row.observedAt > newest)) {
      newest = row.observedAt;
    }
  }
  return newest;
}

/**
 * The pure `WidgetState` derivation for the Project shortcuts card
 * (`service-health.tsx`'s `…StateFor` + `computed` pattern).
 *
 * `undefined` snapshot: `loading` while the connection is still resolving,
 * `unavailable` otherwise (live-with-no-snapshot-yet reads the same as
 * disconnected — there is nothing to show either way).
 *
 * Nothing is ever dated "now" (the widget contract: `observedAt` is a real
 * observation). `observedAt` is the newest row read; when no row has been
 * read yet:
 * - every row still `pending` with its first read in flight is `loading`;
 * - an empty registry, or a first read that failed, is dated by
 *   `receivedAt` — when the registry itself arrived — and is `loading` when
 *   that is unknown too.
 *
 * Freshness is `live` only while the connection itself is live AND every
 * row's `observedAt` is within {@link LIVE_WINDOW_MS} of `nowIso` (a
 * `pending` row's `null` observedAt never counts against it) AND something
 * was actually observed — rows with no read at all are never `live`;
 * otherwise `stale`. An empty registry has no git to observe: it is `live`
 * while connected, since the registry list itself is pushed on every change.
 * Any row whose last git read failed marks the whole card `Partial`, naming
 * `Local git status` (ADR-0002, D-12) — the row itself keeps its last-good
 * values and gains `◔ Stale` in its own meta (panels.tsx).
 */
export function projectShortcutsStateFor(
  snapshot: ProjectsSnapshot | undefined,
  connection: ConnectionState,
  nowIso: string,
  receivedAt: string | null = null,
): WidgetState<ProjectShortcutsData> {
  if (snapshot === undefined) {
    return connection.kind === "connecting" ? { kind: "loading" } : { kind: "unavailable" };
  }

  const rows = projectRowsFrom(snapshot);
  const anyGitReadFailed = rows.some((row) => row.gitReadFailed);
  const newest = newestObservedAt(rows);
  if (newest === null && rows.length > 0 && !anyGitReadFailed) return { kind: "loading" };
  const observedAt = newest ?? receivedAt;
  if (observedAt === null) return { kind: "loading" };

  const nowMs = Date.parse(nowIso);
  const everyRowFresh = rows.every(
    (row) => row.observedAt === null || nowMs - Date.parse(row.observedAt) <= LIVE_WINDOW_MS,
  );
  const observedSomething = newest !== null || rows.length === 0;
  const freshness: Freshness =
    connection.kind === "live" && everyRowFresh && observedSomething ? "live" : "stale";

  return {
    kind: "ready",
    data: { projects: rows, launchers: snapshot.launchers },
    observedAt,
    freshness,
    partiality: anyGitReadFailed
      ? { partial: true, missingSources: ["Local git status"] }
      : { partial: false },
    isEmpty: rows.length === 0,
  };
}

/** The Project shortcuts card's live signal — replaces `widget-data.ts`'s constant. */
export const projectShortcutsState = computed<WidgetState<ProjectShortcutsData>>(() =>
  projectShortcutsStateFor(
    projectsSnapshot.value,
    connectionState.value,
    new Date(nowTick.value).toISOString(),
    projectsReceivedAt.value,
  ),
);
