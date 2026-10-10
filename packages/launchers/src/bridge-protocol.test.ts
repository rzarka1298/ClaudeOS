import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BRIDGE_BANNED_TOKENS,
  BRIDGE_CAPABILITIES,
  BRIDGE_CLAIMED_KEEP_MS,
  BRIDGE_CONTAIN_DELAY_MS,
  BRIDGE_DIRECTORY_NAMES,
  BRIDGE_FUTURE_SKEW_MS,
  BRIDGE_HEARTBEAT_FRESH_MS,
  BRIDGE_KINDS,
  BRIDGE_MODES,
  BRIDGE_PROTOCOL_MARKER_FILE,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_REQUEST_FILE_PATTERN,
  BRIDGE_ROLES,
  BRIDGE_RUN_ID_PATTERN,
  BRIDGE_STATE_PROBES,
  BRIDGE_TTL_MS,
  bridgeCommandPath,
  bridgeStateDir,
  createRunIdMinter,
  formatBridgeRunId,
  parseBridgeRunId,
  projectDirName,
  projectStateCandidates,
} from "./bridge-protocol.js";

describe("bridge protocol constants (D-12)", () => {
  it("equal the documented values", () => {
    expect(BRIDGE_PROTOCOL_VERSION).toBe(2);
    expect(BRIDGE_CAPABILITIES).toEqual(["follow", "tui", "agent"]);
    expect(BRIDGE_RUN_ID_PATTERN.source).toBe("^[0-9]{8}T[0-9]{9}Z$");
    expect(BRIDGE_REQUEST_FILE_PATTERN.source).toBe("^[0-9]{8}T[0-9]{9}Z\\.json$");
    expect(BRIDGE_KINDS).toEqual(["review", "task", "resume", "agent"]);
    expect(BRIDGE_MODES).toEqual(["follow", "tui", "agent"]);
    expect(BRIDGE_KINDS.at(-1)).toBe("agent");
    expect(BRIDGE_MODES.at(-1)).toBe("agent");
    expect(BRIDGE_ROLES).toEqual(["review", "plan", "task", "chore"]);
    expect(BRIDGE_TTL_MS).toBe(10 * 60 * 1000);
    expect(BRIDGE_FUTURE_SKEW_MS).toBe(60 * 1000);
    expect(BRIDGE_HEARTBEAT_FRESH_MS).toBe(90 * 1000);
    expect(BRIDGE_CONTAIN_DELAY_MS).toBe(2000);
    expect(BRIDGE_CLAIMED_KEEP_MS).toBe(24 * 60 * 60 * 1000);
    expect(BRIDGE_DIRECTORY_NAMES).toEqual({
      requests: "requests",
      claimed: "claimed",
      windows: "windows",
      prompts: "prompts",
      tui: "tui",
    });
    expect(BRIDGE_PROTOCOL_MARKER_FILE).toBe("protocol.json");
  });

  it("carries the eight ban tokens, normalised, Phase 4 pair first", () => {
    expect(BRIDGE_BANNED_TOKENS).toEqual([
      "dangerouslyskippermissions",
      "bypasspermissions",
      "dangerouslybypassapprovalsandsandbox",
      "dangerouslybypasshooktrust",
      "yolo",
      "fullauto",
      "approveforme",
      "dangerfullaccess",
    ]);
  });

  it("lists the ten state probes under .planning/codex", () => {
    expect(BRIDGE_STATE_PROBES).toHaveLength(10);
    expect(BRIDGE_STATE_PROBES).toContain(".planning/codex/pending-resume.json");
    expect(BRIDGE_STATE_PROBES.every((p) => p.startsWith(".planning/codex/"))).toBe(true);
  });
});

describe("bridgeStateDir and bridgeCommandPath", () => {
  it("uses XDG_STATE_HOME/codex-bridge when it is an absolute path", () => {
    expect(bridgeStateDir({ XDG_STATE_HOME: "/Users/USERNAME/state" }, "/Users/USERNAME")).toBe(
      "/Users/USERNAME/state/codex-bridge",
    );
    expect(bridgeStateDir({ XDG_STATE_HOME: "/a//b/../c/" }, "/h")).toBe("/a/c/codex-bridge");
  });

  it("falls back to home/.local/state/codex-bridge when it is unset, empty or relative", () => {
    const fallback = "/Users/USERNAME/.local/state/codex-bridge";
    expect(bridgeStateDir({}, "/Users/USERNAME")).toBe(fallback);
    expect(bridgeStateDir({ XDG_STATE_HOME: "" }, "/Users/USERNAME")).toBe(fallback);
    expect(bridgeStateDir({ XDG_STATE_HOME: "state" }, "/Users/USERNAME")).toBe(fallback);
    expect(bridgeStateDir({ XDG_STATE_HOME: undefined }, "/Users/USERNAME")).toBe(fallback);
  });

  it("the fixed helper lives at home/.local/bin/codex-bridge", () => {
    expect(bridgeCommandPath("/Users/USERNAME")).toBe("/Users/USERNAME/.local/bin/codex-bridge");
  });
});

