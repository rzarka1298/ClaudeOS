import { describe, expect, it } from "vitest";
import {
  at,
  CODEX_CONTENT_SENTINEL,
  completedRollout,
  DECOY_CREATOR_ACCOUNT,
  DECOY_CREATOR_USER,
  DECOY_INSTRUCTIONS,
  errorLine,
  rawCounters,
  responseItemLine,
  rolloutText,
  sessionMetaLine,
  structuredLimitErrorLine,
  subAgentRollout,
  taskCompleteLine,
  taskStartedLine,
  tokenCountLine,
  tokenUsageRecordLine,
  turnAbortedLine,
  turnId,
} from "../../test-support/codex-rollouts.js";
import { EMPTY_CARRY, MAX_LINE_BYTES } from "../../transcripts/split-lines.js";
import {
  CODEX_INACTIVITY_MS,
  deriveLifecycle,
  parseRolloutChunk,
  type RolloutFact,
} from "./rollout.js";

const encoder = new TextEncoder();

function parseAll(text: string): RolloutFact[] {
  return [...parseRolloutChunk(text).facts];
}

/** Feeds the bytes in two chunks split at `offset`, threading the carry. */
function parseSplitAt(text: string, offset: number): RolloutFact[] {
  const bytes = encoder.encode(text);
  const first = parseRolloutChunk(bytes.subarray(0, offset), EMPTY_CARRY);
  const second = parseRolloutChunk(bytes.subarray(offset), first.carry);
  return [...first.facts, ...second.facts];
}

const NOW = Date.parse(at(0)) + 10 * 60 * 1000;

function derive(facts: readonly RolloutFact[], lastActivityAgoMs: number) {
  return deriveLifecycle(facts, {
    nowMs: NOW,
    inactivityMs: CODEX_INACTIVITY_MS,
    lastActivityMs: NOW - lastActivityAgoMs,
  });
}

const MIN = 60 * 1000;

describe("Test 1 (tracer): a synthetic rollout becomes facts and a lifecycle state", () => {
  it("parses into a meta fact and two lifecycle facts and no content", () => {
    const facts = parseAll(completedRollout());
    expect(facts.map((f) => f.kind)).toEqual(["meta", "lifecycle", "lifecycle"]);
    expect(facts[1]).toMatchObject({ event: "task_started", turnId: turnId(1) });
    expect(facts[2]).toMatchObject({ event: "task_complete", turnId: turnId(1) });
    expect(JSON.stringify(facts)).not.toContain(CODEX_CONTENT_SENTINEL);
  });

  it("produces identical facts when the bytes are split at every offset", () => {
    const text = completedRollout();
    const whole = parseAll(text);
    const length = encoder.encode(text).length;
    for (let offset = 0; offset <= length; offset += 1) {
      expect(parseSplitAt(text, offset)).toEqual(whole);
    }
  });

  it("derives completed when the last lifecycle event is task_complete", () => {
    const result = derive(parseAll(completedRollout()), 10 * MIN);
    expect(result.state).toBe("completed");
    expect(result.display).toBe("completed");
    expect(result.lastEvent).toBe("task_complete");
    expect(result.lastEventAt).toBe(at(60));
  });
});

describe("Test 2: running only inside the inactivity window, stale outside it", () => {
  const facts = parseAll(
    rolloutText([sessionMetaLine(), taskStartedLine(turnId(1), at(2)), responseItemLine()]),
  );

  it("is running with activity 5 minutes ago", () => {
    const result = derive(facts, 5 * MIN);
    expect(result.state).toBe("running");
    expect(result.display).toBe("running");
  });

  it("is stale, never completed, with activity 31 minutes ago", () => {
    const result = derive(facts, 31 * MIN);
    expect(result.state).toBe("stale");
    expect(result.display).toBe("stale");
    expect(result.state).not.toBe("completed");
  });

  it("treats exactly the window as still running", () => {
    expect(derive(facts, CODEX_INACTIVITY_MS).state).toBe("running");
    expect(derive(facts, CODEX_INACTIVITY_MS + 1).state).toBe("stale");
  });

  it("defaults the inactivity window to 30 minutes", () => {
    expect(CODEX_INACTIVITY_MS).toBe(30 * 60 * 1000);
  });
});

describe("Test 3: a sub-agent rollout that inherits the parent's task_started", () => {
  it("returns completed because the last lifecycle event wins, not turn-id pairing", () => {
    const facts = parseAll(subAgentRollout());
    const lifecycle = facts.filter((f) => f.kind === "lifecycle");
    expect(lifecycle).toHaveLength(3);
    expect(lifecycle[0]).toMatchObject({ event: "task_started", turnId: turnId(90) });
    expect(derive(facts, 10 * MIN).state).toBe("completed");
  });
});

