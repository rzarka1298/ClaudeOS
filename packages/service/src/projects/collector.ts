import {
  compareProjectViews,
  type ProjectGitState,
  type ProjectId,
  type ProjectsSnapshot,
  type ProjectsUpdatedPayload,
  type ProjectView,
} from "@ccc/domain";
import type { LauncherConfigRecord, ProjectRecord } from "@ccc/operational-store";
import type { EventBus } from "../events/event-bus.js";
import type { GitRunner } from "./git-runner.js";
import { buildProjectView, launchersSummary } from "./project-views.js";

/**
 * The projects collector (D-11, D-12, D-42, threats T-04-13 and T-04-21):
 * keeps every registered project's view — store fields plus the latest git
 * state — in memory, and tells subscribers when a view changed.
 *
 * When it reads git:
 * - every `intervalMs` (30 s), but only while `eventBus.subscriberCount()`
 *   is above zero — nobody watching means no git processes at all;
 * - immediately for `refresh(projectId?)` (a new registration, an explicit
 *   refresh), subscribers or not.
 * At most `concurrency` (4) reads run at once; a project already queued or
 * in flight is not queued twice.
 *
 * What it publishes: `projects.updated` deltas `{ upserted, removed }`, and
 * only when a view's serialised form changed. The event ring buffer holds
 * 200 events, so publishing the whole list every 30 s would evict the
 * events a reconnecting client needs; the whole list lives in `snapshot()`
 * instead, which `GET /snapshot` reads synchronously.
 *
 * The freshness heartbeat: a successful read that changed nothing still
 * moved `observedAt`, and the plugin must see that or every unchanged row
 * reads stale after a minute. Those reads are batched and published as one
 * `{ upserted: [], removed: [], observed: [{ projectId, observedAt }] }`
 * event when the queue drains — one small event per 30 s tick, the same
 * cadence as `service.heartbeat`. A failed read is never in it, and a
 * stopped collector sends none, so stale still appears when reads stop.
 *
 * Failure: a read that rejects (a git call timed out or failed) keeps the
 * last good git value and sets `gitReadFailed` (ADR-0002: freshness is
 * stated, never implied). Git state is never persisted (D-11); a restart
 * starts every project at `pending`.
 *
 * `refresh` returns immediately and never exposes a promise: no request
 * path ever waits on git (D-42).
 *
 * Rejected alternative: file watchers on every repository. They cost file
 * descriptors per project whether or not anyone is looking, and git's own
 * writes would trigger reads in a loop.
 */

export interface ProjectsCollector {
  start(): void;
  stop(): void;
  /** Queues a git read for one project, or every project when `projectId` is absent. */
  refresh(projectId?: ProjectId): void;
  /** Re-reads the store's project records and publishes what changed (register, remove, rename, pin, link). */
  onRegistryChanged(): void;
  /** A launcher configuration changed (saved, marked tested): publishes the launchers summary. */
  onLaunchersChanged(): void;
  /** The whole projects picture, in the PROJ-15 order. */
  snapshot(): ProjectsSnapshot;
  /**
   * One project's last-good git state from memory, or `null` for an unknown
   * project. Never reads git: the launch path uses it (D-42).
   */
  gitState(projectId: ProjectId): ProjectGitState | null;
}

type IntervalHandle = ReturnType<typeof setInterval>;

export interface ProjectsCollectorOptions {
  readonly eventBus: Pick<EventBus, "publish" | "subscriberCount">;
  readonly gitRunner: GitRunner;
  readonly readRecords: () => readonly ProjectRecord[];
  readonly readLauncherConfigs: () => readonly LauncherConfigRecord[];
  readonly homeDir: string;
  readonly now?: () => Date;
  readonly setInterval?: (callback: () => void, ms: number) => IntervalHandle;
  readonly clearInterval?: (handle: IntervalHandle) => void;
  readonly intervalMs?: number;
  readonly concurrency?: number;
}

interface Entry {
  record: ProjectRecord;
  git: ProjectGitState;
  observedAt: string | null;
  gitReadFailed: boolean;
  /** The serialised view last published (or seeded), for change detection. */
  published: string;
}

const PENDING: ProjectGitState = { kind: "pending" };

