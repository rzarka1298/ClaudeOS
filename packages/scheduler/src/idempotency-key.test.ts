// Task 1 of plan 07-05 (D-19, PRD 9.7): the manual run key and the key parser.
// The scheduled key is declared here and completed in Task 2; Test 5 only needs
// its shape to prove the two forms can never meet.

import { RUN_ID_PATTERN } from "@ccc/domain";
import { describe, expect, it } from "vitest";
import { manualJobRunKey, parseJobRunKey, scheduledJobRunKey } from "./idempotency-key.js";

const JOB = "research.daily-tech";
const RUN = "0mfk1a2b3c4d5e6f7a8b9c0d2";

describe("Test 4: the manual key", () => {
  it("uses a run id of the domain shape in the fixture", () => {
    expect(RUN_ID_PATTERN.test(RUN)).toBe(true);
  });

  it("is <jobId>:manual:<runId>", () => {
    expect(manualJobRunKey(JOB, RUN)).toBe(`${JOB}:manual:${RUN}`);
  });

  it("rejects a job id with a colon, an at sign, whitespace, upper case or nothing", () => {
    for (const bad of ["a:b", "a@b", "a b", "Research", "", "a/b", "-a", "a..b", "a\n"]) {
      expect(() => manualJobRunKey(bad, RUN), JSON.stringify(bad)).toThrow();
    }
    expect(() => manualJobRunKey("a".repeat(65), RUN)).toThrow();
    expect(() => manualJobRunKey("a".repeat(64), RUN)).not.toThrow();
  });

  it("rejects a run id that does not match the run id pattern", () => {
    for (const bad of [
      "",
      "short",
      RUN.slice(1),
      `${RUN}x`,
      RUN.toUpperCase(),
      `${RUN.slice(0, 24)}:`,
      `${RUN.slice(0, 24)}@`,
      `${RUN.slice(0, 24)}\n`,
    ]) {
      expect(() => manualJobRunKey(JOB, bad), JSON.stringify(bad)).toThrow();
    }
  });

  it("is parsed back as kind manual with its parts", () => {
    expect(parseJobRunKey(manualJobRunKey(JOB, RUN))).toEqual({
      kind: "manual",
      jobId: JOB,
      runId: RUN,
    });
  });

  it("parses nothing from a malformed key and never throws", () => {
    for (const bad of [
      "",
      JOB,
      `${JOB}:manual`,
      `${JOB}:manual:`,
      `${JOB}:manual:${RUN}:extra`,
      `${JOB}:manual:${RUN.slice(1)}`,
      `${JOB}:Manual:${RUN}`,
      `:manual:${RUN}`,
      `${JOB}:weekly:2026-10-13@UTC`,
      `${JOB}:manual:${RUN}@UTC`,
    ]) {
      expect(parseJobRunKey(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("Test 5: a manual key can never equal or consume a scheduled key", () => {
  const JOBS = [JOB, "a", "x-y.z", "job1"];
  const RUNS = [
    RUN,
    "000000000000000000000000a",
    "zzzzzzzzzzzzzzzzzzzzzzzzz",
    "daily0manual0000000000000",
  ];
  const DATES = ["2026-10-13", "2011-12-31", "2026-03-08", "2026-11-01"];
  const ZONES = ["UTC", "America/New_York", "Asia/Tokyo", "Pacific/Apia"];

  it("never produces the same string, and the manual key parses with no window", () => {
    let combos = 0;
    for (const job of JOBS) {
      for (const run of RUNS) {
        const manual = manualJobRunKey(job, run);
        const parsedManual = parseJobRunKey(manual);
        expect(parsedManual?.kind).toBe("manual");
        expect(parsedManual).not.toHaveProperty("window");
        expect(parsedManual).not.toHaveProperty("zone");
        for (const date of DATES) {
          for (const zone of ZONES) {
            const scheduled = scheduledJobRunKey(job, "daily", date, zone);
            expect(scheduled, `${job} ${run} ${date} ${zone}`).not.toBe(manual);
            expect(scheduled.length).toBeGreaterThan(0);
            combos += 1;
          }
        }
      }
    }
    expect(combos).toBe(JOBS.length * RUNS.length * DATES.length * ZONES.length);
  });

  it("keeps the two forms apart by grammar: a run id can hold neither a colon nor an at sign", () => {
    const scheduled = scheduledJobRunKey(JOB, "daily", "2026-10-13", "UTC");
    expect(scheduled).toBe(`${JOB}:daily:2026-10-13@UTC`);
    expect(parseJobRunKey(scheduled)?.kind).toBe("scheduled");
    expect(scheduled.includes(":manual:")).toBe(false);
  });
});

describe("Test 4: the scheduled key (Task 2)", () => {
  it("is <jobId>:<cadence>:<YYYY-MM-DD>@<IANA zone>", () => {
    expect(scheduledJobRunKey(JOB, "daily", "2026-10-13", "America/New_York")).toBe(
      "research.daily-tech:daily:2026-10-13@America/New_York",
    );
  });

  it("rejects an invalid date, an invalid zone and a cadence other than daily", () => {
    expect(() => scheduledJobRunKey(JOB, "daily", "2026-02-30", "UTC")).toThrow();
    expect(() => scheduledJobRunKey(JOB, "daily", "2026-13-01", "UTC")).toThrow();
    expect(() => scheduledJobRunKey(JOB, "daily", "2026-00-10", "UTC")).toThrow();
    expect(() => scheduledJobRunKey(JOB, "daily", "2026-1-3", "UTC")).toThrow();
    expect(() => scheduledJobRunKey(JOB, "daily", "2026-10-13", "Mars/Olympus")).toThrow();
    expect(() => scheduledJobRunKey(JOB, "daily", "2026-10-13", "")).toThrow();
    expect(() => scheduledJobRunKey(JOB, "weekly", "2026-10-13", "UTC")).toThrow();
    expect(() => scheduledJobRunKey(JOB, "manual", "2026-10-13", "UTC")).toThrow();
    expect(() => scheduledJobRunKey("a:b", "daily", "2026-10-13", "UTC")).toThrow();
  });

  it("accepts a leap day and UTC", () => {
    expect(scheduledJobRunKey(JOB, "daily", "2028-02-29", "UTC")).toBe(
      `${JOB}:daily:2028-02-29@UTC`,
    );
    expect(() => scheduledJobRunKey(JOB, "daily", "2027-02-29", "UTC")).toThrow();
  });

  it("round-trips through parseJobRunKey with kind scheduled", () => {
    const key = scheduledJobRunKey(JOB, "daily", "2026-10-13", "America/New_York");
    expect(parseJobRunKey(key)).toEqual({
      kind: "scheduled",
      jobId: JOB,
      cadence: "daily",
      window: "2026-10-13",
      zone: "America/New_York",
    });
  });

  it("parses nothing from a scheduled-looking key with a bad date or zone", () => {
    for (const bad of [
      `${JOB}:daily:2026-02-30@UTC`,
      `${JOB}:daily:2026-10-13@Mars/Olympus`,
      `${JOB}:daily:2026-10-13@`,
      `${JOB}:daily:2026-10-13`,
      `${JOB}:daily:2026-10-13@UTC@UTC`,
    ]) {
      expect(parseJobRunKey(bad), bad).toBeNull();
    }
  });

  it("a different zone is a different key for the same date (the zone is inside the key)", () => {
    expect(scheduledJobRunKey(JOB, "daily", "2026-10-13", "UTC")).not.toBe(
      scheduledJobRunKey(JOB, "daily", "2026-10-13", "Asia/Tokyo"),
    );
  });
});
