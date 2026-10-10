import { mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CodexSessionsSnapshot, CodexSessionsSnapshotSchema } from "@ccc/domain";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRunWorld,
  DECOY_LOG_CONTENT,
  DECOY_REPORT_TEXT,
  DECOY_WORKTREE,
  nextRunId,
  type RunWorld,
  recordingRunFs,
  runIdAt,
  SESSION_A,
  SESSION_B,
  symlinkSessionsDir,
  writeLiveLog,
  writePendingResume,
  writeRawSessionFile,
  writeReportDecoy,
  writeRunRecord,
  writeSymlinkRecord,
} from "../test-support/codex-run-fixtures.js";
import {
  createRunRecordReader,
  MAX_RECORD_BYTES,
  nodeRunRecordFs,
  parsePendingResume,
  parseRunRecord,
  SKIP_REASONS,
  summarizePausedRuns,
} from "./run-records.js";

let world: RunWorld | undefined;
afterEach(() => {
  world?.cleanup();
  world = undefined;
});

function newWorld(): RunWorld {
  world = createRunWorld();
  return world;
}

function readerFor(w: RunWorld, over: Partial<Parameters<typeof createRunRecordReader>[0]> = {}) {
  return createRunRecordReader({
    listProjects: () => w.listProjects(),
    bridgeStateDir: w.bridgeState,
    home: w.home,
    fs: nodeRunRecordFs,
    ...over,
  });
}

const NO_SKIPS = Object.fromEntries(SKIP_REASONS.map((reason) => [reason, 0]));

describe("Test 2: the reader scans both candidate directories and merges by run id", () => {
  it("reads the project-local and the bridge-state directory, the newer start time wins, an absent project yields nothing", async () => {
    const w = newWorld();
    const project = w.addProject();
    const empty = w.addProject();
    const local = writeRunRecord(project.localState, { sessionId: SESSION_A });
    const user = writeRunRecord(project.userState, { sessionId: SESSION_B, kind: "task" });
    const shared = runIdAt(Date.UTC(2026, 9, 10, 13, 0, 0));
    writeRunRecord(project.localState, {
      runId: shared,
      startedAt: "2026-10-10T13:00:00.000Z",
      status: "running",
    });
    writeRunRecord(project.userState, {
      runId: shared,
      startedAt: "2026-10-10T13:00:05.000Z",
      status: "ok",
      finishedAt: "2026-10-10T13:01:00.000Z",
    });

    const scan = await readerFor(w).scan();
    const byId = new Map(scan.runs.map((run) => [run.runId, run]));
    expect(scan.runs).toHaveLength(3);
    expect(byId.get(local.runId)).toMatchObject({
      projectId: project.projectId,
      sessionId: SESSION_A,
      kind: "review",
    });
    expect(byId.get(user.runId)).toMatchObject({ sessionId: SESSION_B, kind: "task" });
    expect(byId.get(shared)).toMatchObject({ status: "ok", startedAt: "2026-10-10T13:00:05.000Z" });
    // Newest first.
    expect(scan.runs.map((run) => run.startedAt)).toEqual(
      [...scan.runs.map((run) => run.startedAt)].sort().reverse(),
    );
    expect(scan.runs.every((run) => run.projectId !== empty.projectId)).toBe(true);
    expect(scan.skipped).toEqual(NO_SKIPS);
    // Each run keeps the real path of the directory it came from, privately.
    expect(byId.get(local.runId)?.stateDir).toBe(project.localState);
    expect(byId.get(user.runId)?.stateDir).toBe(project.userState);
  });

  it("answers an empty scan with no error when nothing exists", async () => {
    const w = newWorld();
    w.addProject();
    const scan = await readerFor(w).scan();
    expect(scan.runs).toEqual([]);
    expect(scan.pending).toEqual([]);
    expect(scan.skipped).toEqual(NO_SKIPS);
    expect(scan.signature).toBe("");
  });

  it("reads pending-resume.json from both directories", async () => {
    const w = newWorld();
    const project = w.addProject();
    writePendingResume(project.localState, {
      sessionId: SESSION_A,
      resetsAt: "2026-10-14T00:00:00.000Z",
    });
    writePendingResume(project.userState, { sessionId: SESSION_B, resetsAt: null, kind: "review" });
    const scan = await readerFor(w).scan();
    expect(scan.pending.map((p) => [p.sessionId, p.resetsAt, p.kind]).sort()).toEqual(
      [
        [SESSION_A, "2026-10-14T00:00:00.000Z", "task"],
        [SESSION_B, null, "review"],
      ].sort(),
    );
    expect(scan.pending.every((p) => p.projectId === project.projectId)).toBe(true);
  });
});

