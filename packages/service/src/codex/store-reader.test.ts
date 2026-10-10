import { readdirSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFakeCodexHome,
  type FakeCodexHome,
  type FakeDdl,
  type FakeThread,
  NEVER_SELECT_DECOYS,
} from "../test-support/fake-codex-home.js";
import { createCodexHomePort } from "./codex-home.js";
import {
  createCodexStoreReader,
  type OpenDatabase,
  type OpenDatabaseOptions,
  type ReaderDatabase,
} from "./store-reader.js";

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const MINUTE = 60_000;
const SINCE = NOW - 24 * 60 * MINUTE;

let home: FakeCodexHome | undefined;
const writers: Database.Database[] = [];

afterEach(() => {
  for (const writer of writers.splice(0)) {
    try {
      writer.close();
    } catch {
      // already closed
    }
  }
  home?.cleanup();
  home = undefined;
});

function rolloutsFor(threads: readonly FakeThread[], olderByMs = 0) {
  return threads.map((thread) => ({
    day: "2026-10-06",
    name: `rollout-${thread.id}.jsonl`,
    content: "{}\n",
    mtimeMs: thread.updatedAtMs - olderByMs,
  }));
}

const THREADS: readonly FakeThread[] = [
  {
    id: "thread-b",
    updatedAtMs: NOW - 10 * MINUTE,
    model: "synthetic-model",
    reasoningEffort: "high",
    threadSource: "user",
    agentNickname: "synthetic-nick",
    title: "SYNTHETIC-TITLE-B",
    name: "SYNTHETIC-NAME-B",
  },
  { id: "thread-a", updatedAtMs: NOW - 5 * MINUTE, title: "SYNTHETIC-TITLE-A" },
  { id: "thread-c", updatedAtMs: NOW - 20 * MINUTE, cliVersion: "0.155.0-alpha.9.2" },
];

function makeHome(
  ddl: FakeDdl,
  threads: readonly FakeThread[] = THREADS,
  extra: { journalMode?: "wal" | "delete"; olderByMs?: number } = {},
): FakeCodexHome {
  home = createFakeCodexHome({
    rollouts: rolloutsFor(threads, extra.olderByMs ?? 0),
    database: {
      ddl,
      threads,
      ...(extra.journalMode === undefined ? {} : { journalMode: extra.journalMode }),
    },
  });
  return home;
}

interface Spy {
  readonly open: OpenDatabase;
  readonly counts: { opened: number; closed: number };
  readonly options: OpenDatabaseOptions[];
  readonly prepared: string[];
  readonly pragmas: string[];
}

function spyOpener(failPrepareOn?: RegExp): Spy {
  const counts = { opened: 0, closed: 0 };
  const options: OpenDatabaseOptions[] = [];
  const prepared: string[] = [];
  const pragmas: string[] = [];
  const open: OpenDatabase = (path, opts) => {
    const db = new Database(path, opts);
    counts.opened += 1;
    options.push(opts);
    const wrapped: ReaderDatabase = {
      pragma: (source) => {
        pragmas.push(source);
        return db.pragma(source);
      },
      prepare: (sql) => {
        prepared.push(sql);
        if (failPrepareOn?.test(sql)) throw new Error("synthetic failure");
        return db.prepare(sql) as ReturnType<ReaderDatabase["prepare"]>;
      },
      close: () => {
        counts.closed += 1;
        db.close();
      },
    };
    return wrapped;
  };
  return { open, counts, options, prepared, pragmas };
}

function readerFor(fake: FakeCodexHome, spy?: Spy, busyTimeoutMs?: number) {
  const port = createCodexHomePort({ root: fake.root });
  return createCodexStoreReader({
    port,
    now: () => NOW,
    ...(spy === undefined ? {} : { openDatabase: spy.open }),
    ...(busyTimeoutMs === undefined ? {} : { busyTimeoutMs }),
  });
}

const BASE = { sinceMs: SINCE, limit: 50, includePromptDerived: false } as const;

function threadSql(spy: Spy): string[] {
  return spy.prepared.filter((sql) => /FROM threads/i.test(sql));
}

