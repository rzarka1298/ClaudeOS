import { describe, expect, it } from "vitest";
import {
  type ConfigScopeEntry,
  hasLocalExecutableConfig,
  LOCAL_EXEC_KEY_PATTERN,
  LOCAL_EXEC_KEY_REGEX,
  parseConfigScopeLines,
  parseLogRecords,
  parseRemoteLines,
  parseStatusPorcelainV2,
  selectRemote,
} from "./git-parse.js";

const NUL = String.fromCharCode(0);
const US = String.fromCharCode(0x1f);
const AT = String.fromCharCode(64);
const OID = "0123456789abcdef0123456789abcdef01234567";

function records(...parts: string[]): string {
  return parts.map((p) => `${p}${NUL}`).join("");
}

describe("parseStatusPorcelainV2 (porcelain v2 -z --branch)", () => {
  it("reads a clean tree on a branch", () => {
    expect(parseStatusPorcelainV2(records(`# branch.oid ${OID}`, "# branch.head main"))).toEqual({
      branch: "main",
      detached: false,
      unborn: false,
      dirty: false,
    });
  });

  it("reads a detached HEAD as branch null, detached true", () => {
    expect(
      parseStatusPorcelainV2(records(`# branch.oid ${OID}`, "# branch.head (detached)")),
    ).toEqual({ branch: null, detached: true, unborn: false, dirty: false });
  });

  it("reads an unborn branch from branch.oid (initial)", () => {
    expect(parseStatusPorcelainV2(records("# branch.oid (initial)", "# branch.head main"))).toEqual(
      { branch: "main", detached: false, unborn: true, dirty: false },
    );
  });

  it("ignores upstream and ahead/behind headers", () => {
    const out = records(
      `# branch.oid ${OID}`,
      "# branch.head feature/x",
      "# branch.upstream origin/feature/x",
      "# branch.ab +1 -2",
    );
    expect(parseStatusPorcelainV2(out)).toEqual({
      branch: "feature/x",
      detached: false,
      unborn: false,
      dirty: false,
    });
  });

  it.each([
    ["ordinary change", `1 .M N... 100644 100644 100644 ${OID} ${OID} src/a.ts`],
    ["rename or copy", `2 R. N... 100644 100644 100644 ${OID} ${OID} R100 new.ts`],
    ["unmerged", `u UU N... 100644 100644 100644 100644 ${OID} ${OID} ${OID} c.ts`],
    ["untracked", "? notes.txt"],
  ])("any %s record marks the tree dirty", (_label, record) => {
    const out = records(`# branch.oid ${OID}`, "# branch.head main", record);
    expect(parseStatusPorcelainV2(out).dirty).toBe(true);
  });

  it("does not read a rename's original path as a header", () => {
    const out = records(
      `# branch.oid ${OID}`,
      "# branch.head main",
      `2 R. N... 100644 100644 100644 ${OID} ${OID} R100 new.ts`,
      "# branch.head attacker",
    );
    expect(parseStatusPorcelainV2(out)).toMatchObject({ branch: "main", dirty: true });
  });

  it("returns branch data as text only", () => {
    const out = records(`# branch.oid ${OID}`, "# branch.head $(touch PWNED)");
    expect(parseStatusPorcelainV2(out).branch).toBe("$(touch PWNED)");
  });

  it("returns a no-branch, clean summary for empty output", () => {
    expect(parseStatusPorcelainV2("")).toEqual({
      branch: null,
      detached: false,
      unborn: false,
      dirty: false,
    });
  });
});

