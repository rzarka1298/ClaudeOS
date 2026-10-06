import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunId } from "@ccc/domain";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "./migrate.js";
import { insertRun } from "./run-store.js";
import { setSessionOverride } from "./session-store.js";
import {
  addRecognitionStats,
  analysisOffIntervals,
  appendToggleLog,
  deleteUsageAnalytics,
  getCollectorSetting,
  InvalidUsageRecordError,
  latestCapacity,
  listCostSnapshots,
  listToggleLog,
  markDayCovered,
  queryCoverage,
  queryTokenActivity,
  readCursor,
  readRecognitionStats,
  recordUsage,
  resetTranscriptScanState,
  setCollectorSetting,
  type UsageRecordInput,
  upsertCapacitySnapshot,
  upsertCostSnapshot,
  writeCursor,
} from "./usage-store.js";

const REAL_MIGRATIONS_DIR = join(import.meta.dirname, "../migrations");
const NOW = "2026-09-28T12:00:00.000Z";

/** The tables "Delete cached usage analytics" empties (D-46; recognition stats since wave 4). */
const USAGE_TABLES = [
  "usage_quarter_hourly",
  "usage_seen_messages",
  "coverage_days",
  "transcript_cursors",
  "capacity_snapshots",
  "cost_snapshots",
  "transcript_recognition",
] as const;

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccc-usage-store-"));
  db = new Database(join(dir, "operational.db"));
  applyMigrations(db, REAL_MIGRATIONS_DIR);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function record(overrides: Partial<UsageRecordInput> = {}): UsageRecordInput {
  return {
    messageId: "msg_01",
    claudeSessionId: "session-1",
    timestamp: "2026-09-28T10:15:30.000Z",
    model: "claude-opus-5-5",
    skillKey: null,
    projectKey: "project-a",
    counters: { input: 10, output: 20, cacheWrite: 30, cacheRead: 40 },
    ...overrides,
  };
}

