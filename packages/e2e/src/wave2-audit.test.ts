import { describe, expect, it } from "vitest";
import type { LedgerEntry, ProcessEntry } from "./ledger.js";
import { sanitizeText } from "./sanitize.js";
import { planSweep, type SweepRunInput } from "./sweep.js";

// Wave 2 Nyquist audit additions (05.2-03 sweep identity, 05.2-05 sanitiser): each test kills a
// mutation that the original suite let survive.

const ROOT = "/tmp/ccc-uat.abc123";
const START = "Sun Oct 11 10:00:01 2026";
const MARKER = "/repo/packages/service/dist/main.js";
const OLD = 10 * 60 * 1000;
const options = { base: "/tmp", selfPid: 1 };

const runEntry: LedgerEntry = {
  kind: "run",
  runId: "0123abcd",
  runRoot: ROOT,
  startedAt: "2026-10-11T10:00:00.000Z",
  ownerPid: 100,
  ownerStart: "Sun Oct 11 09:59:59 2026",
};
const ownerRow: ProcessEntry = {
  pid: 100,
  start: "Sun Oct 11 09:59:59 2026",
  command: "node runner",
};

function run(extra: LedgerEntry[]): SweepRunInput {
  return { runRoot: ROOT, ageMs: OLD, entries: [runEntry, ...extra] };
}

describe("sweep identity (T-05.2-12)", () => {
  it("never signals a different pid that shares the recorded start time and marker", () => {
    const ledger: LedgerEntry = {
      kind: "pid",
      role: "service",
      pid: 555,
      start: START,
      marker: MARKER,
    };
    const lookalike: ProcessEntry = { pid: 556, start: START, command: `node ${MARKER}` };
    const plan = planSweep([run([ledger])], [lookalike], options);
    expect(plan.runs[0]?.actions.some((a) => a.type === "terminate")).toBe(false);
  });

  it("a closed run whose owner pid is still alive does not block the next run", () => {
    const closed: LedgerEntry = { kind: "closed", at: "2026-10-11T10:05:00.000Z" };
    const plan = planSweep([run([closed])], [ownerRow], options);
    expect(plan.busy).toBeNull();
  });

  it("a ledgered dir equal to the run root is not removed as a separate dir", () => {
    const plan = planSweep([run([{ kind: "dir", path: ROOT }])], [], options);
    expect(plan.runs[0]?.actions.filter((a) => a.type === "remove-dir")).toEqual([]);
    expect(plan.runs[0]?.actions.at(-1)).toEqual({ type: "remove-root", path: ROOT });
  });
});

describe("sanitiser boundaries (T-05.2-19)", () => {
  it("replaces the DEL control character", () => {
    expect(sanitizeText("a\u007fb")).toBe("a b");
  });

  it("redacts a mixed-case 32-character token but leaves a 31-character one", () => {
    const t32 = `Ab1${"x".repeat(29)}`;
    expect(t32).toHaveLength(32);
    expect(sanitizeText(`key ${t32}`)).toBe("key [token]");
    expect(sanitizeText(`key ${t32.slice(1)}`)).toBe(`key ${t32.slice(1)}`);
  });
});
