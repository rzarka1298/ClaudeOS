import { describe, expect, it } from "vitest";
import { SPEC_FILES, specsForProfile, UAT_ITEM_PLAN, UAT_PHASE_PREFIX } from "./spec-map.js";
import { OWNER_WHY, VIA_TOKENS } from "./uat-tags.js";

const AUTO_NUMBERS = [5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 19, 21, 23, 24, 25];
const LOOK_NUMBERS = [12, 20, 22];
const OWNER_NUMBERS = [1, 2, 3, 4, 26];

const NAMES = [
  "approvals-core",
  "approvals-expiry",
  "approvals-lifecycle",
  "tasks-core",
  "tasks-views",
  "tasks-scale",
  "cross-cutting",
  "notification-look",
  "synthetic-session",
];
const file = (name: string) => `packages/e2e/specs/${name}.e2e.ts`;

const EXPECTED_FILE: Record<number, string> = {
  1: "notification-look",
  2: "approvals-core",
  3: "approvals-core",
  4: "approvals-core",
  5: "approvals-core",
  6: "approvals-core",
  7: "approvals-core",
  8: "approvals-core",
  9: "approvals-expiry",
  10: "approvals-lifecycle",
  11: "synthetic-session",
  12: "cross-cutting",
  13: "approvals-lifecycle",
  14: "tasks-core",
  15: "tasks-core",
  16: "tasks-core",
  17: "tasks-core",
  18: "tasks-views",
  19: "tasks-views",
  20: "cross-cutting",
  21: "tasks-scale",
  22: "cross-cutting",
  23: "cross-cutting",
  24: "approvals-lifecycle",
  25: "cross-cutting",
};

describe("spec map counts (Test 1)", () => {
  it("holds exactly 26 items numbered 1 to 26", () => {
    expect(UAT_ITEM_PLAN.map((item) => item.number)).toEqual(
      Array.from({ length: 26 }, (_, index) => index + 1),
    );
  });

  it("classifies 18 auto, 3 auto+look and 5 owner exactly as D-09 (amended 2026-10-13) lists them", () => {
    const numbers = (runClass: string) =>
      UAT_ITEM_PLAN.filter((item) => item.runClass === runClass).map((item) => item.number);
    expect(numbers("auto")).toEqual(AUTO_NUMBERS);
    expect(numbers("auto+look")).toEqual(LOOK_NUMBERS);
    expect(numbers("owner")).toEqual(OWNER_NUMBERS);
  });

  it("uses the Phase 6 prefix", () => {
    expect(UAT_PHASE_PREFIX).toBe("06");
  });
});

describe("spec map fields (Test 2)", () => {
  it("gives every automated item a via list from the enumeration and a spec file from the list", () => {
    for (const item of UAT_ITEM_PLAN.filter((entry) => entry.runClass !== "owner")) {
      expect(item.via.length, `item ${item.number}`).toBeGreaterThan(0);
      for (const token of item.via) expect(VIA_TOKENS).toContain(token);
      expect(SPEC_FILES, `item ${item.number}`).toContain(item.specFile);
      expect(item.ownerWhy).toBeNull();
    }
  });

  it("gives every owner item an owner-why from the enumeration", () => {
    for (const item of UAT_ITEM_PLAN.filter((entry) => entry.runClass === "owner")) {
      expect(OWNER_WHY, `item ${item.number}`).toContain(item.ownerWhy);
    }
  });

  it("gives items 2, 3 and 4 an auto-part and the approvals-core spec, and item 26 neither", () => {
    for (const number of [2, 3, 4]) {
      const item = UAT_ITEM_PLAN[number - 1];
      expect(item?.autoPart?.length, `item ${number}`).toBeGreaterThan(20);
      expect(item?.specFile).toBe(file("approvals-core"));
    }
    const last = UAT_ITEM_PLAN[25];
    expect(last?.autoPart).toBeNull();
    expect(last?.specFile).toBeNull();
    expect(last?.ownerWhy).toBe("decision");
  });

  it("records the owner reason of item 1, the banner's own appearance (D-09 amendment)", () => {
    expect(UAT_ITEM_PLAN[0]?.runClass).toBe("owner");
    expect(UAT_ITEM_PLAN[0]?.ownerWhy).toBe("banner-appearance");
  });

  it("records the owner reasons of items 2, 3 and 4", () => {
    expect(UAT_ITEM_PLAN.slice(1, 4).map((item) => item.ownerWhy)).toEqual([
      "banner-click",
      "focus",
      "multi-window",
    ]);
  });

  it("flags item 21 as full-profile and no other item", () => {
    const full = UAT_ITEM_PLAN.filter((item) => item.profile === "full").map((item) => item.number);
    expect(full).toEqual([21]);
  });

  it("holds the tool lists the research table assigns", () => {
    const via = (n: number) => [...(UAT_ITEM_PLAN[n - 1]?.via ?? [])].sort();
    expect(via(1)).toEqual([]);
    expect(via(5)).toEqual(["dom", "spy"]);
    expect(via(10)).toEqual(["dom", "proc", "store"]);
    expect(via(20)).toEqual(["dom", "fs", "log", "proc", "shot"]);
    expect(via(25)).toEqual(["fs", "log"]);
  });
});

describe("spec files (Test 3)", () => {
  it("lists exactly the nine spec files under packages/e2e/specs", () => {
    expect([...SPEC_FILES].sort()).toEqual(NAMES.map(file).sort());
  });

  it("uses every file at least once and no name outside the list", () => {
    const used = new Set(UAT_ITEM_PLAN.map((item) => item.specFile).filter(Boolean));
    expect([...used].sort()).toEqual([...SPEC_FILES].sort());
  });

  it("assigns items to files as the table in the plan states", () => {
    for (const [number, name] of Object.entries(EXPECTED_FILE)) {
      expect(UAT_ITEM_PLAN[Number(number) - 1]?.specFile, `item ${number}`).toBe(file(name));
    }
  });
});

describe("specsForProfile (Test 4)", () => {
  it("omits the scale spec in the standard profile and keeps the other eight", () => {
    const standard = specsForProfile("standard");
    expect(standard).not.toContain(file("tasks-scale"));
    expect(standard.length).toBe(8);
    for (const name of NAMES.filter((entry) => entry !== "tasks-scale")) {
      expect(standard).toContain(file(name));
    }
  });

  it("returns all nine in the full profile", () => {
    expect([...specsForProfile("full")].sort()).toEqual([...SPEC_FILES].sort());
  });
});