function count(table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function bucketRows(): unknown[] {
  return db
    .prepare(
      "SELECT * FROM usage_quarter_hourly ORDER BY bucket_start, claude_session_id, project_key, model, skill_key",
    )
    .all();
}

const WHOLE_DAY = { start: "2026-09-28T00:00:00.000Z", end: "2026-09-29T00:00:00.000Z" };

describe("recordUsage (Test 1, USAGE-05, D-43, PR-11)", () => {
  it("counts a message id once however many lines repeat it", () => {
    const counted = recordUsage(
      db,
      [
        record({ messageId: "msg_01" }),
        record({ messageId: "msg_01" }),
        record({ messageId: "msg_01" }),
        record({
          messageId: "msg_02",
          counters: { input: 1, output: 2, cacheWrite: 3, cacheRead: 4 },
        }),
      ],
      NOW,
    );

    expect(counted).toBe(2);
    expect(queryTokenActivity(db, WHOLE_DAY).totals).toEqual({
      input: 11,
      output: 22,
      cacheWrite: 33,
      cacheRead: 44,
    });
    expect(count("usage_seen_messages")).toBe(2);
  });

  it("counts nothing for a message id already seen in an earlier batch", () => {
    recordUsage(db, [record()], NOW);
    expect(recordUsage(db, [record()], NOW)).toBe(0);
    expect(queryTokenActivity(db, WHOLE_DAY).totals.input).toBe(10);
  });

  it("buckets a record by its UTC quarter hour, so :30 and :45 local midnights are exact (wave 4)", () => {
    recordUsage(
      db,
      [
        record(),
        record({ messageId: "msg_44", timestamp: "2026-09-28T10:44:59.999Z" }),
        record({ messageId: "msg_45", timestamp: "2026-09-28T10:45:00.000Z" }),
      ],
      NOW,
    );
    const rows = db
      .prepare("SELECT bucket_start FROM usage_quarter_hourly ORDER BY bucket_start")
      .all() as Array<{ bucket_start: string }>;
    expect(rows.map((row) => row.bucket_start)).toEqual([
      "2026-09-28T10:15:00.000Z",
      "2026-09-28T10:30:00.000Z",
      "2026-09-28T10:45:00.000Z",
    ]);
    // A range starting at a quarter-hour local midnight takes exactly its quarters.
    expect(
      queryTokenActivity(db, { start: "2026-09-28T10:30:00.000Z", end: "2026-09-28T11:00:00.000Z" })
        .totals.input,
    ).toBe(20);
  });

  it("refuses a record with a negative counter or an unparsable timestamp, writing nothing", () => {
    expect(() =>
      recordUsage(
        db,
        [
          record({ messageId: "ok" }),
          record({
            messageId: "bad",
            counters: { input: -1, output: 0, cacheWrite: 0, cacheRead: 0 },
          }),
        ],
        NOW,
      ),
    ).toThrow(InvalidUsageRecordError);
    expect(() => recordUsage(db, [record({ timestamp: "yesterday" })], NOW)).toThrow(
      InvalidUsageRecordError,
    );
    expect(count("usage_seen_messages")).toBe(0);
    expect(count("usage_quarter_hourly")).toBe(0);
  });
});

describe("queryTokenActivity (Test 2, D-45)", () => {
  beforeEach(() => {
    recordUsage(
      db,
      [
        record({ messageId: "a", projectKey: "project-a", model: "claude-opus-5-5" }),
        record({
          messageId: "b",
          projectKey: null,
          model: "claude-sonnet-5-5",
          skillKey: "research",
          counters: { input: 1, output: 1, cacheWrite: 1, cacheRead: 1 },
        }),
        record({
          messageId: "c",
          claudeSessionId: "session-2",
          projectKey: "project-a",
          model: "claude-opus-5-5",
          timestamp: "2026-09-28T23:59:59.999Z",
          counters: { input: 100, output: 0, cacheWrite: 0, cacheRead: 0 },
        }),
        record({
          messageId: "outside",
          timestamp: "2026-09-29T00:00:00.000Z",
          counters: { input: 5000, output: 0, cacheWrite: 0, cacheRead: 0 },
        }),
      ],
      NOW,
    );
  });

  it("totals and breaks down by project, model and skill within the bounds", () => {
    const activity = queryTokenActivity(db, WHOLE_DAY);
    expect(activity.totals).toEqual({ input: 111, output: 21, cacheWrite: 31, cacheRead: 41 });
    expect(activity.byProject).toEqual([
      {
        projectId: "project-a",
        counters: { input: 110, output: 20, cacheWrite: 30, cacheRead: 40 },
      },
      { projectId: null, counters: { input: 1, output: 1, cacheWrite: 1, cacheRead: 1 } },
    ]);
    expect(activity.byModel).toEqual([
      {
        model: "claude-opus-5-5",
        counters: { input: 110, output: 20, cacheWrite: 30, cacheRead: 40 },
      },
      {
        model: "claude-sonnet-5-5",
        counters: { input: 1, output: 1, cacheWrite: 1, cacheRead: 1 },
      },
    ]);
    expect(activity.bySkill).toEqual([
      { name: "research", counters: { input: 1, output: 1, cacheWrite: 1, cacheRead: 1 } },
    ]);
  });

  it("filters to one Claude session for the per-session detail pane", () => {
    const activity = queryTokenActivity(db, { ...WHOLE_DAY, claudeSessionId: "session-2" });
    expect(activity.totals).toEqual({ input: 100, output: 0, cacheWrite: 0, cacheRead: 0 });
    expect(activity.byProject).toEqual([
      { projectId: "project-a", counters: { input: 100, output: 0, cacheWrite: 0, cacheRead: 0 } },
    ]);
  });

  it("reports zero totals and empty breakdowns for a range with no activity", () => {
    const activity = queryTokenActivity(db, {
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-01-02T00:00:00.000Z",
    });
    expect(activity).toEqual({
      totals: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
      byProject: [],
      byModel: [],
      bySkill: [],
    });
  });
});

describe("deleteUsageAnalytics (Test 3, USAGE-08, D-46)", () => {
  function seedEverything(): void {
    db.prepare(
      "INSERT INTO projects (project_id, path, workspace_id, display_name, registered_at) VALUES ('project-a', '/Users/USERNAME/code/a', NULL, 'A', ?)",
    ).run(NOW);
    insertRun(db, {
      runId: "mgz1a2b3c0000000000000001" as RunId,
      kind: "automation",
      projectId: null,
      claudeSessionId: null,
      state: "completed",
      startedAt: NOW,
      lastActivityAt: null,
      endedAt: NOW,
    });
    setSessionOverride(db, "session-1", "project-a", NOW);
    setCollectorSetting(db, "transcript_analysis_enabled", "true", NOW);
    appendToggleLog(db, NOW, true);
    recordUsage(db, [record()], NOW);
    markDayCovered(db, "2026-09-28", NOW);
    writeCursor(
      db,
      "/Users/USERNAME/.claude/projects/x/a.jsonl",
      {
        inode: "42",
        size: 100,
        offset: 100,
      },
      NOW,
    );
    upsertCapacitySnapshot(db, {
      window: "five_hour",
      usedPercent: 12.5,
      resetsAt: "2026-09-28T15:00:00.000Z",
      observedAt: NOW,
      claudeSessionId: "session-1",
    });
    upsertCostSnapshot(db, { claudeSessionId: "session-1", totalCostUsd: 1.25, observedAt: NOW });
    addRecognitionStats(db, 1, { "2.1.283": { assistant: 3, recognized: 3 } }, NOW);
  }

  it("empties the usage tables and leaves runs, overrides, settings and the toggle log untouched", () => {
    seedEverything();
    const runsBefore = count("runs");
    const kept = ["runs", "session_overrides", "collector_settings", "analysis_toggle_log"].map(
      (table) => db.prepare(`SELECT * FROM ${table}`).all(),
    );

    deleteUsageAnalytics(db);

    for (const table of USAGE_TABLES) {
      expect(count(table), table).toBe(0);
    }
    expect(count("runs")).toBe(runsBefore);
    expect(
      ["runs", "session_overrides", "collector_settings", "analysis_toggle_log"].map((table) =>
        db.prepare(`SELECT * FROM ${table}`).all(),
      ),
    ).toEqual(kept);
  });

  it("leaves every table as it was when a delete fails part-way through the transaction", () => {
    seedEverything();
    const before = USAGE_TABLES.map((table) => count(table));
    // Test double for a mid-transaction failure: the fifth delete aborts.
    db.exec(
      "CREATE TRIGGER forced_failure BEFORE DELETE ON capacity_snapshots BEGIN SELECT RAISE(ABORT, 'forced failure'); END",
    );

    expect(() => deleteUsageAnalytics(db)).toThrow(/forced failure/);
    expect(USAGE_TABLES.map((table) => count(table))).toEqual(before);
    expect(before.every((n) => n > 0)).toBe(true);
  });
});

describe("rebuild after deletion (Test 4, USAGE-05, D-43)", () => {
  it("replaying the same records from a zero cursor rebuilds identical aggregates", () => {
    const records = [
      record({ messageId: "a" }),
      record({ messageId: "a" }),
      record({ messageId: "b", model: "claude-sonnet-5-5", skillKey: "research" }),
      record({ messageId: "c", timestamp: "2026-09-28T11:59:00.000Z", projectKey: null }),
    ];
    recordUsage(db, records, NOW);
    const firstPass = bucketRows();

    deleteUsageAnalytics(db);
    expect(readCursor(db, "/Users/USERNAME/.claude/projects/x/a.jsonl")).toBeNull();
    recordUsage(db, records, "2026-09-28T13:00:00.000Z");

    expect(bucketRows()).toEqual(firstPass);
  });
});

describe("capacity and cost snapshots (Test 5, D-42, D-43)", () => {
  it("keeps only the latest observed capacity row per window", () => {
    upsertCapacitySnapshot(db, {
      window: "five_hour",
      usedPercent: 40,
      resetsAt: "2026-09-28T15:00:00.000Z",
      observedAt: "2026-09-28T11:00:00.000Z",
      claudeSessionId: "session-1",
    });
    upsertCapacitySnapshot(db, {
      window: "five_hour",
      usedPercent: 10,
      resetsAt: "2026-09-28T15:00:00.000Z",
      observedAt: "2026-09-28T10:00:00.000Z",
      claudeSessionId: "session-2",
    });
    upsertCapacitySnapshot(db, {
      window: "seven_day",
      usedPercent: 62.5,
      resetsAt: null,
      observedAt: "2026-09-28T09:00:00.000Z",
      claudeSessionId: null,
    });

    expect(latestCapacity(db)).toEqual([
      {
        window: "five_hour",
        usedPercent: 40,
        resetsAt: "2026-09-28T15:00:00.000Z",
        observedAt: "2026-09-28T11:00:00.000Z",
        claudeSessionId: "session-1",
      },
      {
        window: "seven_day",
        usedPercent: 62.5,
        resetsAt: null,
        observedAt: "2026-09-28T09:00:00.000Z",
        claudeSessionId: null,
      },
    ]);
  });

  it("keeps the latest cost total per session and never sums snapshots", () => {
    upsertCostSnapshot(db, {
      claudeSessionId: "session-1",
      totalCostUsd: 0.5,
      observedAt: "2026-09-28T10:00:00.000Z",
    });
    upsertCostSnapshot(db, {
      claudeSessionId: "session-1",
      totalCostUsd: 1.75,
      observedAt: "2026-09-28T11:00:00.000Z",
    });
    upsertCostSnapshot(db, {
      claudeSessionId: "session-1",
      totalCostUsd: 1.0,
      observedAt: "2026-09-28T10:30:00.000Z",
    });
    upsertCostSnapshot(db, {
      claudeSessionId: "session-2",
      totalCostUsd: 0.25,
      observedAt: "2026-09-28T09:00:00.000Z",
    });

    expect(listCostSnapshots(db)).toEqual([
      {
        claudeSessionId: "session-1",
        totalCostUsd: 1.75,
        firstObservedAt: "2026-09-28T10:00:00.000Z",
        observedAt: "2026-09-28T11:00:00.000Z",
      },
      {
        claudeSessionId: "session-2",
        totalCostUsd: 0.25,
        firstObservedAt: "2026-09-28T09:00:00.000Z",
        observedAt: "2026-09-28T09:00:00.000Z",
      },
    ]);
  });
});

describe("coverage ledger (Test 6, USAGE-09, D-44)", () => {
  it("classifies each day as covered, before-horizon, analysis-off or not-scanned", () => {
    markDayCovered(db, "2026-09-24", NOW);
    markDayCovered(db, "2026-09-25", NOW);
    markDayCovered(db, "2026-09-26", NOW);
    markDayCovered(db, "2026-09-25", "2026-09-28T13:00:00.000Z");

    const toggleLog = [
      { at: "2026-09-01T00:00:00.000Z", enabled: true },
      { at: "2026-09-26T08:00:00.000Z", enabled: false },
      { at: "2026-09-26T20:00:00.000Z", enabled: true },
    ];

    expect(queryCoverage(db, "2026-09-22", "2026-09-28", "2026-09-24", toggleLog)).toEqual([
      { day: "2026-09-22", status: "before-horizon" },
      { day: "2026-09-23", status: "before-horizon" },
      { day: "2026-09-24", status: "covered" },
      { day: "2026-09-25", status: "covered" },
      { day: "2026-09-26", status: "analysis-off" },
      { day: "2026-09-27", status: "not-scanned" },
      { day: "2026-09-28", status: "not-scanned" },
    ]);
  });

  it("does not treat days before the first enable as analysis-off: that enable backfills them (D-44, D-47, wave 4)", () => {
    markDayCovered(db, "2026-09-26", NOW);
    markDayCovered(db, "2026-09-27", NOW);
    const toggleLog = [{ at: "2026-09-27T09:00:00.000Z", enabled: true }];
    expect(queryCoverage(db, "2026-09-25", "2026-09-28", null, toggleLog)).toEqual([
      { day: "2026-09-25", status: "not-scanned" },
      { day: "2026-09-26", status: "covered" },
      { day: "2026-09-27", status: "covered" },
      { day: "2026-09-28", status: "not-scanned" },
    ]);
  });

  it("uses the caller's day function for local-time toggles", () => {
    markDayCovered(db, "2026-09-27", NOW);
    const toggleLog = [
      { at: "2026-09-01T00:00:00.000Z", enabled: true },
      { at: "2026-09-26T23:30:00.000Z", enabled: false },
    ];
    // In UTC+01:00 the switch-off lands on 2026-09-27 local, so that day was partly off.
    const localDay = (iso: string): string =>
      new Date(Date.parse(iso) + 3_600_000).toISOString().slice(0, 10);
    expect(queryCoverage(db, "2026-09-26", "2026-09-26", null, toggleLog, localDay)).toEqual([
      { day: "2026-09-26", status: "not-scanned" },
    ]);
    expect(queryCoverage(db, "2026-09-27", "2026-09-27", null, toggleLog, localDay)).toEqual([
      { day: "2026-09-27", status: "analysis-off" },
    ]);
    expect(queryCoverage(db, "2026-09-26", "2026-09-26", null, toggleLog)).toEqual([
      { day: "2026-09-26", status: "analysis-off" },
    ]);
  });

  it("derives off intervals from switch-offs only: [off, next on), open while still off (D-47, wave 4)", () => {
    expect(analysisOffIntervals([])).toEqual([]);
    expect(
      analysisOffIntervals([
        { at: "2026-09-20T12:00:00.000Z", enabled: false },
        { at: "2026-09-10T00:00:00.000Z", enabled: true },
        { at: "2026-09-21T09:00:00.000Z", enabled: true },
        { at: "2026-09-25T00:00:00.000Z", enabled: false },
      ]),
    ).toEqual([
      { start: "2026-09-20T12:00:00.000Z", end: "2026-09-21T09:00:00.000Z" },
      { start: "2026-09-25T00:00:00.000Z", end: null },
    ]);
  });
});

describe("collector settings and the toggle log (Test 7, D-47)", () => {
  it("round-trips transcript_analysis_enabled, absent by default", () => {
    expect(getCollectorSetting(db, "transcript_analysis_enabled")).toBeNull();
    setCollectorSetting(db, "transcript_analysis_enabled", "true", NOW);
    expect(getCollectorSetting(db, "transcript_analysis_enabled")).toBe("true");
    setCollectorSetting(db, "transcript_analysis_enabled", "false", "2026-09-28T13:00:00.000Z");
    expect(getCollectorSetting(db, "transcript_analysis_enabled")).toBe("false");
  });

  it("appends toggles and lists them in time order", () => {
    appendToggleLog(db, "2026-09-28T11:00:00.000Z", false);
    appendToggleLog(db, "2026-09-28T09:00:00.000Z", true);
    appendToggleLog(db, "2026-09-28T12:00:00.000Z", true);
    expect(listToggleLog(db)).toEqual([
      { at: "2026-09-28T09:00:00.000Z", enabled: true },
      { at: "2026-09-28T11:00:00.000Z", enabled: false },
      { at: "2026-09-28T12:00:00.000Z", enabled: true },
    ]);
  });
});

describe("transcript cursors (Test 8, D-40)", () => {
  it("round-trips { inode, size, offset } by path", () => {
    const path = "/Users/USERNAME/.claude/projects/x/a.jsonl";
    expect(readCursor(db, path)).toBeNull();
    writeCursor(db, path, { inode: "123456789", size: 2048, offset: 1024 }, NOW);
    expect(readCursor(db, path)).toEqual({ inode: "123456789", size: 2048, offset: 1024 });
    writeCursor(db, path, { inode: "123456789", size: 4096, offset: 4096 }, NOW);
    expect(readCursor(db, path)).toEqual({ inode: "123456789", size: 4096, offset: 4096 });
  });
});

describe("usage-store writes no projects rows (SESS-17, D-57)", () => {
  it("usage-store.ts contains no INSERT, UPDATE or DELETE statement naming the projects table", () => {
    const source = readFileSync(join(import.meta.dirname, "usage-store.ts"), "utf8");
    const table = "[`\"']?projects[`\"']?\\b";
    const writes = [
      new RegExp(`\\bINSERT\\s+(?:OR\\s+\\w+\\s+)?INTO\\s+${table}`, "i"),
      new RegExp(`\\bREPLACE\\s+INTO\\s+${table}`, "i"),
      new RegExp(`\\bUPDATE\\s+(?:OR\\s+\\w+\\s+)?${table}`, "i"),
      new RegExp(`\\bDELETE\\s+FROM\\s+${table}`, "i"),
    ];
    expect(writes.some((pattern) => pattern.test("DELETE FROM projects"))).toBe(true);
    for (const pattern of writes) {
      expect(source).not.toMatch(pattern);
    }
  });
});

describe("transcript recognition stats (wave 4 review, D-41, PR-11)", () => {
  it("adds per-parser-version, per-Claude-version tallies and reads only the asked parser version", () => {
    addRecognitionStats(db, 2, { "2.1.283": { assistant: 3, recognized: 2 } }, NOW);
    addRecognitionStats(
      db,
      2,
      { "2.1.283": { assistant: 4, recognized: 4 }, "2.1.290": { assistant: 1, recognized: 0 } },
      NOW,
    );
    addRecognitionStats(db, 1, { "2.1.283": { assistant: 99, recognized: 0 } }, NOW);
    expect(readRecognitionStats(db, 2)).toEqual({
      "2.1.283": { assistant: 7, recognized: 6 },
      "2.1.290": { assistant: 1, recognized: 0 },
    });
    expect(readRecognitionStats(db, 3)).toEqual({});
  });

  it("resetTranscriptScanState clears cursors, coverage and every tally, keeping counted tokens", () => {
    recordUsage(db, [record()], NOW);
    markDayCovered(db, "2026-09-28", NOW);
    writeCursor(
      db,
      "/Users/USERNAME/.claude/projects/x/a.jsonl",
      { inode: "1", size: 5, offset: 5 },
      NOW,
    );
    addRecognitionStats(db, 1, { "2.1.283": { assistant: 5, recognized: 0 } }, NOW);
    addRecognitionStats(db, 2, { "2.1.283": { assistant: 5, recognized: 5 } }, NOW);
    resetTranscriptScanState(db);
    expect(count("transcript_cursors")).toBe(0);
    expect(count("coverage_days")).toBe(0);
    expect(count("transcript_recognition")).toBe(0);
    // Counted tokens stay: message-id dedup keeps a rescan from counting twice.
    expect(count("usage_quarter_hourly")).toBe(1);
    expect(count("usage_seen_messages")).toBe(1);
  });
});