describe("Test 1 (tracer): the current store reads as ok rows without prompt or identifier members", () => {
  it("returns the three synthetic threads newest first with only allowlisted members", () => {
    const fake = makeHome("current");
    const db = new Database(fake.dbPath, { readonly: true });
    expect((db.pragma("table_info(threads)") as unknown[]).length).toBe(42);
    db.close();

    const result = readerFor(fake).readThreads(BASE);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.threads.map((row) => row.id)).toEqual(["thread-a", "thread-b", "thread-c"]);
    const row = result.threads[1];
    expect(row).toMatchObject({
      id: "thread-b",
      cwd: "/Users/USERNAME/repo",
      source: "cli",
      cliVersion: "0.159.2",
      model: "synthetic-model",
      reasoningEffort: "high",
      archived: false,
      updatedAtMs: NOW - 10 * MINUTE,
    });
    expect(row?.rolloutPath).toBe(fake.rolloutPath("2026-10-06", "rollout-thread-b.jsonl"));
    expect(typeof row?.createdAtMs).toBe("number");
    for (const key of [
      "title",
      "name",
      "preview",
      "firstUserMessage",
      "first_user_message",
      "gitOriginUrl",
      "git_origin_url",
      "creatorUserId",
      "creatorAccountId",
      "creator_user_id",
      "creator_account_id",
    ]) {
      expect(row, key).not.toHaveProperty(key);
    }
    const serialized = JSON.stringify(result);
    for (const decoy of NEVER_SELECT_DECOYS) expect(serialized).not.toContain(decoy);
    expect(serialized).not.toContain("SYNTHETIC-TITLE");
  });

  it("honours since and limit", () => {
    const fake = makeHome("current");
    const reader = readerFor(fake);
    const limited = reader.readThreads({ ...BASE, limit: 1 });
    expect(limited.kind === "ok" && limited.threads.map((row) => row.id)).toEqual(["thread-a"]);
    const recent = reader.readThreads({ ...BASE, sinceMs: NOW - 8 * MINUTE });
    expect(recent.kind === "ok" && recent.threads.map((row) => row.id)).toEqual(["thread-a"]);
  });

  it("reports the archived flag and leaves filtering to the caller", () => {
    const fake = makeHome("current", [
      { id: "thread-z", updatedAtMs: NOW - MINUTE, archived: true },
    ]);
    const result = readerFor(fake).readThreads(BASE);
    expect(result.kind === "ok" && result.threads[0]?.archived).toBe(true);
  });
});

describe("Test 2: floor, changed and missing stores", () => {
  it("reads the floor schema with the optional members absent", () => {
    const fake = makeHome("floor");
    const result = readerFor(fake).readThreads(BASE);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.threads).toHaveLength(3);
    for (const row of result.threads) {
      for (const key of ["model", "reasoningEffort", "threadSource", "agentNickname"]) {
        expect(row, key).not.toHaveProperty(key);
      }
    }
  });

  it("answers format-changed for the changed schema and reads no thread row", () => {
    const fake = makeHome("changed");
    const spy = spyOpener();
    const result = readerFor(fake, spy).readThreads(BASE);
    expect(result).toMatchObject({ kind: "unavailable", reason: "format-changed" });
    expect(threadSql(spy)).toEqual([]);
    expect(spy.prepared.length).toBeLessThanOrEqual(1);
    expect(spy.counts.opened).toBe(spy.counts.closed);
  });

  it("answers format-changed when the migrations table is absent", () => {
    const fake = makeHome("floor");
    const db = new Database(fake.dbPath);
    db.exec("DROP TABLE _sqlx_migrations");
    db.close();
    const spy = spyOpener();
    expect(readerFor(fake, spy).readThreads(BASE)).toMatchObject({
      kind: "unavailable",
      reason: "format-changed",
    });
    expect(threadSql(spy)).toEqual([]);
  });

  it("answers no-store and creates nothing when there is no database", () => {
    home = createFakeCodexHome({ sessionIndex: "{}\n" });
    const before = readdirSync(home.root).sort();
    const spy = spyOpener();
    const result = readerFor(home, spy).readThreads(BASE);
    expect(result).toMatchObject({ kind: "unavailable", reason: "no-store" });
    expect(spy.counts.opened).toBe(0);
    expect(readdirSync(home.root).sort()).toEqual(before);
  });
});

