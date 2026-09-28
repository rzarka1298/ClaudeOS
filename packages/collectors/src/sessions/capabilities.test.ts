import { describe, expect, it } from "vitest";
import {
  CAPABILITY_TABLE,
  capabilitiesFor,
  compareVersions,
  MIN_SUPPORTED_CLAUDE_VERSION,
  parseClaudeVersionOutput,
  supportStatus,
} from "./capabilities.js";

describe("Claude Code version parsing (Test 1)", () => {
  it("reads the version from `claude --version` output", () => {
    expect(parseClaudeVersionOutput("2.1.283 (Claude Code)\n")).toBe("2.1.283");
  });

  it.each(["", "Claude Code", "command not found: claude\n", "v2.1", "2.1.x (Claude Code)"])(
    "returns null for output that carries no version: %j",
    (output) => {
      expect(parseClaudeVersionOutput(output)).toBeNull();
    },
  );
});

describe("version ordering (Test 2)", () => {
  it("orders versions numerically, not lexically", () => {
    const shuffled = ["2.2.0", "2.1.283", "2.1.99", "2.1.214", "2.1.223"];
    expect([...shuffled].sort(compareVersions)).toEqual([
      "2.1.99",
      "2.1.214",
      "2.1.223",
      "2.1.283",
      "2.2.0",
    ]);
  });

  it("treats equal versions as equal", () => {
    expect(compareVersions("2.1.214", "2.1.214")).toBe(0);
  });
});

describe("capability table (Test 3, SESS-18, PR-09)", () => {
  it("sets the minimum supported version at 2.1.214", () => {
    expect(MIN_SUPPORTED_CLAUDE_VERSION).toBe("2.1.214");
    expect(CAPABILITY_TABLE.every((row) => compareVersions(row.since, "2.1.214") >= 0)).toBe(true);
  });

  it("reports every capability for 2.1.283", () => {
    expect(capabilitiesFor("2.1.283")).toEqual(
      expect.arrayContaining([
        "fork-source",
        "claude-pid",
        "cross-project-resume",
        "post-model-switch",
        "sessionend-per-hook-timeout",
      ]),
    );
  });

  it("does not report cross-project resume for 2.1.220", () => {
    const capabilities = capabilitiesFor("2.1.220");
    expect(capabilities).toContain("claude-pid");
    expect(capabilities).not.toContain("cross-project-resume");
  });

  it("reports no capability for an unparsable version", () => {
    expect(capabilitiesFor("not-a-version")).toEqual([]);
  });

  it.each([
    ["2.1.283", "supported"],
    ["2.1.214", "supported"],
    ["2.1.200", "unsupported"],
    ["1.9.999", "unsupported"],
    [null, "unknown"],
    ["garbage", "unknown"],
  ] as const)("support status of %j is %s, never supported by default", (version, status) => {
    expect(supportStatus(version)).toBe(status);
  });
});
