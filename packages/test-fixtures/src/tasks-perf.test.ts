import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  localDayBounds,
  TASK_ATTENTION_PATH,
  TASK_CHANGED_PATH,
  TASK_COUNTS_PATH,
  TASK_CREATE_PATH,
  TASK_DUE_TODAY_PATH,
  TASK_FILTERS,
  TASK_LIST_PATH,
  TASK_REBUILD_PATH,
  type TaskCountsResponse,
  type TaskDueTodayResponse,
  type TaskListResponse,
  type TaskRebuildResponse,
} from "@ccc/domain";
import {
  applyMigrations,
  countTasks,
  openStore,
  queryTasks,
  rebuildTaskIndex,
  type TaskIndexRecord,
} from "@ccc/operational-store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  expectedCounts,
  expectedIds,
  type GeneratedTaskVault,
  generateTaskVault,
  utcDay,
} from "./task-fixtures.js";
import { startTaskService, type TaskServiceSession } from "./task-service-support.js";

/**
 * Plan 06-25 Task 2 (TASK-09, D-31, D-32): the 10,000-task budgets, measured
 * through the REAL service's HTTP routes over its socket. Every latency is the
 * best of three (a cold start is not what a user feels twice) and every
 * measurement is printed for the plan summary. The ceilings are the stated
 * budgets and are never loosened here: 250 ms for a query, 5 s for a rebuild
 * and for the boot walk.
 */

const QUERY_CEILING_MS = 250;
const WALK_CEILING_MS = 5_000;
const RSS_CEILING_KB = 600 * 1024;
const TASK_COUNT = 10_000;
const BASE = join(homedir(), ".ccc-test");
const ZONE = "UTC";

const SCOPE_NAMES = ["all", "global", "workspace"] as const;

function post<T>(session: TaskServiceSession, path: string, body: unknown) {
  return session.post<T>(path, body);
}

/** Best of three single requests, in milliseconds, plus the last reply. */
async function bestOfThree<T>(
  label: string,
  run: () => Promise<{ status: number; body: T }>,
): Promise<{ ms: number; reply: { status: number; body: T } }> {
  let best = Number.POSITIVE_INFINITY;
  let reply: { status: number; body: T } | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const started = performance.now();
    reply = await run();
    best = Math.min(best, performance.now() - started);
  }
  console.log(`[TASK-09] ${label}: ${best.toFixed(2)}ms`);
  return { ms: best, reply: reply as { status: number; body: T } };
}

let vaultBase: string;
let vault: GeneratedTaskVault;
let session: TaskServiceSession;

