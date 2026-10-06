import { describe, expect, it } from "vitest";
import { classifyLaunchSource } from "./launch-source.js";
import type { AncestorEntry, ProcessFacts } from "./process-facts.js";

const PID = 5150;
const CLAUDE_BIN = "/Users/USERNAME/.local/share/claude/versions/2.1.0";

type Facts = Pick<ProcessFacts, "readTty" | "readAncestry">;

function facts(tty: string | null, ancestry: AncestorEntry[]): Facts {
  return { readTty: async () => tty, readAncestry: async () => ancestry };
}

/** The Claude process itself, then its parents. */
function chain(...comms: string[]): AncestorEntry[] {
  return comms.map((comm, i) => ({ pid: PID + i, ppid: PID + i + 1, comm }));
}

const PLAIN = chain(
  CLAUDE_BIN,
  "-zsh",
  "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
);

describe("classifyLaunchSource (Test 1, PR-03, RESEARCH C-1 and A9)", () => {
  it("CCC_LAUNCH_SOURCE=dashboard gives dashboard, whatever the tty", async () => {
    expect(
      await classifyLaunchSource(
        { env: { CCC_LAUNCH_SOURCE: "dashboard" }, pid: PID },
        facts(null, PLAIN),
      ),
    ).toBe("dashboard");
    expect(
      await classifyLaunchSource(
        { env: { CCC_LAUNCH_SOURCE: "dashboard" }, pid: PID },
        facts("ttys004", PLAIN),
      ),
    ).toBe("dashboard");
  });

  it("an ancestor running Claude Code (a versions path) gives external", async () => {
    const nested = chain(CLAUDE_BIN, "/bin/zsh", CLAUDE_BIN, "-zsh");
    expect(await classifyLaunchSource({ env: {}, pid: PID }, facts("ttys004", nested))).toBe(
      "external",
    );
  });

  it("an ancestor whose basename is claude (the desktop supervisor) gives external (Pitfall 15)", async () => {
    const background = chain(CLAUDE_BIN, "/Applications/ClaudeCode.app/Contents/MacOS/claude");
    expect(await classifyLaunchSource({ env: {}, pid: PID }, facts("ttys009", background))).toBe(
      "external",
    );
  });

  it("the pid's own Claude binary is not an ancestor", async () => {
    expect(await classifyLaunchSource({ env: {}, pid: PID }, facts("ttys004", PLAIN))).toBe(
      "terminal",
    );
  });

  it("no tty gives external", async () => {
    expect(await classifyLaunchSource({ env: {}, pid: PID }, facts(null, PLAIN))).toBe("external");
  });

  it("a tty with no Claude ancestor gives terminal", async () => {
    expect(await classifyLaunchSource({ env: {}, pid: PID }, facts("ttys004", PLAIN))).toBe(
      "terminal",
    );
  });

  it("CLAUDE_CODE_CHILD_SESSION=1 changes nothing (C-1: every hook sees it)", async () => {
    const env = { CLAUDE_CODE_CHILD_SESSION: "1" };
    expect(await classifyLaunchSource({ env, pid: PID }, facts("ttys004", PLAIN))).toBe("terminal");
    expect(await classifyLaunchSource({ env, pid: PID }, facts(null, PLAIN))).toBe("external");
  });

  it("a process-facts failure gives null (Not reported), never a guess", async () => {
    expect(await classifyLaunchSource({ env: {}, pid: PID }, facts(null, []))).toBeNull();
    const throwing: Facts = {
      readTty: async () => {
        throw new Error("ps failed");
      },
      readAncestry: async () => {
        throw new Error("ps failed");
      },
    };
    expect(await classifyLaunchSource({ env: {}, pid: PID }, throwing)).toBeNull();
  });

  it("a record without a pid gives null unless the dashboard said so", async () => {
    expect(await classifyLaunchSource({ env: {}, pid: null }, facts("ttys004", PLAIN))).toBeNull();
    expect(
      await classifyLaunchSource(
        { env: { CCC_LAUNCH_SOURCE: "dashboard" }, pid: null },
        facts(null, []),
      ),
    ).toBe("dashboard");
  });
});
