import { describe, expect, it } from "vitest";
import { parseDoctorJson } from "./doctor.js";
import * as records from "./index.js";

const DECOYS = {
  details: "DECOY-DETAILS /Users/USERNAME/.codex/auth.json",
  summary: "DECOY-SUMMARY account foo@example.invalid",
  remediation: "DECOY-REMEDIATION run something",
  notes: "DECOY-NOTES a note",
};

function check(id: string, category: string, status: string): Record<string, unknown> {
  return {
    id,
    category,
    status,
    summary: DECOYS.summary,
    details: { path: DECOYS.details, list: [DECOYS.details] },
    notes: [DECOYS.notes],
    remediation: DECOYS.remediation,
    issues: [
      {
        severity: "warning",
        cause: DECOYS.summary,
        measured: null,
        expected: null,
        remedy: null,
        fields: [],
      },
    ],
    durationMs: 12,
  };
}

function report(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    generatedAt: "2026-10-10T10:00:00.000Z",
    overallStatus: "warning",
    codexVersion: "0.159.2",
    checks: {
      "auth.credentials": check("auth.credentials", "auth", "ok"),
      "network.provider_reachability": check("network.provider_reachability", "network", "warning"),
      "state.paths": check("state.paths", "state", "fail"),
    },
    ...over,
  };
}

describe("Test 5: parseDoctorJson keeps only the allowlist", () => {
  it("returns overall, version and { id, category, status } checks for schemaVersion 1", () => {
    expect(parseDoctorJson(report())).toEqual({
      overall: "warning",
      codexVersion: "0.159.2",
      checks: [
        { id: "auth.credentials", category: "auth", status: "ok" },
        { id: "network.provider_reachability", category: "network", status: "warning" },
        { id: "state.paths", category: "state", status: "fail" },
      ],
    });
  });

  it("never lets details, summary, remediation or notes text out", () => {
    const serialized = JSON.stringify(parseDoctorJson(report()));
    expect(serialized).not.toContain("DECOY");
    expect(serialized).not.toContain("auth.json");
    expect(serialized).not.toContain("example.invalid");
  });

  it("accepts a JSON string as well as a parsed value", () => {
    expect(parseDoctorJson(JSON.stringify(report()))).toEqual(parseDoctorJson(report()));
  });

  it("returns unrecognised with no checks for schemaVersion 2 or a missing version", () => {
    const expected = { overall: "unrecognised", codexVersion: null, checks: [] };
    expect(parseDoctorJson(report({ schemaVersion: 2 }))).toEqual(expected);
    expect(parseDoctorJson(report({ schemaVersion: undefined }))).toEqual(expected);
    expect(parseDoctorJson(report({ schemaVersion: "1" }))).toEqual(expected);
  });

  it("returns unrecognised when the overall status is off-shape", () => {
    expect(parseDoctorJson(report({ overallStatus: "great" }))).toEqual({
      overall: "unrecognised",
      codexVersion: null,
      checks: [],
    });
  });

  it("nulls a version that is not dotted digits", () => {
    for (const codexVersion of [
      "codex-cli 0.159.2",
      "x".repeat(100),
      159,
      null,
      "0.159.2; rm -rf /",
    ]) {
      expect(parseDoctorJson(report({ codexVersion }))?.codexVersion).toBeNull();
    }
    expect(parseDoctorJson(report({ codexVersion: "0.155.0-alpha.9.2" }))?.codexVersion).toBe(
      "0.155.0-alpha.9.2",
    );
  });
});

describe("Test 6: bounds and hostile input", () => {
  it("truncates more than 64 checks to 64", () => {
    const checks: Record<string, unknown> = {};
    for (let i = 0; i < 100; i += 1) checks[`check.${i}`] = check(`check.${i}`, "cat", "ok");
    const parsed = parseDoctorJson(report({ checks }));
    expect(parsed?.checks).toHaveLength(64);
    expect(parsed?.checks[0]?.id).toBe("check.0");
  });

  it("skips a check with a non-pattern id, category or status", () => {
    const checks = {
      good: check("good.one", "cat", "ok"),
      badId: check("bad id with spaces", "cat", "ok"),
      pathId: check("/Users/USERNAME/secret", "cat", "ok"),
      longId: check("a".repeat(65), "cat", "ok"),
      badCat: check("fine.id", "bad cat!", "ok"),
      badStatus: check("fine.id2", "cat", "meh"),
      notObject: "string",
      alsoNull: null,
    };
    expect(parseDoctorJson(report({ checks }))?.checks).toEqual([
      { id: "good.one", category: "cat", status: "ok" },
    ]);
  });

  it("accepts checks given as an array and falls back to the map key for a missing id", () => {
    const arrayForm = parseDoctorJson(report({ checks: [check("a.b", "cat", "ok")] }));
    expect(arrayForm?.checks).toEqual([{ id: "a.b", category: "cat", status: "ok" }]);
    const { id: _id, ...noId } = check("ignored", "cat", "ok");
    const keyed = parseDoctorJson(report({ checks: { "from.key": noId } }));
    expect(keyed?.checks).toEqual([{ id: "from.key", category: "cat", status: "ok" }]);
  });

  it("returns an empty check list when checks is missing or the wrong type", () => {
    expect(parseDoctorJson(report({ checks: undefined }))?.checks).toEqual([]);
    expect(parseDoctorJson(report({ checks: "none" }))?.checks).toEqual([]);
  });

  it("returns null for non-object input and never throws", () => {
    for (const input of [
      null,
      undefined,
      42,
      true,
      "not json",
      "[1]",
      "42",
      [],
      [report()],
      "",
      "{",
    ]) {
      expect(parseDoctorJson(input)).toBeNull();
    }
    expect(parseDoctorJson("x".repeat(3 * 1024 * 1024))).toBeNull();
  });
});

describe("Test 7: the records sub-barrel", () => {
  it("exports exactly the public functions and constants", () => {
    expect(Object.keys(records).sort()).toEqual(
      [
        "CODEX_INACTIVITY_MS",
        "LIFECYCLE_EVENTS",
        "NEVER_SELECT_THREAD_COLUMNS",
        "OPTIONAL_THREAD_COLUMNS",
        "PROMPT_DERIVED_THREAD_COLUMNS",
        "REQUIRED_THREAD_COLUMNS",
        "buildThreadsSelect",
        "classifyThreadSource",
        "compareCodexVersions",
        "deriveLifecycle",
        "evaluateCliRecognition",
        "evaluateRolloutCanary",
        "evaluateStoreShape",
        "foldCumulativeDeltas",
        "foldTurnTokens",
        "parseCodexVersion",
        "parseDoctorJson",
        "parseRolloutChunk",
        "turnKey",
      ].sort(),
    );
  });

  it("is reachable through the package barrel", async () => {
    const barrel = await import("../../index.js");
    for (const name of Object.keys(records)) expect(barrel).toHaveProperty(name);
  });
});