describe("Test 3: the allowlisted schemas keep named fields and drop everything else", () => {
  it("drops the worktree, fallback and report text keys from the parsed value", () => {
    const raw = {
      schemaVersion: 1,
      runId: "20261010T120000001Z",
      kind: "review",
      role: "review",
      sessionId: SESSION_A,
      worktree: DECOY_WORKTREE,
      fallback: { reason: "DECOY-FALLBACK" },
      reportText: DECOY_REPORT_TEXT,
      model: "gpt-synthetic",
      effort: "high",
      startedAt: "2026-10-10T12:00:00.001Z",
      mode: "headless",
      status: "ok",
      resetsAt: null,
      finishedAt: "2026-10-10T12:05:00.000Z",
    };
    const parsed = parseRunRecord(raw, "20261010T120000001Z");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.keys(parsed.value).sort()).toEqual(
      [
        "finishedAt",
        "kind",
        "mode",
        "resetsAt",
        "role",
        "runId",
        "sessionId",
        "startedAt",
        "status",
      ].sort(),
    );
    expect(JSON.stringify(parsed.value)).not.toContain("DECOY");
  });

  it("drops extra keys of the pending-resume record", () => {
    const parsed = parsePendingResume({
      schemaVersion: 1,
      sessionId: SESSION_A,
      runId: "20261010T120000001Z",
      kind: "task",
      role: "task",
      worktree: DECOY_WORKTREE,
      resetsAt: "2026-10-14T00:00:00.000Z",
      recordedAt: "2026-10-10T12:00:00.000Z",
      note: DECOY_REPORT_TEXT,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.keys(parsed.value).sort()).toEqual(
      ["kind", "recordedAt", "resetsAt", "role", "runId", "sessionId"].sort(),
    );
  });

  it("treats an absent schemaVersion as version 0, accepts 1 and skips 2 as unsupported", async () => {
    const w = newWorld();
    const project = w.addProject();
    const v0 = writeRunRecord(project.localState, { omit: ["schemaVersion"] });
    const v1 = writeRunRecord(project.localState, {});
    writeRunRecord(project.localState, { extra: { schemaVersion: 2 } });
    writeRunRecord(project.localState, { extra: { schemaVersion: "1" } });
    const scan = await readerFor(w).scan();
    expect(scan.runs.map((run) => run.runId).sort()).toEqual([v0.runId, v1.runId].sort());
    expect(scan.skipped["unsupported-version"]).toBe(1);
    expect(scan.skipped["bad-shape"]).toBe(1);
  });

  it("keeps a session id that is not a UUID as null instead of skipping the record", async () => {
    const w = newWorld();
    const project = w.addProject();
    const odd = writeRunRecord(project.localState, { sessionId: "not-a-uuid" });
    const none = writeRunRecord(project.localState, { sessionId: null });
    const scan = await readerFor(w).scan();
    expect(scan.runs.map((run) => [run.runId, run.sessionId]).sort()).toEqual(
      [
        [odd.runId, null],
        [none.runId, null],
      ].sort(),
    );
    expect(scan.skipped).toEqual(NO_SKIPS);
  });

  it("accepts every status the wrappers write and the refused status of a guard refusal", async () => {
    const w = newWorld();
    const project = w.addProject();
    const statuses = ["running", "ok", "limit", "timeout", "failed", "refused"];
    for (const status of statuses) writeRunRecord(project.localState, { status });
    const scan = await readerFor(w).scan();
    expect(scan.runs.map((run) => run.status).sort()).toEqual([...statuses].sort());
  });

  it("never reads the report files and keeps the decoy text out of the scan", async () => {
    const w = newWorld();
    const project = w.addProject();
    const record = writeRunRecord(project.localState, { decoys: true });
    writeReportDecoy(project.localState, record.runId);
    const recorded = recordingRunFs(nodeRunRecordFs);
    const scan = await readerFor(w, { fs: recorded.fs }).scan();
    expect(scan.runs).toHaveLength(1);
    expect(recorded.calls.some((call) => call.path.includes("/reports"))).toBe(false);
    const run = scan.runs[0];
    expect(Object.keys(run ?? {}).sort()).toEqual(
      [
        "finishedAt",
        "kind",
        "liveLog",
        "mode",
        "projectId",
        "projectName",
        "projectRoot",
        "resetsAt",
        "role",
        "runId",
        "sessionId",
        "startedAt",
        "stateDir",
        "status",
        "worktree",
      ].sort(),
    );
    expect(run?.worktree).toBe(DECOY_WORKTREE);
    expect(run?.liveLog).toEqual({ kind: "missing" });
  });
});