export function createProjectsCollector(options: ProjectsCollectorOptions): ProjectsCollector {
  const now = options.now ?? (() => new Date());
  const startInterval = options.setInterval ?? ((cb, ms) => setInterval(cb, ms));
  const stopInterval = options.clearInterval ?? ((handle) => clearInterval(handle));
  const intervalMs = options.intervalMs ?? 30_000;
  const concurrency = Math.max(1, options.concurrency ?? 4);

  const entries = new Map<ProjectId, Entry>();
  const queue: ProjectId[] = [];
  const queued = new Set<ProjectId>();
  const inFlight = new Set<ProjectId>();
  /** Unchanged successful reads since the last drain: the next heartbeat. */
  const observed = new Map<ProjectId, string>();
  let timer: IntervalHandle | null = null;

  const viewOf = (entry: Entry): ProjectView =>
    buildProjectView(
      entry.record,
      entry.git,
      entry.observedAt,
      entry.gitReadFailed,
      options.homeDir,
    );

  const publish = (payload: ProjectsUpdatedPayload): void => {
    if (payload.upserted.length === 0 && payload.removed.length === 0) return;
    options.eventBus.publish("projects.updated", payload);
  };

  /** Publishes the batched heartbeat, dropping projects removed since their read. */
  const flushObserved = (): void => {
    const beats = [...observed]
      .filter(([projectId]) => entries.has(projectId))
      .map(([projectId, observedAt]) => ({ projectId, observedAt }));
    observed.clear();
    if (beats.length === 0) return;
    options.eventBus.publish("projects.updated", { upserted: [], removed: [], observed: beats });
  };

  /**
   * Returns the view if it differs from what was last published, recording
   * it as published. `observedAt` is left out of the comparison: it moves on
   * every read, and counting it would turn every 30 s tick into one event
   * per project. A delta carries the observedAt of the change it reports;
   * the snapshot always carries the latest.
   */
  const takeIfChanged = (entry: Entry): ProjectView | null => {
    const view = viewOf(entry);
    const serialised = JSON.stringify({ ...view, observedAt: null });
    if (serialised === entry.published) return null;
    entry.published = serialised;
    return view;
  };

  /** Brings the in-memory entries in line with the store; returns the delta. */
  const syncRecords = (): ProjectsUpdatedPayload => {
    const records = options.readRecords();
    const seen = new Set<ProjectId>();
    const upserted: ProjectView[] = [];
    for (const record of records) {
      seen.add(record.projectId);
      const existing = entries.get(record.projectId);
      if (existing === undefined) {
        const entry: Entry = {
          record,
          git: PENDING,
          observedAt: null,
          gitReadFailed: false,
          published: "",
        };
        entries.set(record.projectId, entry);
        const view = takeIfChanged(entry);
        if (view !== null) upserted.push(view);
      } else {
        existing.record = record;
        const view = takeIfChanged(existing);
        if (view !== null) upserted.push(view);
      }
    }
    const removed: ProjectId[] = [];
    for (const projectId of [...entries.keys()]) {
      if (!seen.has(projectId)) {
        entries.delete(projectId);
        queued.delete(projectId);
        observed.delete(projectId);
        removed.push(projectId);
      }
    }
    return { upserted, removed };
  };

  const readOne = async (projectId: ProjectId): Promise<void> => {
    const entry = entries.get(projectId);
    if (entry === undefined) return;
    const root = entry.record.path;
    let next: ProjectGitState | null = null;
    try {
      next = await options.gitRunner.readProject(root);
    } catch {
      next = null;
    }
    // The project may have been removed (or re-registered) while git ran.
    const current = entries.get(projectId);
    if (current === undefined || current.record.path !== root) return;
    if (next === null) {
      current.gitReadFailed = true;
    } else {
      current.git = next;
      current.observedAt = now().toISOString();
      current.gitReadFailed = false;
    }
    const view = takeIfChanged(current);
    if (view !== null) {
      // The upsert carries this read's observedAt itself.
      observed.delete(projectId);
      publish({ upserted: [view], removed: [] });
    } else if (next !== null && current.observedAt !== null) {
      observed.set(projectId, current.observedAt);
    }
  };

  const pump = (): void => {
    while (inFlight.size < concurrency && queue.length > 0) {
      const projectId = queue.shift();
      if (projectId === undefined) break;
      queued.delete(projectId);
      if (!entries.has(projectId) || inFlight.has(projectId)) continue;
      inFlight.add(projectId);
      void readOne(projectId).finally(() => {
        inFlight.delete(projectId);
        pump();
        if (inFlight.size === 0 && queue.length === 0) flushObserved();
      });
    }
  };

  const enqueue = (projectId: ProjectId): void => {
    if (queued.has(projectId) || inFlight.has(projectId)) return;
    queued.add(projectId);
    queue.push(projectId);
  };

  const refresh = (projectId?: ProjectId): void => {
    if (projectId === undefined) {
      for (const id of entries.keys()) enqueue(id);
    } else if (entries.has(projectId)) {
      enqueue(projectId);
    }
    pump();
  };

  // Seed from the store so the first snapshot lists every project as pending.
  syncRecords();

  return {
    start() {
      if (timer !== null) return;
      timer = startInterval(() => {
        if (options.eventBus.subscriberCount() > 0) refresh();
      }, intervalMs);
    },
    stop() {
      if (timer === null) return;
      stopInterval(timer);
      timer = null;
    },
    refresh,
    onRegistryChanged() {
      publish(syncRecords());
    },
    onLaunchersChanged() {
      // Always published, even with no project change: the summary is what
      // the toolbar and the setup callout read (RR-26).
      options.eventBus.publish("projects.updated", {
        upserted: [],
        removed: [],
        launchers: launchersSummary(options.readLauncherConfigs()),
      });
    },
    gitState(projectId) {
      return entries.get(projectId)?.git ?? null;
    },
    snapshot() {
      const projects = [...entries.values()].map(viewOf).sort(compareProjectViews);
      return { projects, launchers: launchersSummary(options.readLauncherConfigs()) };
    },
  };
}