describe("parseLogRecords (log -z --format=%h%x1f%ct%x1f%s)", () => {
  const log = (hash: string, ct: string, subject: string) => `${hash}${US}${ct}${US}${subject}`;

  it("parses hash, ISO commit time and subject", () => {
    const out = records(log("a1b2c3d", "1700000000", "Fix the thing"));
    expect(parseLogRecords(out)).toEqual([
      { hash: "a1b2c3d", committedAt: "2023-11-14T22:13:20.000Z", subject: "Fix the thing" },
    ]);
  });

  it("returns exactly hash, committedAt and subject: no author field (RR-08)", () => {
    const sample = records(log("a1b2c3d", "1700000000", "Subject"));
    expect(Object.keys(parseLogRecords(sample)[0] ?? {}).sort()).toEqual([
      "committedAt",
      "hash",
      "subject",
    ]);
  });

  it("caps the result at five commits", () => {
    const out = records(
      ...Array.from({ length: 8 }, (_, i) => log(`abcdef${i}`, String(1700000000 + i), `c${i}`)),
    );
    const parsed = parseLogRecords(out);
    expect(parsed).toHaveLength(5);
    expect(parsed.map((c) => c.subject)).toEqual(["c0", "c1", "c2", "c3", "c4"]);
  });

  it("keeps a subject containing a newline, a separator or markup as text", () => {
    const out = records(
      log("a1b2c3d", "1700000000", "line one\nline two"),
      log("b1b2c3d", "1700000001", `has${US}separator`),
      log("c1b2c3d", "1700000002", "<img src=x onerror=alert(1)>"),
    );
    expect(parseLogRecords(out).map((c) => c.subject)).toEqual([
      "line one\nline two",
      `has${US}separator`,
      "<img src=x onerror=alert(1)>",
    ]);
  });

  it("skips malformed records", () => {
    const out = records(
      "no separators at all",
      log("not-a-hash", "1700000000", "bad hash"),
      log("a1b2c3d", "yesterday", "bad time"),
      `a1b2c3d${US}1700000000`,
      log("d1b2c3d", "1700000003", "good"),
    );
    expect(parseLogRecords(out)).toEqual([
      { hash: "d1b2c3d", committedAt: "2023-11-14T22:13:23.000Z", subject: "good" },
    ]);
  });

  it("returns an empty list for empty output (unborn branch)", () => {
    expect(parseLogRecords("")).toEqual([]);
  });
});

describe("parseRemoteLines and selectRemote", () => {
  const lines = (...entries: string[]) => `${entries.join("\n")}\n`;

  it("keeps only (fetch) lines and normalises each URL immediately", () => {
    const out = lines(
      `origin\tgit${AT}github.com:owner/repo.git (fetch)`,
      `origin\tgit${AT}github.com:owner/repo.git (push)`,
      "upstream\thttps://gitlab.com/group/repo.git (fetch)",
      "upstream\thttps://gitlab.com/group/repo.git (push)",
    );
    expect(parseRemoteLines(out)).toEqual([
      { name: "origin", remote: { kind: "github", owner: "owner", repo: "repo" } },
      { name: "upstream", remote: { kind: "other", host: "gitlab.com", path: "group/repo" } },
    ]);
  });

  it("never returns the raw URL, so userinfo cannot leak", () => {
    const out = lines(`origin\thttps://user:secret-token${AT}github.com/owner/repo.git (fetch)`);
    const serialised = JSON.stringify(parseRemoteLines(out));
    expect(serialised).not.toContain("secret-token");
    expect(serialised).not.toContain("https://");
  });

  it("prefers origin", () => {
    const remotes = parseRemoteLines(
      lines(
        "fork\thttps://github.com/me/repo.git (fetch)",
        "origin\thttps://gitlab.com/group/repo.git (fetch)",
      ),
    );
    expect(selectRemote(remotes)?.name).toBe("origin");
  });

  it("otherwise prefers the first GitHub remote", () => {
    const remotes = parseRemoteLines(
      lines(
        "mirror\thttps://gitlab.com/group/repo.git (fetch)",
        "fork\thttps://github.com/me/repo.git (fetch)",
        "other\thttps://github.com/them/repo.git (fetch)",
      ),
    );
    expect(selectRemote(remotes)?.name).toBe("fork");
  });

  it("otherwise takes the first remote, and null when there is none", () => {
    const remotes = parseRemoteLines(
      lines(
        "mirror\thttps://gitlab.com/group/repo.git (fetch)",
        "backup\thttps://example.org/repo.git (fetch)",
      ),
    );
    expect(selectRemote(remotes)?.name).toBe("mirror");
    expect(selectRemote([])).toBeNull();
    expect(parseRemoteLines("")).toEqual([]);
  });
});