describe("Test 3: prompt-derived columns need the flag", () => {
  it("selects title and name only when asked and present", () => {
    const fake = makeHome("current");
    const spy = spyOpener();
    const result = readerFor(fake, spy).readThreads({ ...BASE, includePromptDerived: true });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    const byId = new Map(result.threads.map((row) => [row.id, row]));
    expect(byId.get("thread-b")).toMatchObject({
      title: "SYNTHETIC-TITLE-B",
      name: "SYNTHETIC-NAME-B",
    });
    const sql = threadSql(spy).join("\n");
    expect(sql).toMatch(/\btitle\b/);
    expect(sql).toMatch(/\bname\b/);
    for (const forbidden of [
      "first_user_message",
      "preview",
      "git_origin_url",
      "git_sha",
      "git_branch",
      "creator_user_id",
      "creator_account_id",
      "*",
    ]) {
      expect(sql, forbidden).not.toContain(forbidden);
    }
    const serialized = JSON.stringify(result);
    for (const decoy of NEVER_SELECT_DECOYS) expect(serialized).not.toContain(decoy);
  });

  it("omits title and name when the flag is true but the columns are absent", () => {
    const fake = makeHome("floor");
    const result = readerFor(fake).readThreads({ ...BASE, includePromptDerived: true });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    for (const row of result.threads) {
      expect(row).not.toHaveProperty("title");
      expect(row).not.toHaveProperty("name");
    }
  });

  it("never selects title or name when the flag is false", () => {
    const fake = makeHome("current");
    const spy = spyOpener();
    readerFor(fake, spy).readThreads(BASE);
    const sql = threadSql(spy).join("\n");
    expect(sql).not.toMatch(/\btitle\b/);
    expect(sql).not.toMatch(/\bname\b/);
    expect(sql).not.toContain("*");
  });
});

describe("Test 4: short-lived read-only open", () => {
  it("opens readonly, fileMustExist, query-only, with a short busy timeout", () => {
    const fake = makeHome("current");
    const spy = spyOpener();
    readerFor(fake, spy, 5000).readThreads(BASE);
    expect(spy.options).toHaveLength(1);
    expect(spy.options[0]).toMatchObject({ readonly: true, fileMustExist: true });
    expect(spy.options[0]?.timeout).toBeLessThanOrEqual(250);
    expect(spy.pragmas.some((p) => /query_only\s*=\s*(ON|1|true)/i.test(p))).toBe(true);
    const busy = spy.pragmas.find((p) => /busy_timeout/i.test(p));
    if (busy !== undefined) {
      expect(Number(/(\d+)/.exec(busy)?.[1])).toBeLessThanOrEqual(250);
    }
  });

  it("closes the connection on every path, including errors", () => {
    const fake = makeHome("current");
    const ok = spyOpener();
    readerFor(fake, ok).readThreads(BASE);
    expect(ok.counts.opened).toBe(1);
    expect(ok.counts.closed).toBe(1);

    const failing = spyOpener(/FROM threads/i);
    const result = readerFor(fake, failing).readThreads(BASE);
    expect(result).toMatchObject({ kind: "unavailable", reason: "read-failed" });
    expect(JSON.stringify(result)).not.toContain("synthetic failure");
    expect(failing.counts.opened).toBe(failing.counts.closed);
    expect(failing.counts.opened).toBe(1);

    const changed = makeHome("changed");
    const gate = spyOpener();
    readerFor(changed, gate).readThreads(BASE);
    expect(gate.counts.opened).toBe(gate.counts.closed);
  });

  it("refuses a write through the opened connection", () => {
    const fake = makeHome("current");
    const spy = spyOpener();
    let writeError = "";
    const open: OpenDatabase = (path, opts) => {
      const db = spy.open(path, opts);
      try {
        db.prepare("DELETE FROM threads").all();
      } catch (error) {
        writeError = error instanceof Error ? error.message : "";
      }
      return db;
    };
    const port = createCodexHomePort({ root: fake.root });
    createCodexStoreReader({ port, openDatabase: open, now: () => NOW }).readThreads(BASE);
    expect(writeError).not.toBe("");
    const check = new Database(fake.dbPath, { readonly: true });
    expect((check.prepare("SELECT COUNT(*) AS n FROM threads").get() as { n: number }).n).toBe(3);
    check.close();
  });
});