describe("Test 4: hostile files are skipped and counted by reason, never thrown", () => {
  it("counts a symlink, an oversize file, a bad name, bad JSON, a wrong shape, an id mismatch and a directory", async () => {
    const w = newWorld();
    const project = w.addProject();
    const outside = join(w.base, "outside");
    mkdirSync(outside, { recursive: true });
    const elsewhere = writeRunRecord(outside, { runId: runIdAt(Date.UTC(2026, 9, 10, 9, 0, 0)) });

    writeSymlinkRecord(project.localState, nextRunId(), elsewhere.path);
    writeRawSessionFile(
      project.localState,
      `${nextRunId()}.json`,
      `${JSON.stringify({ padding: "x".repeat(MAX_RECORD_BYTES + 10) })}\n`,
    );
    writeRawSessionFile(project.localState, "not-a-run-id.json", "{}");
    writeRawSessionFile(project.localState, "notes.txt", "hello");
    writeRawSessionFile(project.localState, `${nextRunId()}.json`, "{not json");
    writeRunRecord(project.localState, { status: 7 as unknown as string });
    writeRunRecord(project.localState, { status: "zzz" });
    writeRunRecord(project.localState, { startedAt: "yesterday" });
    const mismatched = nextRunId();
    writeRunRecord(project.localState, { runId: nextRunId() });
    writeRawSessionFile(
      project.localState,
      `${mismatched}.json`,
      JSON.stringify({
        runId: nextRunId(),
        kind: "review",
        status: "ok",
        startedAt: "2026-10-10T12:00:00.000Z",
      }),
    );
    mkdirSync(join(project.localState, "sessions", `${nextRunId()}.json`));
    // A temporary file of the wrapper's atomic writer is not a record and not counted.
    writeRawSessionFile(project.localState, `.${nextRunId()}.json.1.tmp`, "{");

    const scan = await readerFor(w).scan();
    expect(scan.runs).toHaveLength(1);
    expect(scan.skipped).toEqual({
      ...NO_SKIPS,
      symlink: 1,
      oversize: 1,
      "bad-name": 2,
      "bad-json": 1,
      "bad-shape": 3,
      "id-mismatch": 1,
      "not-regular": 1,
    });
  });

  it("skips a sessions directory that resolves outside its root and a symlinked pending-resume file", async () => {
    const w = newWorld();
    const project = w.addProject();
    const other = w.addProject();
    const outside = join(w.base, "outside");
    mkdirSync(outside, { recursive: true });
    writeRunRecord(outside, {});
    symlinkSessionsDir(project.localState, join(outside, "sessions"));
    const target = join(outside, "pending-target.json");
    writeFileSync(
      target,
      JSON.stringify({
        sessionId: SESSION_A,
        runId: nextRunId(),
        kind: "task",
        role: null,
        resetsAt: null,
        recordedAt: "2026-10-10T12:00:00.000Z",
      }),
    );
    mkdirSync(other.localState, { recursive: true });
    symlinkSync(target, join(other.localState, "pending-resume.json"));

    const scan = await readerFor(w).scan();
    expect(scan.runs).toEqual([]);
    expect(scan.pending).toEqual([]);
    expect(scan.skipped["outside-root"]).toBe(1);
    expect(scan.skipped.symlink).toBe(1);
  });

  it("skips an oversize and a malformed pending-resume file", async () => {
    const w = newWorld();
    const project = w.addProject();
    const other = w.addProject();
    mkdirSync(project.localState, { recursive: true });
    writeFileSync(
      join(project.localState, "pending-resume.json"),
      JSON.stringify({ padding: "x".repeat(MAX_RECORD_BYTES + 10) }),
    );
    writePendingResume(other.localState, { sessionId: "nope" });
    const scan = await readerFor(w).scan();
    expect(scan.pending).toEqual([]);
    expect(scan.skipped.oversize).toBe(1);
    expect(scan.skipped["bad-shape"]).toBe(1);
  });

  it("reads at most 100 records per directory, newest names first, and counts the rest", async () => {
    const w = newWorld();
    const project = w.addProject();
    const base = Date.UTC(2026, 9, 11, 0, 0, 0);
    const ids: string[] = [];
    for (let i = 0; i < 120; i += 1) {
      const runId = runIdAt(base + i);
      ids.push(runId);
      writeRunRecord(project.localState, { runId });
    }
    const scan = await readerFor(w).scan();
    expect(scan.runs).toHaveLength(100);
    const read = new Set(scan.runs.map((run) => run.runId));
    for (const runId of ids.slice(20)) expect(read.has(runId)).toBe(true);
    for (const runId of ids.slice(0, 20)) expect(read.has(runId)).toBe(false);
    expect(scan.skipped.capped).toBe(20);
  });

  it("honours a smaller injected record cap and size limit", async () => {
    const w = newWorld();
    const project = w.addProject();
    for (let i = 0; i < 6; i += 1) writeRunRecord(project.localState, {});
    const scan = await readerFor(w, { maxRecordsPerDir: 3, maxRecordBytes: 512 }).scan();
    expect(scan.runs).toHaveLength(3);
    expect(scan.skipped.capped).toBe(3);
    const tiny = await readerFor(w, { maxRecordBytes: 64 }).scan();
    expect(tiny.runs).toEqual([]);
    expect(tiny.skipped.oversize).toBe(6);
  });

  it("a bridge state directory outside the home is never scanned", async () => {
    const w = newWorld();
    const project = w.addProject();
    const stray = join(w.base, "not-home-state");
    const strayState = join(stray, "projects");
    writeRunRecord(join(strayState, "x"), {});
    const scan = await readerFor(w, { bridgeStateDir: stray }).scan();
    expect(scan.runs).toEqual([]);
    expect(scan.skipped["outside-root"]).toBe(1);
    expect(project.userState.startsWith(w.bridgeState)).toBe(true);
  });

  it("never throws when the project list or the filesystem fails", async () => {
    const w = newWorld();
    w.addProject();
    const exploding = createRunRecordReader({
      listProjects: () => {
        throw new Error("boom /Users/USERNAME/secret");
      },
      bridgeStateDir: w.bridgeState,
      home: w.home,
    });
    expect((await exploding.scan()).runs).toEqual([]);
    const failingFs = createRunRecordReader({
      listProjects: () => w.listProjects(),
      bridgeStateDir: w.bridgeState,
      home: w.home,
      fs: {
        lstat: () => Promise.reject(new Error("nope")),
        realpath: () => Promise.reject(new Error("nope")),
        readdir: () => Promise.reject(new Error("nope")),
        readFile: () => Promise.reject(new Error("nope")),
      },
    });
    expect((await failingFs.scan()).runs).toEqual([]);
  });
});