describe("10,000 tasks through the real routes (Task 2, Tests 1, 2, 5, 6)", () => {
  beforeAll(async () => {
    mkdirSync(BASE, { recursive: true });
    vaultBase = mkdtempSync(join(BASE, "tp-"));
    const generating = performance.now();
    vault = generateTaskVault(join(vaultBase, "vault"), { count: TASK_COUNT, boundarySize: 5 });
    console.log(
      `[TASK-09] generated ${TASK_COUNT} task notes in ${(performance.now() - generating).toFixed(0)}ms`,
    );
    session = await startTaskService(vault, { bootWalk: true });
  }, 300_000);

  afterAll(async () => {
    await session?.close();
    rmSync(vaultBase, { recursive: true, force: true });
  }, 60_000);

  const scopeOf = (name: (typeof SCOPE_NAMES)[number]): string =>
    name === "all" ? "all" : name === "global" ? "global" : (vault.scopes[1] as string);
  const projectOf = (): string => {
    const found = vault.tasks.find((task) => task.projectId !== undefined)?.projectId;
    if (found === undefined) throw new Error("the generated vault has no project");
    return found;
  };

  it("answers every filter in every scope, every count, a deep page, attention and the feed under the ceiling", async () => {
    const project = projectOf();
    for (const scopeName of SCOPE_NAMES) {
      const scope = scopeOf(scopeName);
      for (const filter of TASK_FILTERS) {
        const context = filter === "project" ? { scope, projectId: project } : { scope };
        const { ms, reply } = await bestOfThree<TaskListResponse>(
          `list ${filter} in ${scopeName}`,
          () => post(session, TASK_LIST_PATH, { context, filter, zone: ZONE }),
        );
        expect(reply.status).toBe(200);
        expect(ms, `list ${filter} in ${scopeName}`).toBeLessThan(QUERY_CEILING_MS);
      }
      const counts = await bestOfThree<TaskCountsResponse>(`counts in ${scopeName}`, () =>
        post(session, TASK_COUNTS_PATH, { context: { scope }, zone: ZONE }),
      );
      expect(counts.reply.status).toBe(200);
      expect(counts.ms, `counts in ${scopeName}`).toBeLessThan(QUERY_CEILING_MS);
    }

    // A page at depth: walk a hundred pages of the unfiltered view, then time the next.
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const reply = await post<TaskListResponse>(session, TASK_LIST_PATH, {
        context: { scope: "all" },
        filter: "all",
        zone: ZONE,
        ...(cursor === undefined ? {} : { cursor }),
      });
      cursor = reply.body.nextCursor ?? undefined;
    }
    expect(cursor).toBeDefined();
    const deep = await bestOfThree<TaskListResponse>("deep keyset page (page 101 of all)", () =>
      post(session, TASK_LIST_PATH, {
        context: { scope: "all" },
        filter: "all",
        zone: ZONE,
        cursor,
      }),
    );
    expect(deep.reply.body.rows).toHaveLength(25);
    expect(deep.ms).toBeLessThan(QUERY_CEILING_MS);

    const attention = await bestOfThree(`attention`, () => post(session, TASK_ATTENTION_PATH, {}));
    expect(attention.reply.status).toBe(200);
    expect(attention.ms).toBeLessThan(QUERY_CEILING_MS);

    const feed = await bestOfThree<TaskDueTodayResponse>("due-today feed", () =>
      post(session, TASK_DUE_TODAY_PATH, { zone: ZONE }),
    );
    expect(feed.reply.status).toBe(200);
    expect(feed.reply.body.due.length).toBeGreaterThan(0);
    expect(feed.ms).toBeLessThan(QUERY_CEILING_MS);
  }, 300_000);

  it("keeps every chip count equal to the length of its list paged to the end, and equal to the oracle", async () => {
    const project = projectOf();
    const day = utcDay(new Date());
    for (const scopeName of SCOPE_NAMES) {
      const scope = scopeOf(scopeName);
      for (const filter of TASK_FILTERS) {
        const useProject = filter === "project";
        const context = useProject ? { scope, projectId: project } : { scope };
        const counts = await post<TaskCountsResponse>(session, TASK_COUNTS_PATH, {
          context,
          zone: ZONE,
        });
        const ids: string[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 1_000; page += 1) {
          const reply = await post<TaskListResponse>(session, TASK_LIST_PATH, {
            context,
            filter,
            zone: ZONE,
            ...(cursor === undefined ? {} : { cursor }),
          });
          expect(reply.status).toBe(200);
          ids.push(...reply.body.rows.map((row) => row.id));
          if (reply.body.nextCursor === null) break;
          cursor = reply.body.nextCursor;
        }
        const label = `${filter} in ${scopeName}`;
        expect(ids.length, label).toBe(counts.body.counts[filter]);
        expect(new Set(ids).size, label).toBe(ids.length);
        expect(new Set(ids), label).toEqual(
          new Set(expectedIds(vault.tasks, filter, scope, day, useProject ? project : undefined)),
        );
        expect(counts.body, label).toEqual(
          expectedCounts(vault.tasks, scope, day, useProject ? project : undefined),
        );
      }
    }
  }, 600_000);

  it("gives different Today membership for instant-dated tasks in two zones, and each follows its own local day", async () => {
    const now = new Date();
    const west = "Pacific/Pago_Pago";
    const east = "Pacific/Kiritimati";
    const members = async (zone: string): Promise<Set<string>> => {
      const ids = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < 1_000; page += 1) {
        const reply = await post<TaskListResponse>(session, TASK_LIST_PATH, {
          context: { scope: "all" },
          filter: "today",
          zone,
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (const row of reply.body.rows) ids.add(row.id);
        if (reply.body.nextCursor === null) break;
        cursor = reply.body.nextCursor;
      }
      return ids;
    };
    const inWest = await members(west);
    const inEast = await members(east);
    expect(inWest).toEqual(
      new Set(expectedIds(vault.tasks, "today", "all", localDayBounds(now, west))),
    );
    expect(inEast).toEqual(
      new Set(expectedIds(vault.tasks, "today", "all", localDayBounds(now, east))),
    );
    // The two local calendar days are at least one day apart, so the sets differ.
    expect(inWest).not.toEqual(inEast);
    const byId = new Map(vault.tasks.map((task) => [task.id, task]));
    const instantKinds = new Set(["today-instant", "overdue-instant", "upcoming-instant"]);
    const differingInstants = [...inWest, ...inEast].filter(
      (id) => instantKinds.has(byId.get(id)?.kind ?? "") && inWest.has(id) !== inEast.has(id),
    );
    expect(differingInstants.length).toBeGreaterThan(0);
  }, 300_000);

  it("holds list latency through a change storm and coalesces rescans into one walk", async () => {
    const paths = vault.tasks.map((task) => task.path);
    const median = (values: number[]): number =>
      [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] as number;
    const timeList = async (): Promise<number> => {
      const started = performance.now();
      const reply = await post<TaskListResponse>(session, TASK_LIST_PATH, {
        context: { scope: "all" },
        filter: "today",
        zone: ZONE,
      });
      expect(reply.status).toBe(200);
      return performance.now() - started;
    };

    const idle: number[] = [];
    for (let i = 0; i < 21; i += 1) idle.push(await timeList());
    const idleMedian = median(idle);

    const storm: number[] = [];
    let accepted = 0;
    for (let request = 0; request < 500; request += 1) {
      const start = (request * 200) % (paths.length - 200);
      const reply = await post<{ accepted: number }>(session, TASK_CHANGED_PATH, {
        paths: paths.slice(start, start + 200),
      });
      expect(reply.status).toBe(200);
      accepted += reply.body.accepted;
      if (request % 10 === 0) storm.push(await timeList());
    }
    expect(accepted).toBe(500 * 200);
    const stormMedian = median(storm);
    const stormMax = Math.max(...storm);
    console.log(
      `[TASK-09] storm: idle median ${idleMedian.toFixed(2)}ms, storm median ${stormMedian.toFixed(2)}ms, storm max ${stormMax.toFixed(2)}ms`,
    );
    expect(stormMedian).toBeLessThanOrEqual(2 * idleMedian);
    expect(stormMax).toBeLessThan(QUERY_CEILING_MS);

    // Fifty rescan requests in a burst cost one deferred walk, not fifty.
    const events = session.collectEvents();
    try {
      for (let request = 0; request < 50; request += 1) {
        const reply = await post(session, TASK_CHANGED_PATH, { rescan: true });
        expect(reply.status).toBe(200);
      }
      await new Promise((resolve) => setTimeout(resolve, 8_000));
      const walks = events.events.filter((event) => event.type === "tasks.changed").length;
      console.log(`[TASK-09] rescan burst of 50 requests: ${walks} walk announcement(s)`);
      expect(walks).toBe(1);
    } finally {
      events.close();
    }
  }, 600_000);
});

