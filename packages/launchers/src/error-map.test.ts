import { LAUNCH_ERROR_KINDS, type LaunchErrorKind } from "@ccc/domain";
import { describe, expect, it } from "vitest";
import {
  classifyStderr,
  type LaunchFailureSignals,
  mapLaunchFailure,
  STDERR_CLASSES,
  type StderrClass,
} from "./error-map.js";

// The two open(1) failures verified on a real Mac (RESEARCH Pattern 1).
// Both texts carry a value from this machine: exactly why they are
// classified and dropped rather than forwarded.
const OPEN_MISSING_BUNDLE =
  "LSCopyApplicationURLsForBundleIdentifier() failed while trying to determine the application with bundle identifier com.example.missing.";
const OPEN_MISSING_PATH = "The file /Users/USERNAME/code/example-project does not exist.";

function failed(overrides: Partial<LaunchFailureSignals>): LaunchFailureSignals {
  return { exitCode: 1, errno: null, stderrClass: "other", timedOut: false, ...overrides };
}

describe("classifyStderr", () => {
  it("recognises open(1)'s unknown-bundle failure", () => {
    expect(classifyStderr(OPEN_MISSING_BUNDLE)).toBe("bundle-not-found");
  });

  it("recognises open(1)'s missing-path failure", () => {
    expect(classifyStderr(OPEN_MISSING_PATH)).toBe("path-missing");
  });

  it("recognises an Apple Events refusal (-1743)", () => {
    expect(
      classifyStderr("execution error: Not authorized to send Apple events to Terminal. (-1743)"),
    ).toBe("automation-denied");
  });

  it("recognises a TCC refusal", () => {
    expect(classifyStderr("fatal: cannot read: Operation not permitted")).toBe("permission-denied");
  });

  it("reads empty or whitespace-only stderr as none", () => {
    expect(classifyStderr("")).toBe("none");
    expect(classifyStderr("  \n")).toBe("none");
  });

  it("reads anything else as other", () => {
    expect(classifyStderr("something unexpected happened")).toBe("other");
  });
});

describe("mapLaunchFailure (D-26)", () => {
  it("maps the cap to timeout, whatever else the outcome says", () => {
    expect(mapLaunchFailure(failed({ timedOut: true, exitCode: null }))).toBe("timeout");
  });

  it("maps a spawn errno (ENOENT, EACCES) to spawn-failed", () => {
    expect(mapLaunchFailure(failed({ exitCode: null, errno: "ENOENT" }))).toBe("spawn-failed");
    expect(mapLaunchFailure(failed({ exitCode: null, errno: "EACCES" }))).toBe("spawn-failed");
  });

  it("maps each stderr class to its kind", () => {
    const expected: Record<StderrClass, LaunchErrorKind> = {
      "bundle-not-found": "app-not-found",
      "path-missing": "project-missing",
      "automation-denied": "automation-denied",
      "permission-denied": "folder-access-denied",
      none: "spawn-failed",
      other: "spawn-failed",
    };
    for (const stderrClass of STDERR_CLASSES) {
      expect(mapLaunchFailure(failed({ stderrClass })), stderrClass).toBe(expected[stderrClass]);
    }
  });

  it("maps both verified open(1) texts end to end", () => {
    expect(mapLaunchFailure(failed({ stderrClass: classifyStderr(OPEN_MISSING_BUNDLE) }))).toBe(
      "app-not-found",
    );
    expect(mapLaunchFailure(failed({ stderrClass: classifyStderr(OPEN_MISSING_PATH) }))).toBe(
      "project-missing",
    );
  });

  it("maps exit 1 with unrecognised stderr to spawn-failed", () => {
    expect(mapLaunchFailure(failed({ exitCode: 1, stderrClass: "other" }))).toBe("spawn-failed");
  });

  it("only ever answers a D-26 kind", () => {
    const kinds = new Set<string>(LAUNCH_ERROR_KINDS);
    for (const stderrClass of STDERR_CLASSES) {
      for (const timedOut of [false, true]) {
        for (const errno of [null, "ENOENT"]) {
          expect(kinds.has(mapLaunchFailure(failed({ stderrClass, timedOut, errno })))).toBe(true);
        }
      }
    }
  });
});
