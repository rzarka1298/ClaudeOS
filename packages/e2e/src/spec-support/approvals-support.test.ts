import { describe, expect, it } from "vitest";
import { type AuditRowLike, checkDeniedAudit, containsInOrder } from "./approvals-support.js";

const requested: AuditRowLike = { seq: 1, event: "requested", decided_via: null, detail: null };
const denied: AuditRowLike = { seq: 2, event: "denied", decided_via: "plugin", detail: null };

describe("checkDeniedAudit (Test 2)", () => {
  it("accepts a newest-first denied then requested with decided_via on the denied row only", () => {
    expect(checkDeniedAudit([denied, requested], 0)).toEqual([]);
  });

  it("accepts an older, unrelated row below the two newest ones", () => {
    const older: AuditRowLike = { seq: 0, event: "denied", decided_via: "plugin", detail: null };
    expect(checkDeniedAudit([denied, requested, older], 0)).toEqual([]);
  });

  it("rejects decided_via on the requested row", () => {
    const bad = { ...requested, decided_via: "plugin" };
    expect(checkDeniedAudit([denied, bad], 0).length).toBeGreaterThan(0);
  });

  it("rejects a denied row with decided_via missing or empty", () => {
    expect(checkDeniedAudit([{ ...denied, decided_via: null }, requested], 0).length).toBe(1);
    expect(checkDeniedAudit([{ ...denied, decided_via: "" }, requested], 0).length).toBe(1);
  });

  it("rejects a third row that is an effect", () => {
    const effect: AuditRowLike = { seq: 0, event: "executed", decided_via: null, detail: null };
    expect(checkDeniedAudit([denied, requested, effect], 0).length).toBeGreaterThan(0);
  });

  it("rejects a non-zero effect count", () => {
    expect(checkDeniedAudit([denied, requested], 1).length).toBeGreaterThan(0);
  });

  it("rejects fewer than two rows and a wrong order", () => {
    expect(checkDeniedAudit([denied], 0).length).toBeGreaterThan(0);
    expect(checkDeniedAudit([], 0).length).toBeGreaterThan(0);
    expect(checkDeniedAudit([requested, denied], 0).length).toBeGreaterThan(0);
  });
});

describe("containsInOrder (Test 3)", () => {
  it("is true when the expected strings occur in order, other entries between them allowed", () => {
    expect(containsInOrder(["Requested", "Approved", "Denied"], ["Requested", "Denied"])).toBe(
      true,
    );
    expect(containsInOrder(["a", "b"], ["a", "b"])).toBe(true);
    expect(containsInOrder(["a"], [])).toBe(true);
  });

  it("is false for a missing or reordered entry", () => {
    expect(containsInOrder(["Requested"], ["Requested", "Denied"])).toBe(false);
    expect(containsInOrder(["Denied", "Requested"], ["Requested", "Denied"])).toBe(false);
    expect(containsInOrder([], ["Requested"])).toBe(false);
  });
});