describe("Test 5 (reader half): the live log is inspected with lstat and realpath only", () => {
  it("inspects a running headless record's log and nothing else, and never opens its content", async () => {
    const w = newWorld();
    const project = w.addProject();
    const headless = writeRunRecord(project.localState, { mode: "headless", sessionId: SESSION_A });
    const tui = writeRunRecord(project.localState, { mode: "tui", sessionId: SESSION_B });
    const done = writeRunRecord(project.localState, { mode: "headless", status: "ok" });
    const missing = writeRunRecord(project.localState, { mode: "headless" });
    const linked = writeRunRecord(project.localState, { mode: "headless" });
    const logMtime = Date.now() - 5_000;
    writeLiveLog(project.localState, headless.runId, "review", { mtimeMs: logMtime });
    writeLiveLog(project.localState, tui.runId, "review", { mtimeMs: logMtime });
    writeLiveLog(project.localState, done.runId, "review", { mtimeMs: logMtime });
    const real = join(w.base, "elsewhere.log");
    writeFileSync(real, DECOY_LOG_CONTENT);
    mkdirSync(join(project.localState, "live"), { recursive: true });
    symlinkSync(real, join(project.localState, "live", `${linked.runId}-review.log`));

    const recorded = recordingRunFs(nodeRunRecordFs);
    const scan = await readerFor(w, { fs: recorded.fs }).scan();
    const byId = new Map(scan.runs.map((run) => [run.runId, run]));
    expect(byId.get(headless.runId)?.liveLog).toMatchObject({ kind: "live" });
    const live = byId.get(headless.runId)?.liveLog;
    expect(live?.kind === "live" ? Math.abs(live.mtimeMs - logMtime) < 2000 : false).toBe(true);
    expect(byId.get(tui.runId)?.liveLog).toBeNull();
    expect(byId.get(done.runId)?.liveLog).toBeNull();
    expect(byId.get(missing.runId)?.liveLog).toEqual({ kind: "missing" });
    expect(byId.get(linked.runId)?.liveLog).toEqual({ kind: "unsafe" });
    const logCalls = recorded.calls.filter((call) => call.path.endsWith(".log"));
    expect(logCalls.length).toBeGreaterThan(0);
    expect(logCalls.every((call) => call.op === "lstat" || call.op === "realpath")).toBe(true);
    expect(JSON.stringify(scan)).not.toContain(DECOY_LOG_CONTENT);
  });

  it("inspectLiveLog builds the path from the state directory, kind and run id and flags a log leaving the directory", async () => {
    const w = newWorld();
    const project = w.addProject();
    const record = writeRunRecord(project.localState, { mode: "headless" });
    const reader = readerFor(w);
    const scan = await reader.scan();
    const run = scan.runs[0];
    if (run === undefined) throw new Error("expected a run");
    expect(await reader.inspectLiveLog(run)).toEqual({ kind: "missing" });
    const path = writeLiveLog(project.localState, record.runId, "review", { mtimeMs: Date.now() });
    expect(await reader.inspectLiveLog(run)).toMatchObject({ kind: "live", path });
    // The live directory itself pointing outside the state directory is unsafe.
    const outside = join(w.base, "outside-live");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, `${record.runId}-review.log`), "x");
    rmSync(join(project.localState, "live"), { recursive: true });
    symlinkSync(outside, join(project.localState, "live"));
    expect(await reader.inspectLiveLog(run)).toEqual({ kind: "unsafe" });
  });
});

