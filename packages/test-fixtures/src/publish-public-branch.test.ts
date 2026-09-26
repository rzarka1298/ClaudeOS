// scripts/publish-public-branch.sh — only the input validation is exercised
// here, and only on values that must be refused BEFORE the script clones or
// filters anything. The script is never run to completion by a test, and
// never against the real repository (judge-r1 finding 8).
//
// GH_USER is derived from remote.public.url and spliced into the Python
// expression git-filter-repo evaluates for --email-callback. A quote in it
// would end the bytes literal and let the rest of the value run as Python, so
// the username is validated against GitHub's own alphabet first.

import { afterEach, describe, expect, it } from "vitest";
import { type GateRepo, gateRepo } from "./gate-repo.js";

const SCRIPT = "scripts/publish-public-branch.sh";

const repos: GateRepo[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.dispose();
});

function publishWithRemote(url: string) {
  const repo = gateRepo([SCRIPT], { "README.md": "synthetic\n" });
  repos.push(repo);
  repo.git("commit", "-q", "-m", "init");
  repo.git("remote", "add", "public", url);
  const result = repo.run(SCRIPT);
  const refs = repo.git("for-each-ref", "--format=%(refname)");
  return { ...result, refs };
}

describe("publish-public-branch.sh GH_USER validation (judge-r1 finding 8)", () => {
  it.each([
    ["a single quote", "https://github.com/own'er/repo.git"],
    ["a python injection", "https://github.com/x'+__import__('os').system('id')+b'/repo.git"],
    ["a double quote", 'https://github.com/own"er/repo.git'],
    ["a space", "https://github.com/own er/repo.git"],
    ["an underscore", "https://github.com/own_er/repo.git"],
  ])("refuses a username containing %s before cloning anything", (_label, url) => {
    const result = publishWithRemote(url);
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("is not a valid GitHub username");
    // Refused before the clone: nothing reached the filter, no branch was made.
    expect(result.out).not.toContain("filter-repo");
    expect(result.refs).not.toContain("refs/heads/public/main");
  });
});