describe("Test 5: a busy store is skipped, never waited on", () => {
  it("is not blocked by a writer holding the WAL and sees the new commit next call", () => {
    const fake = makeHome("current");
    const writer = new Database(fake.dbPath);
    writers.push(writer);
    writer.pragma("journal_mode = WAL");
    writer.exec("BEGIN IMMEDIATE");
    const insert = writer.prepare(
      "INSERT INTO threads (id, rollout_path, cwd, source, cli_version, archived, updated_at_ms, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run(
      "thread-new",
      "/x",
      "/Users/USERNAME/repo",
      "cli",
      "0.159.2",
      0,
      NOW - MINUTE,
      NOW - 2 * MINUTE,
    );

    const reader = readerFor(fake);
    const during = reader.readThreads(BASE);
    expect(during.kind === "ok" && during.threads.map((row) => row.id)).not.toContain("thread-new");
    expect(during.kind).toBe("ok");

    writer.exec("COMMIT");
    const after = reader.readThreads(BASE);
    expect(after.kind === "ok" && after.threads.map((row) => row.id)).toContain("thread-new");
  });

  it("answers busy within the short timeout when an exclusive writer holds a rollback journal", () => {
    const fake = makeHome("current", THREADS, { journalMode: "delete" });
    const writer = new Database(fake.dbPath);
    writers.push(writer);
    writer.exec("BEGIN EXCLUSIVE");

    const started = Date.now();
    const result = readerFor(fake, undefined, 50).readThreads(BASE);
    const elapsed = Date.now() - started;
    expect(result).toMatchObject({ kind: "unavailable", reason: "busy" });
    expect(elapsed).toBeLessThan(2000);
    writer.exec("ROLLBACK");
  });
});

describe("Test 6: the rollout-freshness canary", () => {
  function eightThreads(): FakeThread[] {
    return Array.from({ length: 8 }, (_, index) => ({
      id: `thread-${index}`,
      updatedAtMs: NOW - (index + 1) * MINUTE,
    }));
  }

  it("reads healthy rollouts as ok", () => {
    const fake = makeHome("current", eightThreads());
    expect(readerFor(fake).readThreads(BASE).kind).toBe("ok");
  });

  it("reads missing rollouts for three recent threads as format-changed", () => {
    const threads = eightThreads();
    home = createFakeCodexHome({
      rollouts: rolloutsFor(threads.slice(3)),
      database: { ddl: "current", threads },
    });
    const result = readerFor(home).readThreads(BASE);
    expect(result).toMatchObject({ kind: "unavailable", reason: "format-changed" });
  });

  it("reads rollouts much older than their threads as format-changed", () => {
    const fake = makeHome("current", eightThreads(), { olderByMs: 60 * MINUTE });
    expect(readerFor(fake).readThreads(BASE)).toMatchObject({
      kind: "unavailable",
      reason: "format-changed",
    });
  });

  it("tolerates one or two missing rollouts", () => {
    const threads = eightThreads();
    home = createFakeCodexHome({
      rollouts: rolloutsFor(threads.slice(2)),
      database: { ddl: "current", threads },
    });
    expect(readerFor(home).readThreads(BASE).kind).toBe("ok");
  });
});

describe("Test 7: newest cli version and hidden sources", () => {
  const mixed: FakeThread[] = [
    { id: "t-cli", updatedAtMs: NOW - MINUTE, cliVersion: "0.159.2" },
    { id: "t-new", updatedAtMs: NOW - 2 * MINUTE, cliVersion: "0.160.0", source: "exec" },
    {
      id: "t-pre",
      updatedAtMs: NOW - 3 * MINUTE,
      cliVersion: "0.155.0-alpha.9.2",
      source: "vscode",
    },
    { id: "t-bad", updatedAtMs: NOW - 4 * MINUTE, cliVersion: "not a version; DROP" },
    { id: "t-review", updatedAtMs: NOW - 5 * MINUTE, source: '{"subagent":"review"}' },
    {
      id: "t-spawn",
      updatedAtMs: NOW - 6 * MINUTE,
      source: '{"subagent":{"thread_spawn":{"parent_thread_id":"DECOY-PARENT-ID"}}}',
    },
    {
      id: "t-guard",
      updatedAtMs: NOW - 7 * MINUTE,
      source: '{"subagent":{"other":"guardian"}}',
    },
  ];

  it("returns the highest valid cli version and ignores an off-shape one", () => {
    const fake = makeHome("current", mixed);
    const result = readerFor(fake).readThreads(BASE);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.newestCliVersion).toBe("0.160.0");
    const bad = result.threads.find((row) => row.id === "t-bad");
    expect(bad?.cliVersion).toBeNull();
  });

  it("counts hidden children and does not return them", () => {
    const fake = makeHome("current", mixed);
    const result = readerFor(fake).readThreads(BASE);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.hiddenCount).toBe(2);
    const ids = result.threads.map((row) => row.id);
    expect(ids).not.toContain("t-spawn");
    expect(ids).not.toContain("t-guard");
    expect(ids).toContain("t-review");
    expect(result.threads.find((row) => row.id === "t-review")?.origin).toBe("review");
    expect(JSON.stringify(result)).not.toContain("DECOY-PARENT-ID");
  });
});
