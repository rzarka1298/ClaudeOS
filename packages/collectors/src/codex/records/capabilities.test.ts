import { describe, expect, it } from "vitest";
import {
  compareCodexVersions,
  evaluateCliRecognition,
  FORMAT_MIN_RATIO,
  FORMAT_MIN_SAMPLE,
  FORMAT_ZERO_SAMPLE,
  parseCodexVersion,
  UNVERSIONED,
} from "./capabilities.js";

describe("Test 5: parseCodexVersion and compareCodexVersions", () => {
  it("accepts plain and prerelease versions", () => {
    for (const text of ["0.159.2", "0.155.0-alpha.9.2", "0.58.0-alpha.10", "0.160.0"]) {
      expect(parseCodexVersion(text)?.raw).toBe(text);
    }
    expect(parseCodexVersion("0.155.0-alpha.9.2")).toMatchObject({
      major: 0,
      minor: 155,
      patch: 0,
      prerelease: ["alpha", "9", "2"],
    });
    expect(parseCodexVersion("0.159.2")?.prerelease).toBeNull();
  });

  it("refuses garbage", () => {
    for (const text of [
      "",
      "garbage",
      "1.2",
      "1.2.3.4",
      "v1.2.3",
      "1.2.3-",
      "1.2.3-al pha",
      "1.2.3-alpha..1",
      `1.2.3-${"a".repeat(80)}`,
      "1.2.3\n",
      null,
      undefined,
      42,
      {},
    ]) {
      expect(parseCodexVersion(text)).toBeNull();
    }
  });

  it("orders a prerelease before its release and by numbers, not text", () => {
    expect(compareCodexVersions("0.155.0-alpha.9.2", "0.155.0")).toBeLessThan(0);
    expect(compareCodexVersions("0.155.0", "0.155.0-alpha.9.2")).toBeGreaterThan(0);
    expect(compareCodexVersions("0.58.0-alpha.10", "0.159.2")).toBeLessThan(0);
    expect(compareCodexVersions("0.58.0-alpha.10", "0.58.0-alpha.9")).toBeGreaterThan(0);
    expect(compareCodexVersions("0.159.2", "0.160.0")).toBeLessThan(0);
    expect(compareCodexVersions("0.159.2", "0.159.2")).toBe(0);
    expect(compareCodexVersions("0.58.0-alpha.1", "0.58.0-alpha.1.1")).toBeLessThan(0);
    expect(compareCodexVersions("0.58.0-alpha.1", "0.58.0-beta.1")).toBeLessThan(0);
  });

  it("sorts an unparsable version before every parsable one", () => {
    expect(compareCodexVersions("garbage", "0.1.0")).toBeLessThan(0);
    expect(compareCodexVersions("0.1.0", "garbage")).toBeGreaterThan(0);
    const sorted = ["0.160.0", "garbage", "0.58.0-alpha.10", "0.159.2"].sort(compareCodexVersions);
    expect(sorted).toEqual(["garbage", "0.58.0-alpha.10", "0.159.2", "0.160.0"]);
  });
});

describe("Test 6: evaluateCliRecognition reuses the Phase 5 thresholds", () => {
  it("reuses the same threshold values", () => {
    expect(FORMAT_MIN_SAMPLE).toBe(20);
    expect(FORMAT_MIN_RATIO).toBe(0.9);
    expect(FORMAT_ZERO_SAMPLE).toBe(5);
  });

  it("is unavailable for 25 sessions with 20 recognized, naming that version", () => {
    expect(evaluateCliRecognition({ "0.159.2": { sessions: 25, recognized: 20 } })).toEqual({
      kind: "unavailable",
      version: "0.159.2",
    });
  });

  it("is ok for a small fully recognized sample and at the ratio boundary", () => {
    expect(evaluateCliRecognition({ "0.159.2": { sessions: 10, recognized: 10 } })).toEqual({
      kind: "ok",
    });
    expect(evaluateCliRecognition({ "0.159.2": { sessions: 20, recognized: 18 } })).toEqual({
      kind: "ok",
    });
    expect(evaluateCliRecognition({})).toEqual({ kind: "ok" });
    expect(evaluateCliRecognition({ "0.159.2": { sessions: 4, recognized: 0 } })).toEqual({
      kind: "ok",
    });
  });

  it("is unavailable at once for 5 sessions with none recognized", () => {
    expect(evaluateCliRecognition({ "0.160.0": { sessions: 5, recognized: 0 } })).toEqual({
      kind: "unavailable",
      version: "0.160.0",
    });
  });

  it("names the newest failing version by the Codex ordering, prerelease before release", () => {
    expect(
      evaluateCliRecognition({
        "0.58.0-alpha.10": { sessions: 30, recognized: 3 },
        "0.159.2": { sessions: 30, recognized: 3 },
        "0.155.0-alpha.9.2": { sessions: 30, recognized: 3 },
        "0.160.0": { sessions: 30, recognized: 30 },
      }),
    ).toEqual({ kind: "unavailable", version: "0.159.2" });
    expect(
      evaluateCliRecognition({
        "0.155.0": { sessions: 30, recognized: 3 },
        "0.155.0-alpha.9.2": { sessions: 30, recognized: 3 },
      }),
    ).toEqual({ kind: "unavailable", version: "0.155.0" });
  });

  it("never lets an unparsable version string win, and never renders it", () => {
    expect(
      evaluateCliRecognition({
        "zzz-not-a-version": { sessions: 30, recognized: 0 },
        "0.58.0-alpha.10": { sessions: 30, recognized: 0 },
      }),
    ).toEqual({ kind: "unavailable", version: "0.58.0-alpha.10" });
    expect(
      evaluateCliRecognition({ "zzz-not-a-version": { sessions: 30, recognized: 0 } }),
    ).toEqual({
      kind: "unavailable",
      version: null,
    });
  });

  it("keys a missing version under the stable unversioned key and never names it", () => {
    expect(UNVERSIONED).toBe("(unversioned)");
    expect(evaluateCliRecognition({ [UNVERSIONED]: { sessions: 8, recognized: 0 } })).toEqual({
      kind: "unavailable",
      version: null,
    });
  });
});
