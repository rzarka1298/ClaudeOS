import type { RunId, SessionRun } from "@ccc/domain";
import { describe, expect, it } from "vitest";
import {
  at,
  fixedRunId,
  hook,
  InMemoryRunIndex,
  PID_1,
  SESSION_A,
  seedRun,
  sessionStart,
  startFacts,
  testRunIdMinter,
} from "../test-support/evidence.js";
import { type Evidence, type ReduceResult, reduce } from "./reducer.js";

/**
 * Codex advisory findings 2 and 5 (Phase 05 wave 5 remediation): a
 * SessionStart for an identity the index already holds must not open a
 * duplicate Run when it is a replay, and must not merge two executions
 * when the process start identity contradicts the held Run.
 */

const NOW = at(100_000);
const R1 = fixedRunId("codexone");
const START_1 = "Mon Sep 28 12:00:00 2026";
const START_2 = "Mon Sep 28 13:00:00 2026";

function play(initial: readonly SessionRun[], evidence: readonly Evidence[]) {
  const index = new InMemoryRunIndex(initial);
  const mint = testRunIdMinter("cdx");
  const results: ReduceResult[] = [];
  for (const item of evidence) {
    const result = reduce(index, item, NOW, mint);
    index.apply(result.upserts);
    results.push(result);
  }
  return { index, results };
}

describe("Codex 2: a replayed SessionStart older than its terminal Run opens nothing", () => {
  const completed = seedRun({
    runId: R1,
    pidStartedAt: START_1,
    state: "completed",
    startedAt: at(10),
    lastActivityAt: at(20),
    endedAt: at(30),
  });

  it("replaying a committed start/end pair after a restart leaves one completed Run", () => {
    const { index, results } = play(
      [completed],
      [
        // The process is gone at replay time, so its start is unknown.
        sessionStart("startup", { observedAt: at(10) }, startFacts({ pidStartedAt: null })),
        hook("SessionEnd", { observedAt: at(30), fields: { reason: "other" } }),
      ],
    );
    expect(index.all()).toHaveLength(1);
    expect(index.byRunId(R1)).toEqual(completed);
    expect(results[0]?.upserts).toEqual([]);
    expect(results[0]?.rejected).toEqual([
      { runId: R1, from: "completed", evidence: "hook:SessionStart", reason: "terminal" },
    ]);
  });

  it("a genuinely later start on the same identity still opens a new Run", () => {
    const { index } = play(
      [completed],
      [sessionStart("resume", { observedAt: at(40) }, startFacts({ pidStartedAt: START_1 }))],
    );
    expect(index.all()).toHaveLength(2);
    const opened = index.all().find((run) => run.runId !== R1);
    expect(opened).toMatchObject({ state: "running", linkKind: "resume", linkedFromRunId: R1 });
  });
});

describe("Codex 5: a start whose process start contradicts the held Run is another execution", () => {
  it("a resume that reuses a stale Run's pid opens a linked Run instead of reviving the old one", () => {
    const stale = seedRun({
      runId: R1,
      pidStartedAt: START_1,
      state: "stale",
      startedAt: at(10),
      lastActivityAt: at(20),
    });
    const { index } = play(
      [stale],
      [sessionStart("resume", { observedAt: at(500) }, startFacts({ pidStartedAt: START_2 }))],
    );
    expect(index.byRunId(R1)).toEqual(stale);
    const opened = index.all().find((run) => run.runId !== R1) as SessionRun;
    expect(opened).toMatchObject({
      state: "running",
      pid: PID_1,
      pidStartedAt: START_2,
      claudeSessionId: SESSION_A,
      linkKind: "resume",
      linkedFromRunId: R1,
      startedAt: at(500),
    });
  });

  it("a re-delivered start with a compatible (equal or unknown) process start still updates in place", () => {
    const running = seedRun({ runId: R1, pidStartedAt: START_1, state: "stale" });
    for (const pidStartedAt of [START_1, null]) {
      const { index } = play(
        [running],
        [sessionStart("startup", { observedAt: at(50) }, startFacts({ pidStartedAt }))],
      );
      expect(index.all()).toHaveLength(1);
      expect(index.byRunId(R1 as RunId)).toMatchObject({ state: "running", pidStartedAt: START_1 });
    }
  });
});
