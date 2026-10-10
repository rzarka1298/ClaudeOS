import { statSync } from "node:fs";
import {
  appendToggleLog,
  queryCodexCoverage,
  queryCodexTokenTotals,
  resetCodexScanState,
} from "@ccc/operational-store";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTokenHarness,
  jsonl,
  metaLine,
  raw,
  rolloutName,
  THREAD_A,
  type TokenHarness,
  tokenCountLine,
  turn,
  turnRecordLine,
} from "../test-support/codex-token-fixtures.js";
import { CodexHomeAccessError } from "./codex-home.js";

/**
 * The reconciliation of the two token sources of one thread (plan 05.1-23):
 * ONE precedence rule, so the totals depend only on the records, never on the
 * chunk size, a cursor reset or a scanner restart.
 *
 *   A thread-cumulative record is authoritative up to and including its
 *   timestamp. Per-turn records count only for usage after the thread's LAST
 *   cumulative timestamp: the increment of the turn's within-turn counter
 *   beyond the value it had at that cut (a turn first seen after the cut counts
 *   in full). Per-turn records at or before the cut are ignored.
 */

const DAY = "2026-10-10";
const NAME = rolloutName("2026-10-10T08:00:00.000Z", THREAD_A);
const WIDE = { start: "2020-01-01T00:00:00.000Z", end: "2030-01-01T00:00:00.000Z" };

/** An instant on the test day: hh:mm:ss UTC. */
const t = (hh: number, mm: number, ss = 0): string =>
  `2026-10-10T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.000Z`;

const cum = (at: string, input: number) => tokenCountLine({ timestamp: at, total: raw(input, 0) });
const pt = (n: number, at: string, input: number) =>
  turnRecordLine({ turnId: turn(n), timestamp: at, usage: raw(input, 0) });

interface Scenario {
  readonly name: string;
  readonly lines: readonly string[];
  readonly expected: number;
  /** Optional per-quarter-hour expectation (bucket start -> input). */
  readonly buckets?: Readonly<Record<string, number>>;
  /** Analysis-off periods written to the toggle log before scanning. */
  readonly off?: ReadonlyArray<readonly [string, string]>;
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: "100 cumulative + 10 per-turn after it => 110, in one bucket",
    lines: [cum(t(10, 1), 100), pt(1, t(10, 2), 10)],
    expected: 110,
    buckets: { "2026-10-10T10:00:00.000Z": 110 },
  },
  {
    // Conflicts with the loose wording of the brief (100): under the rule a turn
    // first seen AFTER the last cumulative timestamp counts in full, so both
    // sources add up. Reported to the owner rather than special-cased.
    name: "cumulative 100 @10:21 then a new turn's per-turn 100 @10:30 => 200",
    lines: [cum(t(10, 21), 100), pt(1, t(10, 30), 100)],
    expected: 200,
    buckets: { "2026-10-10T10:15:00.000Z": 100, "2026-10-10T10:30:00.000Z": 100 },
  },
  {
    name: "per-turn 100 at the very instant of the last cumulative 100 => 100",
    lines: [cum(t(10, 21), 100), pt(1, t(10, 21), 100)],
    expected: 100,
  },
  {
    name: "a growing per-turn counter 100 -> 150 (no cumulative) => 150",
    lines: [pt(1, t(10, 1), 100), pt(1, t(10, 2), 150)],
    expected: 150,
  },
  {
    name: "a turn that began before the cut counts only its growth beyond the cut value => 150",
    lines: [pt(1, t(10, 1), 100), cum(t(10, 1), 100), pt(1, t(10, 2), 150)],
    expected: 150,
  },
  {
    name: "Codex repro 1: cum 100 @:01, per-turn 100 @:02, cum 100 @:02 => 100 (not 200)",
    lines: [cum(t(10, 1), 100), pt(1, t(10, 2), 100), cum(t(10, 2), 100)],
    expected: 100,
  },
  {
    name: "Codex repro 2: cum 100 @:01, growing per-turn 150 @:02 with cum 150 => 150 (not 250)",
    lines: [cum(t(10, 1), 100), pt(1, t(10, 2), 150), cum(t(10, 2), 150)],
    expected: 150,
  },
  {
    name: "repro 2 with the cumulative record first in file order => 150",
    lines: [cum(t(10, 1), 100), cum(t(10, 2), 150), pt(1, t(10, 2), 150)],
    expected: 150,
  },
  {
    name: "per-turn superseded by a later cumulative that covers it, then new growth => 160",
    lines: [cum(t(10, 1), 100), pt(1, t(10, 2), 40), cum(t(10, 3), 140), pt(1, t(10, 4), 60)],
    expected: 160,
  },
  {
    name: "analysis-off increment is never counted: 100 / 200 (off) / 300 => 200",
    lines: [pt(1, t(10, 0, 50), 100), pt(1, t(10, 2, 30), 200), pt(1, t(10, 4, 10), 300)],
    off: [[t(10, 2), t(10, 3)]],
    expected: 200,
  },
  {
    name: "analysis-off cumulative increment is never counted: 100 / 200 (off) / 300 => 200",
    lines: [cum(t(10, 0, 50), 100), cum(t(10, 2, 30), 200), cum(t(10, 4, 10), 300)],
    off: [[t(10, 2), t(10, 3)]],
    expected: 200,
  },
  {
    name: "a historical cumulative-only thread that later gets per-turn records: 100 + 10 => 110",
    lines: [cum(t(8, 0), 100), pt(1, t(10, 0, 30), 10)],
    expected: 110,
  },
  {
    name: "two turns across a cut: the old one superseded, the new one in full => 130",
    lines: [
      pt(1, t(10, 1), 50),
      pt(2, t(10, 1, 30), 30),
      cum(t(10, 2), 80),
      pt(2, t(10, 3), 80),
      pt(3, t(10, 4), 20),
    ],
    // cumulative covers 80 up to :02; turn 2 grew 30 -> 80 after the cut (+50); turn 3 is new (+20).
    expected: 150,
  },
];

