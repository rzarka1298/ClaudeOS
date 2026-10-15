// Task 2 of plan 07-05 (D-10, research Pattern 1): outcome derivation.

import { JOB_RUN_OUTCOMES, RUN_ERROR_CODES } from "@ccc/domain";
import { describe, expect, it } from "vitest";
import { deriveOutcome } from "./outcome.js";

describe("Test 5: deriveOutcome", () => {
  it("is failure when no source succeeded", () => {
    expect(deriveOutcome({ succeeded: 0, failed: 3, stageError: null })).toBe("failure");
    expect(deriveOutcome({ succeeded: 0, failed: 0, stageError: null })).toBe("failure");
  });

  it("is failure for any stage error, whatever the sources did", () => {
    for (const code of RUN_ERROR_CODES) {
      expect(deriveOutcome({ succeeded: 6, failed: 0, stageError: code }), code).toBe("failure");
      expect(deriveOutcome({ succeeded: 2, failed: 4, stageError: code }), code).toBe("failure");
    }
  });

  it("is partial with at least one success and at least one failed source", () => {
    expect(deriveOutcome({ succeeded: 1, failed: 1, stageError: null })).toBe("partial");
    expect(deriveOutcome({ succeeded: 5, failed: 1, stageError: null })).toBe("partial");
    expect(deriveOutcome({ succeeded: 1, failed: 5, stageError: null })).toBe("partial");
  });

  it("is success with every source succeeded and no stage error", () => {
    expect(deriveOutcome({ succeeded: 6, failed: 0, stageError: null })).toBe("success");
    expect(deriveOutcome({ succeeded: 1, failed: 0, stageError: null })).toBe("success");
  });

  it("only ever returns a member of the domain outcome list, and never skipped or missed", () => {
    for (const succeeded of [0, 1, 4]) {
      for (const failed of [0, 1, 4]) {
        for (const stageError of [null, "vault-write-failed"] as const) {
          const outcome = deriveOutcome({ succeeded, failed, stageError });
          expect(JOB_RUN_OUTCOMES as readonly string[]).toContain(outcome);
          expect(["skipped", "missed"]).not.toContain(outcome);
        }
      }
    }
  });

  it("rejects negative, fractional and non-finite counts", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        () => deriveOutcome({ succeeded: bad, failed: 0, stageError: null }),
        `s ${bad}`,
      ).toThrow(RangeError);
      expect(
        () => deriveOutcome({ succeeded: 1, failed: bad, stageError: null }),
        `f ${bad}`,
      ).toThrow(RangeError);
    }
  });
});
