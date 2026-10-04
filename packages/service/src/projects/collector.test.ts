import {
  compareProjectViews,
  type ProjectGitState,
  type ProjectId,
  ProjectsUpdatedPayloadSchema,
  type ServiceEventType,
} from "@ccc/domain";
import type { LauncherConfigRecord, ProjectRecord } from "@ccc/operational-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectsCollector } from "./collector.js";
import type { GitRunner } from "./git-runner.js";

const HOME = "/Users/USERNAME";

function id(n: number): ProjectId {
  return `abcdefghi${n.toString(16).padStart(16, "0")}` as ProjectId;
}

function record(n: number, overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    projectId: id(n),
    path: `${HOME}/code/example-project-${n}`,
    displayName: `example-project-${n}`,
    pinned: false,
    lastOpenedAt: null,
    githubUrlOverride: null,
    registeredAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function repoState(branch: string): ProjectGitState {
  return { kind: "repo", branch, detached: false, dirty: false, commits: [], remote: null };
}

interface Published {
  type: ServiceEventType;
  payload: unknown;
}

let records: ProjectRecord[];
let subscribers: number;
let published: Published[];
let reads: string[];
let inFlight: number;
let maxInFlight: number;
let answer: (root: string) => Promise<ProjectGitState>;

const gitRunner: GitRunner = {
  async readProject(root) {
    reads.push(root);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      return await answer(root);
    } finally {
      inFlight -= 1;
    }
  },
};

function makeCollector() {
  return createProjectsCollector({
    eventBus: {
      publish: (type, payload) => {
        published.push({ type, payload });
        return { id: published.length, type, occurredAt: "2026-09-01T00:00:00.000Z", payload };
      },
      subscriberCount: () => subscribers,
    },
    gitRunner,
    readRecords: () => records,
    readLauncherConfigs: (): LauncherConfigRecord[] => [],
    homeDir: HOME,
    now: () => new Date("2026-09-01T00:00:00.000Z"),
  });
}