describe("Test 4: cancelled and no-lifecycle rollouts", () => {
  it("returns cancelled when the last event is turn_aborted", () => {
    const facts = parseAll(
      rolloutText([
        sessionMetaLine(),
        taskStartedLine(turnId(1), at(2)),
        turnAbortedLine(turnId(1), at(30)),
      ]),
    );
    const result = derive(facts, 40 * MIN);
    expect(result.state).toBe("cancelled");
    expect(result.display).toBe("cancelled");
  });

  it("lets a later task_started reopen after a task_complete", () => {
    const facts = parseAll(
      rolloutText([
        taskStartedLine(turnId(1), at(2)),
        taskCompleteLine(turnId(1), at(10)),
        taskStartedLine(turnId(2), at(20)),
      ]),
    );
    expect(derive(facts, 2 * MIN).state).toBe("running");
  });

  it("returns none for no lifecycle event; old activity displays as stale, fresh as not yet listed", () => {
    const facts = parseAll(rolloutText([sessionMetaLine(), responseItemLine()]));
    const old = derive(facts, 90 * MIN);
    expect(old.state).toBe("none");
    expect(old.display).toBe("stale");
    const fresh = derive(facts, 1 * MIN);
    expect(fresh.state).toBe("none");
    expect(fresh.display).toBeNull();
  });
});

describe("Test 5: the session_meta fact is allowlisted", () => {
  it("has exactly the allowlisted keys and no creator id or instructions", () => {
    const [meta] = parseAll(rolloutText([sessionMetaLine()]));
    expect(meta).toBeDefined();
    expect(Object.keys(meta ?? {}).sort()).toEqual(
      ["cliVersion", "cwd", "id", "kind", "originator", "source", "time"].sort(),
    );
    expect(meta).toMatchObject({
      kind: "meta",
      id: "thread-aaaa1111",
      cwd: "/Users/USERNAME/repo",
      cliVersion: "0.159.2",
      originator: "codex_cli_rs",
      source: "cli",
      time: at(0),
    });
    const serialized = JSON.stringify(meta);
    for (const decoy of [DECOY_CREATOR_USER, DECOY_CREATOR_ACCOUNT, DECOY_INSTRUCTIONS]) {
      expect(serialized).not.toContain(decoy);
    }
  });

  it("reduces an object source to a canonical string without parent identifiers", () => {
    const [review] = parseAll(rolloutText([sessionMetaLine({ source: { subagent: "review" } })]));
    expect(review).toMatchObject({ source: '{"subagent":"review"}' });
    const [spawn] = parseAll(
      rolloutText([
        sessionMetaLine({
          source: { subagent: { thread_spawn: { parent_thread_id: "DECOY-PARENT-ID", depth: 1 } } },
        }),
      ]),
    );
    expect(JSON.stringify(spawn)).not.toContain("DECOY-PARENT-ID");
    expect(spawn).toMatchObject({ source: '{"subagent":{"thread_spawn":{}}}' });
  });

  it("omits off-shape and over-long values instead of rendering them", () => {
    const [meta] = parseAll(
      rolloutText([sessionMetaLine({ cliVersion: "x".repeat(200), originator: "bad\u0007value" })]),
    );
    expect(meta).toMatchObject({ cliVersion: null, originator: null });
  });
});

describe("Test 6: line limits, carry and unrecognised lines", () => {
  it("skips and counts a line over MAX_LINE_BYTES without throwing", () => {
    const huge = new Uint8Array(MAX_LINE_BYTES + 10).fill(0x61);
    const tail = encoder.encode(`\n${sessionMetaLine()}\n`);
    const joined = new Uint8Array(huge.length + tail.length);
    joined.set(huge, 0);
    joined.set(tail, huge.length);
    const result = parseRolloutChunk(joined, EMPTY_CARRY);
    expect(result.stats.oversized).toBe(1);
    expect(result.facts.map((f) => f.kind)).toEqual(["meta"]);
    expect(result.bytesConsumed).toBe(joined.length);
  });

  it("carries a partial line across a chunk boundary and completes it", () => {
    const text = rolloutText([taskStartedLine(turnId(1), at(2))]);
    const bytes = encoder.encode(text);
    const first = parseRolloutChunk(bytes.subarray(0, 20), EMPTY_CARRY);
    expect(first.facts).toEqual([]);
    expect(first.carry.bytes.length).toBe(20);
    expect(first.bytesConsumed).toBe(0);
    const second = parseRolloutChunk(bytes.subarray(20), first.carry);
    expect(second.facts.map((f) => f.kind)).toEqual(["lifecycle"]);
    expect(first.bytesConsumed + second.bytesConsumed).toBe(bytes.length);
  });

  it("counts invalid JSON and unknown line types as unrecognised without throwing", () => {
    const text = rolloutText([
      "{not json",
      "[1,2]",
      '{"type":"brand_new_thing"}',
      sessionMetaLine(),
    ]);
    const result = parseRolloutChunk(text, EMPTY_CARRY);
    expect(result.stats.unrecognized).toBe(3);
    expect(result.stats.recognized).toBe(1);
    expect(result.stats.lines).toBe(4);
    expect(result.facts.map((f) => f.kind)).toEqual(["meta"]);
  });
});

