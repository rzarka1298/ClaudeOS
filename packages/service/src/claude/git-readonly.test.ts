import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GitArgvRefusedError,
  type GitExecFile,
  READ_ONLY_GIT_ARGV,
  runGit,
} from "./git-readonly.js";

const SERVICE_SRC = join(import.meta.dirname, "..");

interface Call {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: Parameters<GitExecFile>[2];
}

function spyExec(stdout = "/somewhere\n") {
  const calls: Call[] = [];
  const execFile: GitExecFile = async (file, args, options) => {
    calls.push({ file, args, options });
    return { stdout };
  };
  return { calls, execFile };
}

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "ccc-git-ro-")));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the read-only git gateway (Test 1, SESS-11, D-30, T-05-45, T-05-46)", () => {
  it("allows exactly the two argv forms attribution uses", () => {
    expect(READ_ONLY_GIT_ARGV).toEqual([
      ["rev-parse", "--show-toplevel"],
      ["rev-parse", "--git-common-dir"],
    ]);
  });

  it("runs /usr/bin/git with fsmonitor off, lock-free and prompt-free env, cwd and a timeout", async () => {
    const spy = spyExec("/repo/root\n");
    const out = await runGit(dir, ["rev-parse", "--show-toplevel"], { execFile: spy.execFile });
    expect(out).toBe("/repo/root");
    expect(spy.calls).toHaveLength(1);
    const [call] = spy.calls;
    expect(call?.file).toBe("/usr/bin/git");
    expect(call?.args).toEqual(["-c", "core.fsmonitor=false", "rev-parse", "--show-toplevel"]);
    expect(call?.options.cwd).toBe(dir);
    expect(call?.options.env.GIT_OPTIONAL_LOCKS).toBe("0");
    expect(call?.options.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(call?.options.env.GIT_DIR).toBeUndefined();
    expect(call?.options.timeout).toBeGreaterThan(0);
  });

  it.each([
    [["worktree", "add", "x"]],
    [["checkout", "main"]],
    [["rev-parse", "--show-toplevel", "--git-dir"]],
    [["-c", "core.fsmonitor=true", "rev-parse", "--show-toplevel"]],
    [["rev-parse"]],
    [["worktree", "list"]],
    // Unused by 05-11's linked-worktree logic (it asks --git-common-dir), so not allowed (wave 4 review).
    [["worktree", "list", "--porcelain"]],
    [[]],
  ])("refuses %j before any spawn", async (argv) => {
    const spy = spyExec();
    await expect(runGit(dir, argv, { execFile: spy.execFile })).rejects.toBeInstanceOf(
      GitArgvRefusedError,
    );
    expect(spy.calls).toHaveLength(0);
  });

  it("refuses a relative or NUL-bearing cwd before any spawn", async () => {
    const spy = spyExec();
    await expect(
      runGit("relative/dir", ["rev-parse", "--show-toplevel"], { execFile: spy.execFile }),
    ).rejects.toBeInstanceOf(GitArgvRefusedError);
    await expect(
      runGit(`${dir}\0x`, ["rev-parse", "--show-toplevel"], { execFile: spy.execFile }),
    ).rejects.toBeInstanceOf(GitArgvRefusedError);
    expect(spy.calls).toHaveLength(0);
  });

  it("reads a real repository's toplevel through the real git", async () => {
    execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
    mkdirSync(join(dir, "src"));
    const top = await runGit(join(dir, "src"), ["rev-parse", "--show-toplevel"]);
    expect(realpathSync(top)).toBe(dir);
  });
});

/** Every non-test TypeScript file under packages/service/src. */
function serviceSources(): string[] {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path);
    }
  };
  walk(SERVICE_SRC);
  return out;
}

describe("the gateway is the only git spawn in the service (Test 2, source scan)", () => {
  const quote = "[\"'`]";
  const spawnOfGit = new RegExp(
    `\\b(?:execFile|execFileSync|spawn|spawnSync|exec|execSync|fork)\\s*\\(\\s*${quote}[^"'\`]*\\bgit${quote}`,
  );
  const gitLiteral = new RegExp(`${quote}(?:/usr/bin/git|git)${quote}`);

  it("finds the scanner itself working on a planted sample", () => {
    expect(spawnOfGit.test(`execFile("git", ["status"])`)).toBe(true);
    expect(spawnOfGit.test(`spawn('/usr/bin/git', argv)`)).toBe(true);
    expect(gitLiteral.test(`const GIT = "/usr/bin/git";`)).toBe(true);
  });

  it("no file other than git-readonly.ts spawns git or names the git binary", () => {
    const sources = serviceSources();
    expect(sources.length).toBeGreaterThan(10);
    const offenders = sources
      .filter((path) => !path.endsWith(join("claude", "git-readonly.ts")))
      .filter((path) => {
        const text = readFileSync(path, "utf8");
        return spawnOfGit.test(text) || gitLiteral.test(text);
      })
      .map((path) => relative(SERVICE_SRC, path));
    expect(offenders).toEqual([]);
  });
});