describe("Test 7 (reader half): the signature changes only when a record changes", () => {
  it("is stable for an unchanged scan and changes on add, rewrite and touch", async () => {
    const w = newWorld();
    const project = w.addProject();
    const first = writeRunRecord(project.localState, {});
    const reader = readerFor(w);
    const a = await reader.scan();
    const b = await reader.scan();
    expect(a.signature).not.toBe("");
    expect(b.signature).toBe(a.signature);
    expect(reader.last().signature).toBe(a.signature);

    writeRunRecord(project.localState, {});
    const added = await reader.scan();
    expect(added.signature).not.toBe(a.signature);

    writeRunRecord(project.localState, {
      runId: first.runId,
      status: "ok",
      finishedAt: "2026-10-10T12:30:00.000Z",
    });
    const rewritten = await reader.scan();
    expect(rewritten.signature).not.toBe(added.signature);

    const when = new Date(Date.now() + 60_000);
    utimesSync(first.path, when, when);
    const touched = await reader.scan();
    expect(touched.signature).not.toBe(rewritten.signature);
  });

  it("ignores a live log's modification time", async () => {
    const w = newWorld();
    const project = w.addProject();
    const record = writeRunRecord(project.localState, { mode: "headless" });
    const log = writeLiveLog(project.localState, record.runId, "review", {
      mtimeMs: Date.now() - 10_000,
    });
    const reader = readerFor(w);
    const before = await reader.scan();
    const when = new Date();
    utimesSync(log, when, when);
    const after = await reader.scan();
    expect(after.signature).toBe(before.signature);
  });
});