// --- Routes ---------------------------------------------------------------------------

type Route =
  | {
      readonly kind: "groups";
      readonly size: number | "all";
      readonly restart?: boolean;
      readonly reset?: "each" | "end";
    }
  | { readonly kind: "bytes"; readonly chunkBytes: number; readonly reset?: "end" };

const ROUTES: ReadonlyArray<readonly [string, Route]> = [
  ["all in one", { kind: "groups", size: "all" }],
  ["1 record per chunk", { kind: "groups", size: 1 }],
  ["2 records per chunk", { kind: "groups", size: 2 }],
  ["1 per chunk + restart between chunks", { kind: "groups", size: 1, restart: true }],
  ["2 per chunk + restart between chunks", { kind: "groups", size: 2, restart: true }],
  ["all in one, then cursor reset + rescan", { kind: "groups", size: "all", reset: "end" }],
  ["1 per chunk, then cursor reset + rescan", { kind: "groups", size: 1, reset: "end" }],
  ["2 per chunk, then cursor reset + rescan", { kind: "groups", size: 2, reset: "end" }],
  ["cursor reset (full replay) after every chunk of 1", { kind: "groups", size: 1, reset: "each" }],
  ["cursor reset (full replay) after every chunk of 2", { kind: "groups", size: 2, reset: "each" }],
  ["tiny byte chunks", { kind: "bytes", chunkBytes: 90 }],
  ["tiny byte chunks, then cursor reset + rescan", { kind: "bytes", chunkBytes: 90, reset: "end" }],
];

let harness: TokenHarness | null = null;

afterEach(() => {
  harness?.cleanup();
  harness = null;
});

function bucketInput(h: TokenHarness, start: string): number {
  const end = new Date(Date.parse(start) + 15 * 60_000).toISOString();
  return queryCodexTokenTotals(h.temp.db, { start, end })?.counters.input ?? 0;
}