/** Lets queued promise callbacks (the fake reads and the collector's bookkeeping) run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  records = [record(1), record(2)];
  subscribers = 0;
  published = [];
  reads = [];
  inFlight = 0;
  maxInFlight = 0;
  answer = () => Promise.resolve(repoState("main"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createProjectsCollector: when it reads (D-11)", () => {
  it("reads nothing on the interval while nobody is subscribed", async () => {
    const collector = makeCollector();
    collector.start();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(reads).toEqual([]);
    collector.stop();
  });

  it("reads every project once per 30 s while a subscriber is listening", async () => {
    subscribers = 1;
    const collector = makeCollector();
    collector.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reads.sort()).toEqual(records.map((r) => r.path).sort());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reads).toHaveLength(4);
    collector.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads).toHaveLength(4);
  });

  it("keeps at most four reads in flight", async () => {
    records = Array.from({ length: 9 }, (_, i) => record(i + 1));
    const pending: Array<() => void> = [];
    answer = () =>
      new Promise((resolve) => {
        pending.push(() => resolve(repoState("main")));
      });
    const collector = makeCollector();
    collector.refresh();
    await settle();
    expect(inFlight).toBe(4);
    while (pending.length > 0) {
      pending.shift()?.();
      await settle();
    }
    expect(reads).toHaveLength(9);
    expect(maxInFlight).toBe(4);
  });

  it("refresh(projectId) reads that project immediately, subscribers or not", async () => {
    const collector = makeCollector();
    collector.refresh(id(2));
    await settle();
    expect(reads).toEqual([record(2).path]);
  });
});

describe("createProjectsCollector: what it publishes (D-12, RESEARCH Pattern 4)", () => {
  it("publishes a change as one upserted delta and an unchanged re-read as a heartbeat only", async () => {
    const collector = makeCollector();
    collector.refresh(id(1));
    await settle();
    expect(published).toHaveLength(1);
    const first = ProjectsUpdatedPayloadSchema.parse(published[0]?.payload);
    expect(published[0]?.type).toBe("projects.updated");
    expect(first.removed).toEqual([]);
    expect(first.upserted.map((v) => v.projectId)).toEqual([id(1)]);
    expect(first.upserted[0]?.git).toEqual(repoState("main"));
    expect(first.upserted[0]?.displayPath).toBe("~/code/example-project-1");

    // An unchanged re-read carries no upsert — only the observed heartbeat.
    collector.refresh(id(1));
    await settle();
    expect(published).toHaveLength(2);
    expect(ProjectsUpdatedPayloadSchema.parse(published[1]?.payload)).toEqual({
      upserted: [],
      removed: [],
      observed: [{ projectId: id(1), observedAt: "2026-09-01T00:00:00.000Z" }],
    });

    answer = () => Promise.resolve(repoState("feature"));
    collector.refresh(id(1));
    await settle();
    expect(published).toHaveLength(3);
    const second = ProjectsUpdatedPayloadSchema.parse(published[2]?.payload);
    expect(second).toEqual({
      upserted: [expect.objectContaining({ projectId: id(1), git: repoState("feature") })],
      removed: [],
    });
  });

  it("publishes only the new observedAt (no upsert) for an unchanged re-read", async () => {
    let clock = Date.parse("2026-09-01T00:00:00.000Z");
    const collector = createProjectsCollector({
      eventBus: {
        publish: (type, payload) => {
          published.push({ type, payload });
          return { id: published.length, type, occurredAt: "2026-09-01T00:00:00.000Z", payload };
        },
        subscriberCount: () => subscribers,
      },
      gitRunner,
      readRecords: () => records,
      readLauncherConfigs: (): LauncherConfigRecord[] => [],
      homeDir: HOME,
      now: () => new Date(clock),
    });
    collector.refresh(id(1));
    await settle();
    expect(published).toHaveLength(1);
    clock += 60_000;
    collector.refresh(id(1));
    await settle();
    expect(published).toHaveLength(2);
    expect(ProjectsUpdatedPayloadSchema.parse(published[1]?.payload)).toEqual({
      upserted: [],
      removed: [],
      observed: [{ projectId: id(1), observedAt: new Date(clock).toISOString() }],
    });
    const view = collector.snapshot().projects.find((v) => v.projectId === id(1));
    expect(view?.observedAt).toBe(new Date(clock).toISOString());
  });

  it("keeps the last good git state with gitReadFailed true when a read fails", async () => {
    const collector = makeCollector();
    collector.refresh(id(1));
    await settle();

    answer = () => Promise.reject(new Error("timed out"));
    collector.refresh(id(1));
    await settle();

    const view = collector.snapshot().projects.find((v) => v.projectId === id(1));
    expect(view?.git).toEqual(repoState("main"));
    expect(view?.gitReadFailed).toBe(true);
    const last = ProjectsUpdatedPayloadSchema.parse(published.at(-1)?.payload);
    expect(last.upserted[0]).toMatchObject({ gitReadFailed: true, git: repoState("main") });
  });

  it("marks a never-read project as pending until git answers", () => {
    const collector = makeCollector();
    const snap = collector.snapshot();
    expect(snap.projects.map((v) => v.git)).toEqual([{ kind: "pending" }, { kind: "pending" }]);
    expect(snap.launchers["claude-code"].terminalLabel).toBe("Terminal");
  });

  it("publishes a removal as { upserted: [], removed: [id] } after onRegistryChanged", async () => {
    const collector = makeCollector();
    records = [record(1)];
    collector.onRegistryChanged();
    expect(ProjectsUpdatedPayloadSchema.parse(published.at(-1)?.payload)).toEqual({
      upserted: [],
      removed: [id(2)],
    });
    expect(collector.snapshot().projects.map((v) => v.projectId)).toEqual([id(1)]);
  });

  it("publishes a new or renamed project as an upsert after onRegistryChanged", () => {
    const collector = makeCollector();
    records = [record(1, { displayName: "demo-api" }), record(2), record(3)];
    collector.onRegistryChanged();
    const delta = ProjectsUpdatedPayloadSchema.parse(published.at(-1)?.payload);
    expect(delta.removed).toEqual([]);
    expect(delta.upserted.map((v) => v.projectId).sort()).toEqual([id(1), id(3)]);
  });

  it("publishes nothing when onRegistryChanged finds nothing changed", () => {
    const collector = makeCollector();
    collector.onRegistryChanged();
    expect(published).toEqual([]);
  });

  it("snapshot() returns the full list in the PROJ-15 order", () => {
    records = [
      record(1, { displayName: "zeta" }),
      record(2, { displayName: "alpha" }),
      record(3, { displayName: "mid", pinned: true }),
      record(4, { displayName: "opened", lastOpenedAt: "2026-09-02T00:00:00.000Z" }),
    ];
    const collector = makeCollector();
    const views = collector.snapshot().projects;
    expect(views.map((v) => v.displayName)).toEqual(["mid", "opened", "alpha", "zeta"]);
    expect([...views].sort(compareProjectViews)).toEqual(views);
  });

  it("ignores a read that finishes after its project was removed", async () => {
    let finish: () => void = () => {};
    answer = () =>
      new Promise((resolve) => {
        finish = () => resolve(repoState("main"));
      });
    const collector = makeCollector();
    collector.refresh(id(2));
    await settle();
    records = [record(1)];
    collector.onRegistryChanged();
    const before = published.length;
    finish();
    await settle();
    expect(published).toHaveLength(before);
    expect(collector.snapshot().projects.map((v) => v.projectId)).toEqual([id(1)]);
  });
});

describe("createProjectsCollector: the freshness heartbeat (wave-3 review, D-12)", () => {
  function tickingCollector() {
    return createProjectsCollector({
      eventBus: {
        publish: (type, payload) => {
          published.push({ type, payload });
          return { id: published.length, type, occurredAt: new Date().toISOString(), payload };
        },
        subscriberCount: () => subscribers,
      },
      gitRunner,
      readRecords: () => records,
      readLauncherConfigs: (): LauncherConfigRecord[] => [],
      homeDir: HOME,
      // Fake timers move Date.now() with the interval, so each tick reads "now".
      now: () => new Date(),
    });
  }

  function heartbeats() {
    return published
      .map((event) => ProjectsUpdatedPayloadSchema.parse(event.payload))
      .filter((payload) => payload.observed !== undefined);
  }

  it("publishes one heartbeat per tick carrying every unchanged project's new observedAt", async () => {
    vi.setSystemTime(new Date("2026-09-01T00:00:00.000Z"));
    subscribers = 1;
    const collector = tickingCollector();
    collector.start();
    await vi.advanceTimersByTimeAsync(30_000);
    // The first read changes pending -> repo: upserts, and nothing left for a heartbeat.
    expect(heartbeats()).toEqual([]);

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    const beats = heartbeats();
    expect(beats).toHaveLength(2);
    expect(beats[0]?.upserted).toEqual([]);
    expect(beats[0]?.removed).toEqual([]);
    expect(beats[0]?.observed?.map((o) => o.projectId).sort()).toEqual([id(1), id(2)]);
    expect(new Set(beats[0]?.observed?.map((o) => o.observedAt))).toEqual(
      new Set(["2026-09-01T00:01:00.000Z"]),
    );
    expect(new Set(beats[1]?.observed?.map((o) => o.observedAt))).toEqual(
      new Set(["2026-09-01T00:01:30.000Z"]),
    );
    collector.stop();
  });

  it("publishes no heartbeat once the collector stops reading, so freshness can age honestly", async () => {
    subscribers = 1;
    const collector = tickingCollector();
    collector.start();
    await vi.advanceTimersByTimeAsync(60_000);
    const before = published.length;
    collector.stop();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(published).toHaveLength(before);
  });

  it("never reports an observedAt for a read that failed", async () => {
    subscribers = 1;
    const collector = tickingCollector();
    collector.start();
    await vi.advanceTimersByTimeAsync(30_000);
    answer = () => Promise.reject(new Error("timed out"));
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(heartbeats()).toEqual([]);
    collector.stop();
  });
});