describe("Test 6 (task 2): summarizePausedRuns is a pure function of the sessions snapshot", () => {
  const view = (
    threadId: string,
    state: string,
    resumesAfter: string | null,
  ): Record<string, unknown> => ({
    threadId,
    projectId: null,
    projectName: null,
    origin: "headless",
    state,
    model: null,
    effort: null,
    startedAt: "2026-10-10T10:00:00.000Z",
    lastActivityAt: "2026-10-10T11:00:00.000Z",
    resumesAfter,
    title: null,
    hasTranscript: true,
    liveLogRunId: null,
  });
  const snapshot = (sessions: Array<Record<string, unknown>>): CodexSessionsSnapshot =>
    CodexSessionsSnapshotSchema.parse({
      kind: "available",
      sessions,
      hiddenCount: 0,
      analysisOn: false,
      observedAt: "2026-10-10T12:00:00.000Z",
      freshness: "live",
      partiality: { partial: false },
    });

  it("is zero and null for no snapshot, an unavailable snapshot or no paused session", () => {
    const none = { count: 0, earliestResetAt: null, withoutResetAt: 0 };
    expect(summarizePausedRuns(null)).toEqual(none);
    expect(
      summarizePausedRuns(
        CodexSessionsSnapshotSchema.parse({
          kind: "unavailable",
          reason: "no-data",
          version: null,
        }),
      ),
    ).toEqual(none);
    expect(
      summarizePausedRuns(
        snapshot([view("a", "running", null), view("b", "completed", "2026-10-14T00:00:00.000Z")]),
      ),
    ).toEqual(none);
  });

  it("counts only limit-paused sessions, returns the earliest resume time and counts the ones without", () => {
    const result = summarizePausedRuns(
      snapshot([
        view("a", "limit-paused", "2026-10-15T00:00:00.000Z"),
        view("b", "limit-paused", "2026-10-14T06:00:00.000Z"),
        view("c", "limit-paused", null),
        view("d", "running", "2026-10-12T00:00:00.000Z"),
      ]),
    );
    expect(result).toEqual({
      count: 3,
      earliestResetAt: "2026-10-14T06:00:00.000Z",
      withoutResetAt: 1,
    });
  });

  it("reports a paused session with no reset time as count 1, null and 1 without", () => {
    expect(summarizePausedRuns(snapshot([view("a", "limit-paused", null)]))).toEqual({
      count: 1,
      earliestResetAt: null,
      withoutResetAt: 1,
    });
  });
});
