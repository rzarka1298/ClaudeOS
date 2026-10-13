import { describe, expect, it } from "vitest";
import { type ExecFile, readGitFacts } from "./git-facts.js";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const SINCE = "89abcdef01";

interface Call {
  file: string;
  args: readonly string[];
  cwd: string | undefined;
}

function fake(replies: Record<string, string | Error>): { exec: ExecFile; calls: Call[] } {
  const calls: Call[] = [];
  const exec: ExecFile = async (file, args, options) => {
    calls.push({ file, args, cwd: options?.cwd });
    const reply = replies[args.join(" ")];
    if (reply === undefined) throw new Error("unexpected git call");
    if (reply instanceof Error) throw reply;
    return { stdout: reply };
  };
  return { exec, calls };
}

const CLEAN_REPLIES = {
  "rev-parse HEAD": `${HEAD}\n`,
  "status --porcelain --untracked-files=no -- . :(exclude).planning": "",
  "ls-files --others --exclude-standard -z -- packages scripts": "",
};

describe("readGitFacts (Test 3)", () => {
  it("returns the HEAD and a clean flag for an unchanged tree", async () => {
    const { exec } = fake(CLEAN_REPLIES);
    await expect(readGitFacts({ exec, cwd: "/repo" })).resolves.toEqual({
      head: HEAD,
      clean: true,
      changedSince: null,
    });
  });

  it("is not clean when the porcelain output is non-empty", async () => {
    const { exec } = fake({
      ...CLEAN_REPLIES,
      "status --porcelain --untracked-files=no -- . :(exclude).planning":
        " M packages/plugin/src/main.ts\n",
    });
    const facts = await readGitFacts({ exec, cwd: "/repo" });
    expect(facts.clean).toBe(false);
  });

  it("excludes untracked files from the clean check", async () => {
    const { exec, calls } = fake(CLEAN_REPLIES);
    await readGitFacts({ exec, cwd: "/repo" });
    const status = calls.find((call) => call.args[0] === "status");
    expect(status?.args).toContain("--untracked-files=no");
  });

  it("lists the files changed since a given commit from the name-only diff", async () => {
    const { exec } = fake({
      ...CLEAN_REPLIES,
      [`diff --name-only -z --no-renames ${SINCE} HEAD --`]:
        "packages/e2e/src/a.ts\0.planning/x.md\0",
    });
    const facts = await readGitFacts({ exec, cwd: "/repo", since: SINCE });
    expect(facts.changedSince).toEqual(["packages/e2e/src/a.ts", ".planning/x.md"]);
  });

  it("calls git with argv arrays only and the working directory, never a shell string", async () => {
    const { exec, calls } = fake({
      ...CLEAN_REPLIES,
      [`diff --name-only -z --no-renames ${SINCE} HEAD --`]: "",
    });
    await readGitFacts({ exec, cwd: "/repo", since: SINCE });
    expect(calls.length).toBe(4);
    for (const call of calls) {
      expect(call.file).toBe("git");
      expect(Array.isArray(call.args)).toBe(true);
      expect(call.args.every((arg) => !/[\s;&|$`]/.test(arg))).toBe(true);
      expect(call.cwd).toBe("/repo");
    }
  });

  it("does not run git with a since value that is not a commit hash", async () => {
    const { exec, calls } = fake(CLEAN_REPLIES);
    const facts = await readGitFacts({ exec, cwd: "/repo", since: "--output=/tmp/x; rm -rf /" });
    expect(facts.changedSince).toBeNull();
    expect(calls.some((call) => call.args[0] === "diff")).toBe(false);
  });

  it("returns an unknown HEAD and an unclean tree when git fails, without throwing", async () => {
    const { exec } = fake({ "rev-parse HEAD": new Error("not a repository") });
    await expect(readGitFacts({ exec, cwd: "/repo", since: SINCE })).resolves.toEqual({
      head: "unknown",
      clean: false,
      changedSince: null,
    });
  });

  it("reports unknown changes when only the diff fails", async () => {
    const { exec } = fake({
      ...CLEAN_REPLIES,
      [`diff --name-only -z --no-renames ${SINCE} HEAD --`]: new Error("bad revision"),
    });
    const facts = await readGitFacts({ exec, cwd: "/repo", since: SINCE });
    expect(facts).toEqual({ head: HEAD, clean: true, changedSince: null });
  });

  it("treats a HEAD answer that is not a hash as unknown", async () => {
    const { exec } = fake({ ...CLEAN_REPLIES, "rev-parse HEAD": "fatal: odd output\n" });
    const facts = await readGitFacts({ exec, cwd: "/repo" });
    expect(facts.head).toBe("unknown");
  });
});