describe("Test 7: a limit hit is a boolean fact with no message text", () => {
  it("yields a limit-hit fact with a time from a usage-limit error message", () => {
    const facts = parseAll(
      rolloutText([
        taskStartedLine(turnId(1), at(2)),
        errorLine(
          `${CODEX_CONTENT_SENTINEL} You've hit your usage limit. Try again later.`,
          at(40),
        ),
      ]),
    );
    const hit = facts.find((f) => f.kind === "limit-hit");
    expect(hit).toEqual({ kind: "limit-hit", time: at(40) });
    expect(JSON.stringify(facts)).not.toContain(CODEX_CONTENT_SENTINEL);
  });

  it("recognises a stream_error event and the structured usage_limit_reached marker", () => {
    const streamed = parseAll(
      rolloutText([errorLine("Usage limit reached", at(41), "stream_error")]),
    );
    expect(streamed.map((f) => f.kind)).toEqual(["limit-hit"]);
    const structured = parseAll(rolloutText([structuredLimitErrorLine(at(42))]));
    expect(structured).toEqual([{ kind: "limit-hit", time: at(42) }]);
  });

  it("does not report a limit hit for an unrelated error", () => {
    expect(parseAll(rolloutText([errorLine("connection reset by peer", at(40))]))).toEqual([]);
  });

  it("reports whether a limit hit follows the last lifecycle event", () => {
    const hitAfter = parseAll(
      rolloutText([taskStartedLine(turnId(1), at(2)), errorLine("usage limit", at(40))]),
    );
    expect(derive(hitAfter, 2 * MIN).limitHitAfter).toBe(true);
    const hitBefore = parseAll(
      rolloutText([errorLine("usage limit", at(1)), taskStartedLine(turnId(1), at(2))]),
    );
    expect(derive(hitBefore, 2 * MIN).limitHitAfter).toBe(false);
  });
});

describe("token and rate-limit facts (one line walker)", () => {
  it("keeps six counters on a cumulative token_count and drops every other key", () => {
    const facts = parseAll(
      rolloutText([tokenCountLine({ total: rawCounters(100, 20, { cached_input_tokens: 30 }) })]),
    );
    const cumulative = facts.find((f) => f.kind === "tokens-cumulative");
    expect(cumulative).toMatchObject({
      counters: {
        input: 100,
        cachedInput: 30,
        cacheWrite: 0,
        output: 20,
        reasoningOutput: 0,
        total: 120,
      },
    });
  });

  it("emits a null-counter cumulative fact for info: null", () => {
    const facts = parseAll(rolloutText([tokenCountLine({ total: null, rateLimits: null })]));
    expect(facts).toEqual([{ kind: "tokens-cumulative", time: at(20), counters: null }]);
  });

  it("keeps the allowlisted rate-limit keys and drops credits, plan and individual limit", () => {
    const facts = parseAll(rolloutText([tokenCountLine()]));
    const limits = facts.find((f) => f.kind === "rate-limits");
    expect(limits).toMatchObject({
      limits: {
        limitId: "codex",
        limitName: null,
        primary: { usedPercent: 12.5, windowMinutes: 300, resetsAt: 1_791_000_000 },
        secondary: { usedPercent: 7, windowMinutes: 10_080, resetsAt: 1_791_500_000 },
        reachedType: null,
      },
    });
    const serialized = JSON.stringify(facts);
    for (const decoy of ["DECOY-CREDITS-BALANCE", "DECOY-INDIVIDUAL-LIMIT", "DECOY-PLAN-TYPE"]) {
      expect(serialized).not.toContain(decoy);
    }
  });

  it("emits a tokens-turn fact keyed by thread and turn from token_usage_record", () => {
    const facts = parseAll(
      rolloutText([tokenUsageRecordLine({ turn: turnId(1), turnUsage: rawCounters(50, 10) })]),
    );
    expect(facts).toEqual([
      {
        kind: "tokens-turn",
        threadId: "thread-aaaa1111",
        turnId: turnId(1),
        time: at(21),
        counters: {
          input: 50,
          cachedInput: 0,
          cacheWrite: 0,
          output: 10,
          reasoningOutput: 0,
          total: 60,
        },
      },
    ]);
  });

  it("falls back to zero for one missing counter member only", () => {
    const { cache_write_input_tokens: _omit, ...fiveOfSix } = rawCounters(10, 5);
    const [fact] = parseAll(
      rolloutText([tokenUsageRecordLine({ turn: turnId(1), turnUsage: fiveOfSix })]),
    );
    expect(fact).toMatchObject({ counters: { cacheWrite: 0, input: 10, output: 5 } });
    const [bad] = parseAll(
      rolloutText([
        tokenUsageRecordLine({
          turn: turnId(1),
          turnUsage: { input_tokens: 10 },
        }),
      ]),
    );
    expect(bad).toMatchObject({ kind: "tokens-turn", counters: null });
  });
});
