import { describe, expect, it } from "vitest";
import { COMMANDS, createRunPorts, main } from "./cli.js";
import type { RunOptions, RunOutcome, RunPorts } from "./run-uat.js";

const OUTCOME: RunOutcome = {
  exitCode: 0,
  message: "",
  runId: "0123abcd",
  reportPath: null,
  lookPending: [],
  failedItems: [],
};

describe("cli command table (Test 9)", () => {
  it("holds run, preflight, look, report, ratify and lint-tags", () => {
    expect(Object.keys(COMMANDS).sort()).toEqual(
      ["lint-tags", "look", "preflight", "ratify", "report", "run"].sort(),
    );
  });

  it("exits 2 with the usage text for an unknown command or none", async () => {
    const lines: string[] = [];
    expect(await main(["bogus"], { write: (line) => lines.push(line) })).toBe(2);
    expect(lines.join("\n")).toContain("Usage");
    const none: string[] = [];
    expect(await main([], { write: (line) => none.push(line) })).toBe(2);
    expect(none.join("\n")).toContain("Usage");
  });

  it("wires the run handler to runUat with the parsed options and the real ports", async () => {
    const seen: Array<{ options: RunOptions; ports: RunPorts }> = [];
    const ports = createRunPorts();
    const code = await main(["run", "--profile", "full", "--spec", "./specs/a.e2e.ts"], {
      write: () => {},
      createRunPorts: () => ports,
      runUat: async (options, given) => {
        seen.push({ options, ports: given });
        return OUTCOME;
      },
    });
    expect(code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.options.profile).toBe("full");
    expect(seen[0]?.options.specs).toEqual(["./specs/a.e2e.ts"]);
    expect(seen[0]?.ports).toBe(ports);
  });

  it("returns the outcome's exit code and prints its message", async () => {
    const lines: string[] = [];
    const code = await main(["run"], {
      write: (line) => lines.push(line),
      createRunPorts: () => createRunPorts(),
      runUat: async () => ({ ...OUTCOME, exitCode: 2, message: "Refused for a reason." }),
    });
    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("Refused for a reason.");
  });

  it("exits 2 on a bad run flag without calling runUat", async () => {
    let called = false;
    const lines: string[] = [];
    const code = await main(["run", "--bogus"], {
      write: (line) => lines.push(line),
      runUat: async () => {
        called = true;
        return OUTCOME;
      },
    });
    expect(code).toBe(2);
    expect(called).toBe(false);
    expect(lines.join("\n")).toContain("--bogus");
  });

  it("prints usage and exits 0 for run --help", async () => {
    const lines: string[] = [];
    expect(await main(["run", "--help"], { write: (line) => lines.push(line) })).toBe(0);
    expect(lines.join("\n")).toContain("--profile");
  });

  it("builds real default ports whose every member is present", () => {
    const ports = createRunPorts();
    for (const name of [
      "missingArtifacts",
      "checkInstalledApp",
      "verifyCache",
      "purgeShots",
      "runSandbox",
      "generateVault",
      "stageGeneratedPlugin",
      "createShots",
      "deleteShots",
      "spawnWdio",
      "readResults",
      "readLookPending",
      "readVersions",
      "readScript",
      "readGitFacts",
      "buildHash",
      "writeReport",
      "handoffLooks",
      "now",
      "log",
    ] as const) {
      expect(typeof ports[name], name).toBe("function");
    }
    expect(ports.platform).toBe(process.platform);
  });
});