describe("create, rebuild and boot walk at scale (Task 2, Tests 3 and 4)", () => {
  it("creates a task no slower with 10,000 indexed than with 100, and leaves the summary index small and unchanged", async () => {
    mkdirSync(BASE, { recursive: true });
    const base = mkdtempSync(join(BASE, "tc-"));
    try {
      const small = generateTaskVault(join(base, "small"), { count: 100 });
      const large = generateTaskVault(join(base, "large"), { count: TASK_COUNT });
      const smallService = await startTaskService(small, { bootWalk: true });
      const largeService = await startTaskService(large, { bootWalk: true });
      try {
        const indexSize = (root: string): number =>
          statSync(join(root, "global", "tasks", "index.md")).size;
        const sizeBefore = indexSize(large.vaultRoot);
        expect(sizeBefore).toBeLessThan(2 * 1024);

        const batch = async (service: TaskServiceSession, label: string): Promise<number> => {
          const started = performance.now();
          for (let i = 0; i < 100; i += 1) {
            const reply = await service.post(TASK_CREATE_PATH, {
              title: `${label} created task ${i}`,
              intent: "inbox",
              zone: ZONE,
              scope: "global",
            });
            expect(reply.status).toBe(200);
          }
          return (performance.now() - started) / 100;
        };
        const smallTimes: number[] = [];
        const largeTimes: number[] = [];
        for (let round = 0; round < 3; round += 1) {
          smallTimes.push(await batch(smallService, `small ${round}`));
          largeTimes.push(await batch(largeService, `large ${round}`));
        }
        const smallBest = Math.min(...smallTimes);
        const largeBest = Math.min(...largeTimes);
        console.log(
          `[TASK-09] create: ${smallBest.toFixed(2)}ms/task at 100 tasks, ${largeBest.toFixed(2)}ms/task at 10,000`,
        );
        expect(largeBest).toBeLessThanOrEqual(2 * smallBest);
        expect(indexSize(large.vaultRoot)).toBe(sizeBefore);
      } finally {
        await smallService.close();
        await largeService.close();
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 600_000);

  it("rebuilds 10,000 notes in under five seconds and boots to a right answer in under five seconds", async () => {
    mkdirSync(BASE, { recursive: true });
    const base = mkdtempSync(join(BASE, "tw-"));
    try {
      const big = generateTaskVault(join(base, "vault"), { count: TASK_COUNT, boundarySize: 5 });
      const service = await startTaskService(big, { bootWalk: false });
      try {
        const rssBefore = service.rssKb();
        const started = performance.now();
        const rebuilt = await service.post<TaskRebuildResponse>(TASK_REBUILD_PATH, {});
        const rebuildMs = performance.now() - started;
        expect(rebuilt.status).toBe(200);
        expect(rebuilt.body).toEqual({ tasks: TASK_COUNT, attention: 0 });
        const rssAfterRebuild = service.rssKb();

        const booted = await service.restart();
        const rssAfterBoot = service.rssKb();
        console.log(
          `[TASK-09] rebuild of ${TASK_COUNT} notes: ${rebuildMs.toFixed(0)}ms; boot to first counts: ${booted.firstCountsMs.toFixed(0)}ms; RSS ${(rssBefore / 1024).toFixed(0)} MiB before, ${(rssAfterRebuild / 1024).toFixed(0)} MiB after rebuild, ${(rssAfterBoot / 1024).toFixed(0)} MiB after boot walk`,
        );
        expect(rebuildMs).toBeLessThan(WALK_CEILING_MS);
        expect(booted.firstCountsMs).toBeLessThan(WALK_CEILING_MS);
        expect(rssAfterRebuild).toBeLessThan(RSS_CEILING_KB);
        expect(rssAfterBoot).toBeLessThan(RSS_CEILING_KB);

        const counts = await service.post<TaskCountsResponse>(TASK_COUNTS_PATH, {
          context: { scope: "all" },
          zone: ZONE,
        });
        expect(counts.body.counts.all).toBe(TASK_COUNT);
      } finally {
        await service.close();
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 600_000);
});

describe("a daylight-saving day in the index (Task 2, Test 5)", () => {
  it("keeps an all-day task on its date in both zones and moves an instant with each zone's day", () => {
    mkdirSync(BASE, { recursive: true });
    const base = mkdtempSync(join(BASE, "td-"));
    const store = openStore(join(base, "operational.db"));
    try {
      applyMigrations(store.db);
      const record = (n: number, title: string, due: string): TaskIndexRecord => ({
        noteId: `${String(n).padStart(2, "0")}${"a".repeat(23)}`,
        path: `global/tasks/dst-${n}.md`,
        scope: "global",
        title,
        status: "ready",
        due,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
        sourceType: "manual",
        contentHash: String(n).padStart(2, "0").repeat(32),
        tags: [],
        dependencies: [],
        aiGenerated: false,
        claimType: null,
        confidence: "unverified",
      });
      rebuildTaskIndex(store.db, [
        record(1, "all-day on the fall-back date", "2026-11-01"),
        record(2, "late evening of the fall-back day", "2026-11-02T04:30:00.000Z"),
        record(3, "just after local midnight in New York", "2026-11-02T05:30:00.000Z"),
      ]);
      const now = new Date("2026-11-01T12:00:00.000Z");
      const newYork = localDayBounds(now, "America/New_York");
      const phoenix = localDayBounds(now, "America/Phoenix");
      // The New York day is 25 hours long: it starts at 04:00Z and ends at 05:00Z the next day.
      expect(Date.parse(newYork.endsAt) - Date.parse(newYork.startsAt)).toBe(25 * 3_600_000);
      const today = (day: typeof newYork): string[] =>
        queryTasks(store.db, { context: { scope: "all" }, filter: "today", day })
          .rows.map((row) => row.title)
          .sort();
      expect(today(newYork)).toEqual([
        "all-day on the fall-back date",
        "late evening of the fall-back day",
      ]);
      expect(today(phoenix)).toEqual([
        "all-day on the fall-back date",
        "just after local midnight in New York",
        "late evening of the fall-back day",
      ]);
      expect(countTasks(store.db, { context: { scope: "all" }, day: newYork }).counts.today).toBe(
        2,
      );
      expect(countTasks(store.db, { context: { scope: "all" }, day: phoenix }).counts.today).toBe(
        3,
      );
    } finally {
      store.close();
      rmSync(base, { recursive: true, force: true });
    }
  });
});
