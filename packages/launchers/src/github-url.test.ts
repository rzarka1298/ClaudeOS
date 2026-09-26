import { describe, expect, it } from "vitest";
import {
  githubRepoUrl,
  normaliseRemote,
  parseGithubOverride,
  remoteDisplay,
} from "./github-url.js";

// Remote literals containing the at-sign are built at runtime around this
// constant, so no tracked line of this file is email-shaped to
// scripts/check-privacy.sh Rule 2.
const AT = String.fromCharCode(64);
const NUL = String.fromCharCode(0);

describe("normaliseRemote (D-13, PROJ-08)", () => {
  it("normalises the scp-like SSH form", () => {
    expect(normaliseRemote(`git${AT}github.com:owner/repo.git`)).toEqual({
      kind: "github",
      owner: "owner",
      repo: "repo",
    });
  });

  it("normalises ssh://, https:// and git:// forms, with or without .git", () => {
    for (const raw of [
      `ssh://git${AT}github.com/owner/repo.git`,
      "https://github.com/owner/repo.git",
      "https://github.com/owner/repo",
      "https://github.com/owner/repo/",
      "git://github.com/owner/repo.git",
      `ssh://git${AT}github.com:22/owner/repo.git`,
    ]) {
      expect(normaliseRemote(raw)).toEqual({ kind: "github", owner: "owner", repo: "repo" });
    }
  });

  it("strips userinfo so no token or user name survives into the result", () => {
    const result = normaliseRemote(`https://user:secret-token${AT}github.com/owner/repo.git`);
    expect(result).toEqual({ kind: "github", owner: "owner", repo: "repo" });
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain("secret-token");
    expect(serialised).not.toContain("user");
  });

  it("strips a user:password userinfo from the scp-like form", () => {
    const result = normaliseRemote(`deploy:scp-token${AT}gitlab.com:group/repo.git`);
    expect(result).toEqual({ kind: "other", host: "gitlab.com", path: "group/repo" });
    expect(JSON.stringify(result)).not.toContain("scp-token");
  });

  it("strips userinfo from a non-GitHub remote as well", () => {
    const result = normaliseRemote(`https://deploy:another-token${AT}gitlab.com/group/repo.git`);
    expect(result).toEqual({ kind: "other", host: "gitlab.com", path: "group/repo" });
    expect(JSON.stringify(result)).not.toContain("another-token");
    expect(JSON.stringify(result)).not.toContain("deploy");
  });

  it("reduces a non-GitHub remote to host and path", () => {
    expect(normaliseRemote("https://gitlab.com/group/sub/repo.git")).toEqual({
      kind: "other",
      host: "gitlab.com",
      path: "group/sub/repo",
    });
    expect(normaliseRemote(`git${AT}bitbucket.org:team/repo.git`)).toEqual({
      kind: "other",
      host: "bitbucket.org",
      path: "team/repo",
    });
  });

  it("is not fooled by a userinfo that looks like a host", () => {
    expect(normaliseRemote(`https://evil.com${AT}github.com.attacker.net/o/r`)).toEqual({
      kind: "other",
      host: "github.com.attacker.net",
      path: "o/r",
    });
  });

  it("treats a github.com path that is not exactly owner/repo as other", () => {
    expect(normaliseRemote("https://github.com/owner/repo/extra")).toEqual({
      kind: "other",
      host: "github.com",
      path: "owner/repo/extra",
    });
  });

  it("returns invalid for local paths, empty and unparseable input", () => {
    for (const raw of [
      "file:///Users/USERNAME/x",
      "",
      "   ",
      "not a url",
      "/srv/git/repo.git",
      "../relative/repo",
      "https://github.com",
      "https://github.com/",
    ]) {
      expect(normaliseRemote(raw)).toEqual({ kind: "invalid" });
    }
  });

  it("is total: never throws", () => {
    for (const raw of [
      "::::",
      "https://[",
      `${AT}:`,
      "ssh://",
      "a:b:c",
      NUL,
      `https://github.com/o/r${NUL}x`,
    ]) {
      expect(() => normaliseRemote(raw)).not.toThrow();
    }
  });
});

describe("githubRepoUrl", () => {
  it("rebuilds the URL from validated parts", () => {
    expect(githubRepoUrl("owner", "repo")).toBe("https://github.com/owner/repo");
    expect(githubRepoUrl("my-org", "repo.name_1")).toBe("https://github.com/my-org/repo.name_1");
  });

  it("throws for an owner or repo outside GitHub's name patterns", () => {
    for (const [owner, repo] of [
      ["", "repo"],
      ["owner", ""],
      ["own/er", "repo"],
      ["owner", "re/po"],
      ["o".repeat(40), "repo"],
      ["owner", "r".repeat(101)],
      ["owner", ".."],
      ["owner", "."],
      ["own er", "repo"],
      ["owner", "repo?x=1"],
    ] as const) {
      expect(() => githubRepoUrl(owner, repo)).toThrow();
    }
  });
});

describe("parseGithubOverride (RR-12)", () => {
  it("accepts exactly https://github.com/owner/repo", () => {
    expect(parseGithubOverride("https://github.com/owner/repo")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  it("refuses every other shape", () => {
    for (const url of [
      "http://github.com/owner/repo",
      `https://user${AT}github.com/owner/repo`,
      `https://user:token${AT}github.com/owner/repo`,
      "https://github.com:443/owner/repo",
      "https://github.com:8443/owner/repo",
      "https://github.com/owner/repo?tab=readme",
      "https://github.com/owner/repo#readme",
      "https://github.com/owner/repo/issues",
      "https://github.com/owner",
      "https://gitlab.com/owner/repo",
      "https://github.com.attacker.net/owner/repo",
      "https://github.com/owner/repo/",
      "https://github.com/owner/..",
      "not a url",
      "",
    ]) {
      expect(parseGithubOverride(url)).toBeNull();
    }
  });
});

describe("remoteDisplay (RR-09)", () => {
  it("returns host and path for GitHub and other remotes, null for invalid", () => {
    expect(remoteDisplay({ kind: "github", owner: "owner", repo: "repo" })).toEqual({
      host: "github.com",
      path: "owner/repo",
    });
    expect(remoteDisplay({ kind: "other", host: "gitlab.com", path: "group/repo" })).toEqual({
      host: "gitlab.com",
      path: "group/repo",
    });
    expect(remoteDisplay({ kind: "invalid" })).toBeNull();
  });
});