async function run(scenario: Scenario, route: Route): Promise<TokenHarness> {
  const h = createTokenHarness(
    route.kind === "bytes" ? { over: { chunkBytes: route.chunkBytes } } : {},
  );
  harness = h;
  for (const [from, to] of scenario.off ?? []) {
    appendToggleLog(h.temp.db, from, false);
    appendToggleLog(h.temp.db, to, true);
  }
  if (route.kind === "bytes") {
    h.rollouts.write(DAY, NAME, jsonl([metaLine(), ...scenario.lines]));
    await h.scanner.sweep();
    if (route.reset === "end") {
      resetCodexScanState(h.temp.db);
      await h.scanner.sweep();
    }
    return h;
  }
  const size = route.size === "all" ? scenario.lines.length : route.size;
  for (let i = 0; i < scenario.lines.length; i += size) {
    const group = jsonl(scenario.lines.slice(i, i + size));
    if (i === 0) h.rollouts.write(DAY, NAME, jsonl([metaLine()]) + group);
    else h.rollouts.append(DAY, NAME, group);
    if (route.reset === "each") resetCodexScanState(h.temp.db);
    await h.scanner.sweep();
    if (route.restart === true) h.restart();
  }
  if (route.reset === "end") {
    resetCodexScanState(h.temp.db);
    await h.scanner.sweep();
  }
  return h;
}

describe("Codex token scanner: one precedence rule, identical on every route", () => {
  for (const scenario of SCENARIOS) {
    describe(scenario.name, () => {
      for (const [routeName, route] of ROUTES) {
        it(routeName, async () => {
          const h = await run(scenario, route);
          const totals = queryCodexTokenTotals(h.temp.db, WIDE);
          expect(totals?.counters.input).toBe(scenario.expected);
          for (const [bucket, input] of Object.entries(scenario.buckets ?? {})) {
            expect(bucketInput(h, bucket)).toBe(input);
          }
        });
      }
    });
  }
});

describe("Codex token scanner: precedence edge cases", () => {
  it("an uncovered range stays null, never zero", async () => {
    const h = await run(SCENARIOS[0] as Scenario, { kind: "groups", size: "all" });
    expect(
      queryCodexTokenTotals(h.temp.db, {
        start: "2026-09-01T00:00:00.000Z",
        end: "2026-09-02T00:00:00.000Z",
      }),
    ).toBeNull();
  });

  it("a refused rollout is a failed scan: no usage, no coverage, first scan still pending", async () => {
    const h = createTokenHarness({
      over: {
        port: {
          listRolloutFiles: (range) => h.spy.port.listRolloutFiles(range),
          statRollout: () => {
            throw new CodexHomeAccessError("unreadable");
          },
          readRolloutRange: (ref, offset, max) => h.spy.port.readRolloutRange(ref, offset, max),
        },
      },
    });
    harness = h;
    h.rollouts.write(DAY, NAME, jsonl([metaLine(), cum(t(10, 1), 100), pt(1, t(10, 2), 10)]));
    const outcome = await h.scanner.sweep();
    expect(outcome.completed).toBe(false);
    expect(outcome.failedFiles).toBe(1);
    expect(queryCodexTokenTotals(h.temp.db, WIDE)).toBeNull();
    expect(queryCodexCoverage(h.temp.db, DAY, DAY).map((d) => d.status)).toEqual(["not-scanned"]);
    expect(h.scanner.summary().firstScanPending).toBe(true);
  });

  it("the cursor of the last chunk always ends at the file size", async () => {
    const h = await run(SCENARIOS[5] as Scenario, { kind: "groups", size: 1 });
    const row = h.temp.db.prepare("SELECT offset FROM codex_rollout_cursors").get() as {
      offset: number;
    };
    expect(row.offset).toBe(statSync(h.rollouts.home.rolloutPath(DAY, NAME)).size);
  });
});