describe("projectDirName and projectStateCandidates", () => {
  it("replaces unsafe characters, cuts to 40, falls back to project, appends 10 hex of SHA-256", () => {
    expect(projectDirName("/Users/USERNAME/repo")).toBe("repo-dc4ed52e1d");
    expect(projectDirName("/Users/USERNAME/my project")).toBe("my_project-5120eb7f5c");
    expect(projectDirName("/")).toBe("project-8a5edab282");
    expect(projectDirName(`/a/${"x".repeat(50)}`)).toBe(`${"x".repeat(40)}-2823a50584`);
    expect(projectDirName("/Users/USERNAME/repo/")).toMatch(/^repo-[0-9a-f]{10}$/);
    expect(projectDirName("/Users/USERNAME/a.b_c-d")).toMatch(/^a\.b_c-d-[0-9a-f]{10}$/);
  });

  it("returns the in-repo candidate first and the user-level one second", () => {
    expect(
      projectStateCandidates("/Users/USERNAME/repo", "/Users/USERNAME/.local/state/codex-bridge"),
    ).toEqual([
      "/Users/USERNAME/repo/.planning/codex",
      "/Users/USERNAME/.local/state/codex-bridge/projects/repo-dc4ed52e1d",
    ]);
  });
});

describe("run id minter (Pitfall 3: same-millisecond collisions)", () => {
  const FIXED = Date.UTC(2026, 9, 10, 12, 34, 56, 789);

  it("formats and parses the nineteen-character millisecond id", () => {
    expect(formatBridgeRunId(FIXED)).toBe("20261010T123456789Z");
    expect(parseBridgeRunId("20261010T123456789Z")).toBe(FIXED);
    expect(parseBridgeRunId("20261310T123456789Z")).toBeNull();
    expect(parseBridgeRunId("20261010T123456789")).toBeNull();
    expect(parseBridgeRunId("not an id")).toBeNull();
    expect(parseBridgeRunId("../20261010T123456789Z")).toBeNull();
  });

  it("returns strictly increasing ids for a clock stuck on one millisecond", () => {
    const mint = createRunIdMinter(() => FIXED);
    const [a, b, c] = [mint(), mint(), mint()] as [string, string, string];
    expect(a).toBe("20261010T123456789Z");
    expect(b).toBe("20261010T123456790Z");
    expect(c).toBe("20261010T123456791Z");
  });

  it("keeps increasing when the clock moves backwards, and follows it again once it catches up", () => {
    const readings = [FIXED, FIXED - 5000, FIXED - 1, FIXED + 10, FIXED + 10, FIXED + 100];
    let i = 0;
    const mint = createRunIdMinter(() => readings[i++] ?? FIXED);
    const ids = readings.map(() => mint());
    expect(ids.map((id) => parseBridgeRunId(id))).toEqual([
      FIXED,
      FIXED + 1,
      FIXED + 2,
      FIXED + 10,
      FIXED + 11,
      FIXED + 100,
    ]);
  });

  it("mints 1000 unique, sorted, pattern-matching ids that round-trip, frozen clock and backwards clock", () => {
    for (const clock of [
      () => FIXED,
      (() => {
        let t = FIXED;
        return () => (t -= 3);
      })(),
    ]) {
      const mint = createRunIdMinter(clock);
      const ids = Array.from({ length: 1000 }, () => mint());
      expect(new Set(ids).size).toBe(1000);
      expect([...ids].sort()).toEqual(ids);
      for (const id of ids) {
        expect(id).toMatch(BRIDGE_RUN_ID_PATTERN);
        expect(formatBridgeRunId(parseBridgeRunId(id) as number)).toBe(id);
      }
    }
  });

  it("survives a clock that returns a non-finite reading", () => {
    const readings = [FIXED, Number.NaN, Number.POSITIVE_INFINITY * 0];
    let i = 0;
    const mint = createRunIdMinter(() => readings[i++] ?? Number.NaN);
    const ids = [mint(), mint(), mint()];
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(BRIDGE_RUN_ID_PATTERN);
  });
});

describe("module purity", () => {
  it("imports nothing from Node but the hash function, and no process or filesystem API", () => {
    const source = readFileSync(new URL("./bridge-protocol.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/^import .* from "([^"]+)";?$/gm)].map((m) => m[1]);
    expect(imports.filter((s) => s?.startsWith("node:"))).toEqual(["node:crypto"]);
    expect(source).not.toMatch(/\bprocess\./);
    expect(source).not.toMatch(/node:(fs|path|os|child_process)/);
    expect(source).toMatch(/import \{ createHash \} from "node:crypto"/);
  });
});
