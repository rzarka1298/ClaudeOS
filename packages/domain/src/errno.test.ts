import { describe, expect, it } from "vitest";
import { errnoOf } from "./errno.js";

describe("09-07 Task 1 (tracer): one errno helper", () => {
  it("Test 1: returns a string code and nothing else", () => {
    expect(errnoOf({ code: "ENOENT" })).toBe("ENOENT");
    expect(
      errnoOf(Object.assign(new Error("boom at /Users/<username>/x"), { code: "ENOENT" })),
    ).toBe("ENOENT");
    expect(errnoOf({ code: 2 })).toBeNull();
    expect(errnoOf({})).toBeNull();
    expect(errnoOf(new Error("ENOENT"))).toBeNull();
    expect(errnoOf(null)).toBeNull();
    expect(errnoOf(undefined)).toBeNull();
    expect(errnoOf("ENOENT")).toBeNull();
    expect(errnoOf({ code: { nested: "ENOENT" } })).toBeNull();
  });

  it("Test 2: the inputs of the three former call sites read the same code as before", () => {
    const rows: ReadonlyArray<readonly [string, unknown, string | null]> = [
      // vault probe (vault-probe.test.ts): an fs error whose message carries a path
      [
        "vault probe EACCES",
        Object.assign(new Error("EACCES at /Users/<username>/v"), { code: "EACCES" }),
        "EACCES",
      ],
      ["vault probe ENOTDIR", Object.assign(new Error("ENOTDIR"), { code: "ENOTDIR" }), "ENOTDIR"],
      // task forms (tasks-forms-copy.test.ts): closed request error codes
      ["task form timeout", { code: "timeout" }, "timeout"],
      ["task form disconnected", { code: "service-disconnected" }, "service-disconnected"],
      ["task form unrecognised", { code: "unrecognised-response" }, "unrecognised-response"],
      // approval detail (approval-detail.test.tsx): a failed get
      [
        "approval detail not-found",
        Object.assign(new Error("not-found"), { code: "not-found" }),
        "not-found",
      ],
      ["approval detail plain error", new Error("network down"), null],
    ];
    for (const [name, input, expected] of rows) {
      expect(errnoOf(input), name).toBe(expected);
    }
  });
});
