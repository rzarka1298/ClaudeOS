import { describe, expect, it } from "vitest";
import { finalMismatches, formatVersions, parseVersions, reconcileVersions } from "./versions.js";

const decided = { appVersion: "1.14.4", installerVersion: "1.13.7" };
const seen = { app: "1.14.4", installer: "1.13.7" };

describe("reconcileVersions (Test 7)", () => {
  it("records the first observation", () => {
    expect(reconcileVersions(undefined, seen, decided)).toEqual({
      app: "1.14.4",
      installer: "1.13.7",
      mismatches: [],
    });
  });

  it("keeps the record when a later spec reports the same versions", () => {
    const first = reconcileVersions(undefined, seen, decided);
    expect(reconcileVersions(first, seen, decided)).toEqual(first);
  });

  it("flags a later spec that reports another app version, and keeps the first record", () => {
    const first = reconcileVersions(undefined, seen, decided);
    const next = reconcileVersions(first, { ...seen, app: "1.15.0" }, decided);
    expect(next.app).toBe("1.14.4");
    expect(next.mismatches).toContain("app-changed-between-specs");
  });

  it("flags a later spec that reports another installer version", () => {
    const first = reconcileVersions(undefined, seen, decided);
    const next = reconcileVersions(first, { ...seen, installer: "1.13.8" }, decided);
    expect(next.mismatches).toContain("installer-changed-between-specs");
  });

  it("flags an observed app or installer version that differs from the decision", () => {
    const record = reconcileVersions(undefined, { app: "1.13.0", installer: "1.12.0" }, decided);
    expect(record.mismatches).toEqual(
      expect.arrayContaining(["app-differs-from-decision", "installer-differs-from-decision"]),
    );
  });

  it("does not repeat a mismatch code", () => {
    let record = reconcileVersions(undefined, { ...seen, app: "9.9.9" }, decided);
    record = reconcileVersions(record, { ...seen, app: "9.9.9" }, decided);
    expect(record.mismatches.filter((code) => code === "app-differs-from-decision")).toHaveLength(
      1,
    );
  });
});

describe("finalMismatches (Test 7)", () => {
  it("treats a missing observation as a mismatch only when specs executed", () => {
    expect(finalMismatches(undefined, true)).toEqual(["not-observed"]);
    expect(finalMismatches(undefined, false)).toEqual([]);
  });

  it("returns the recorded mismatches", () => {
    const record = reconcileVersions(undefined, { ...seen, app: "9.9.9" }, decided);
    expect(finalMismatches(record, true)).toEqual(["app-differs-from-decision"]);
    expect(finalMismatches(reconcileVersions(undefined, seen, decided), true)).toEqual([]);
  });
});

describe("version file text", () => {
  it("round-trips through formatVersions and parseVersions", () => {
    const record = reconcileVersions(undefined, { ...seen, app: "9.9.9" }, decided);
    expect(parseVersions(formatVersions(record))).toEqual(record);
  });

  it("returns undefined for text that is not a version record", () => {
    expect(parseVersions("not json")).toBeUndefined();
    expect(parseVersions('{"app":1}')).toBeUndefined();
    expect(parseVersions("")).toBeUndefined();
  });
});