describe("git config preflight (D-09, PR-05)", () => {
  it("parses a scope line into scope, name and value", () => {
    expect(parseConfigScopeLines("local\tfilter.x.clean some-cmd\n")).toEqual([
      { scope: "local", name: "filter.x.clean", value: "some-cmd" },
    ]);
  });

  it("parses a name-only line with a null value", () => {
    expect(parseConfigScopeLines("worktree\tcore.fsmonitor\n")).toEqual([
      { scope: "worktree", name: "core.fsmonitor", value: null },
    ]);
  });

  it("parses -z output (scope NUL key LF value NUL), where a value cannot forge a second entry", () => {
    const out = [
      "local",
      "filter.lfs.clean\ngit-lfs clean -- %f",
      "local",
      "filter.x.clean\na\nglobal\tfilter.y.clean b",
      "",
    ].join(NUL);
    const entries = parseConfigScopeLines(out);
    expect(entries).toEqual([
      { scope: "local", name: "filter.lfs.clean", value: "git-lfs clean -- %f" },
      { scope: "local", name: "filter.x.clean", value: "a\nglobal\tfilter.y.clean b" },
    ]);
    expect(hasLocalExecutableConfig(entries)).toBe(true);
  });

  const entry = (scope: string, name: string, value: string | null = "cmd"): ConfigScopeEntry => ({
    scope,
    name,
    value,
  });

  const executableKeys = [
    "filter.x.clean",
    "filter.x.smudge",
    "filter.x.process",
    "diff.x.command",
    "diff.x.textconv",
    "diff.external",
    "merge.x.driver",
    "core.fsmonitor",
    "core.sshcommand",
    "core.gitproxy",
    "core.askpass",
    "core.editor",
    "core.pager",
    "core.alternaterefscommand",
    "gpg.program",
    "gpg.ssh.program",
    "sequence.editor",
  ];

  it.each(executableKeys)("flags %s at local and worktree scope", (key) => {
    expect(hasLocalExecutableConfig([entry("local", key)])).toBe(true);
    expect(hasLocalExecutableConfig([entry("worktree", key)])).toBe(true);
  });

  it.each(executableKeys)("does not flag %s at global, system or command scope", (key) => {
    for (const scope of ["global", "system", "command"]) {
      expect(hasLocalExecutableConfig([entry(scope, key)])).toBe(false);
    }
  });

  it("matches keys case-insensitively", () => {
    expect(hasLocalExecutableConfig([entry("local", "core.fsMonitor")])).toBe(true);
    expect(hasLocalExecutableConfig([entry("local", "Core.SSHCommand")])).toBe(true);
    expect(hasLocalExecutableConfig([entry("local", "GPG.Program")])).toBe(true);
    expect(LOCAL_EXEC_KEY_REGEX.test("SEQUENCE.EDITOR")).toBe(true);
  });

  it("allows only the canonical git-lfs filter values", () => {
    expect(
      hasLocalExecutableConfig([
        entry("local", "filter.lfs.clean", "git-lfs clean -- %f"),
        entry("local", "filter.lfs.smudge", "git-lfs smudge -- %f"),
        entry("local", "filter.lfs.process", "git-lfs filter-process"),
      ]),
    ).toBe(false);
    for (const [name, value] of [
      ["filter.lfs.clean", "git-lfs clean -- %f; touch PWNED"],
      ["filter.lfs.smudge", "/tmp/evil smudge -- %f"],
      ["filter.lfs.process", "git-lfs filter-process\ntouch PWNED"],
      ["filter.lfs.clean", null],
      ["filter.notlfs.clean", "git-lfs clean -- %f"],
    ] as const) {
      expect(hasLocalExecutableConfig([entry("local", name, value)])).toBe(true);
    }
  });

  it("treats an unknown scope as untrusted", () => {
    expect(hasLocalExecutableConfig([entry("unknown", "core.fsmonitor")])).toBe(true);
  });

  it("does not flag unrelated local keys", () => {
    expect(
      hasLocalExecutableConfig([
        entry("local", "core.bare", "false"),
        entry("local", "remote.origin.url", "x"),
        entry("local", "filter.lfs.required", "true"),
        entry("local", "user.name", "x"),
      ]),
    ).toBe(false);
  });

  it("exposes the preflight pattern as a string for git config --get-regexp", () => {
    expect(typeof LOCAL_EXEC_KEY_PATTERN).toBe("string");
    expect(LOCAL_EXEC_KEY_PATTERN.startsWith("^")).toBe(true);
    expect(LOCAL_EXEC_KEY_PATTERN.endsWith("$")).toBe(true);
    for (const key of executableKeys)
      expect(new RegExp(LOCAL_EXEC_KEY_PATTERN).test(key)).toBe(true);
    expect(new RegExp(LOCAL_EXEC_KEY_PATTERN).test("core.bare")).toBe(false);
  });
});
