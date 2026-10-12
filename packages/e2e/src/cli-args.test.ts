import { describe, expect, it } from "vitest";
import { parseRunArgs, RUN_USAGE, UsageError } from "./cli-args.js";

const REPO = "/Users/USERNAME/ClaudeOS";
const env = { repoRoot: REPO, isDirectory: () => false };

function refusal(argv: string[], options = env): string {
  try {
    parseRunArgs(argv, options);
  } catch (error) {
    expect(error).toBeInstanceOf(UsageError);
    return (error as Error).message;
  }
  throw new Error("expected a usage error");
}

describe("parseRunArgs (Test 1)", () => {
  it("defaults to the standard profile with nothing else set", () => {
    expect(parseRunArgs([], env)).toEqual({
      help: false,
      profile: "standard",
      script: undefined,
      phaseDir: undefined,
      out: undefined,
      shotsDir: undefined,
      specs: [],
    });
  });

  it("accepts every option, with --spec repeated", () => {
    const args = parseRunArgs(
      [
        "--profile",
        "full",
        "--script",
        "/work/06-UAT.md",
        "--phase-dir",
        "/work/phase",
        "--out",
        "/work/report.md",
        "--shots-dir",
        "/private/shots",
        "--spec",
        "./specs/a.e2e.ts",
        "--spec",
        "./specs/b.e2e.ts",
      ],
      env,
    );
    expect(args.profile).toBe("full");
    expect(args.script).toBe("/work/06-UAT.md");
    expect(args.phaseDir).toBe("/work/phase");
    expect(args.out).toBe("/work/report.md");
    expect(args.shotsDir).toBe("/private/shots");
    expect(args.specs).toEqual(["./specs/a.e2e.ts", "./specs/b.e2e.ts"]);
  });

  it("refuses an unknown flag naming only the flag, never its value", () => {
    const message = refusal(["--bogus=hunter2"]);
    expect(message).toContain("--bogus");
    expect(message).not.toContain("hunter2");
  });

  it("refuses a positional argument without echoing it", () => {
    const message = refusal(["somewhere/secret.md"]);
    expect(message).not.toContain("secret");
  });

  it("refuses an invalid profile without echoing it", () => {
    const message = refusal(["--profile", "weirdvalue"]);
    expect(message).toContain("--profile");
    expect(message).not.toContain("weirdvalue");
  });

  it("refuses a --shots-dir inside the repository, relative or not absolute", () => {
    expect(refusal(["--shots-dir", `${REPO}/packages/e2e/shots`])).toContain("--shots-dir");
    expect(refusal(["--shots-dir", REPO])).toContain("--shots-dir");
    expect(refusal(["--shots-dir", "shots"])).toContain("--shots-dir");
  });

  it("refuses an --out path that is an existing directory", () => {
    const message = refusal(["--out", "/work/dir"], {
      repoRoot: REPO,
      isDirectory: (path) => path === "/work/dir",
    });
    expect(message).toContain("--out");
    expect(message).not.toContain("/work/dir");
  });

  it("returns help and carries the usage text", () => {
    expect(parseRunArgs(["--help"], env).help).toBe(true);
    expect(RUN_USAGE).toContain("--profile");
    expect(RUN_USAGE).toContain("standard");
    expect(RUN_USAGE).toContain("full");
  });
});
