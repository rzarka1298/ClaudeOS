import { symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakeCodexHome,
  exerciseCodexHomePort,
  type FakeCodexHome,
  isAllowedCodexAccess,
  recordingFs,
} from "../test-support/fake-codex-home.js";
import {
  type CodexFs,
  CodexHomeAccessError,
  createCodexHomePort,
  defaultCodexFs,
  resolveCodexHome,
} from "./codex-home.js";

const DAY = "2026-10-06";
const ROLLOUT_NAME = "rollout-2026-10-06T10-00-00-aaaa.jsonl";
const ROLLOUT_BODY = "line-one\nline-two\n";
const INDEX_BODY = '{"id":"synthetic-1"}\n';
/** Built, not escaped: keeps this file pure ASCII while the byte is a real NUL. */
const NUL_BYTE = String.fromCharCode(0);

let home: FakeCodexHome | undefined;

afterEach(() => {
  home?.cleanup();
  home = undefined;
});

function makeHome(options: Parameters<typeof createFakeCodexHome>[0] = {}): FakeCodexHome {
  home = createFakeCodexHome({
    rollouts: [{ day: DAY, name: ROLLOUT_NAME, content: ROLLOUT_BODY }],
    archivedRollouts: [{ day: DAY, name: "rollout-x.jsonl", content: "archived\n" }],
    sessionIndex: INDEX_BODY,
    hooksJson: "{}",
    version: '{"latest_version":"0.0.0"}',
    withDecoys: true,
    ...options,
  });
  return home;
}

describe("Test 1 (tracer): the port reads allowlisted files and rollouts only", () => {
  it("reads session_index.jsonl, lists the dated rollout and reads a byte range", () => {
    const fake = makeHome();
    const rec = recordingFs();
    const port = createCodexHomePort({ root: fake.root, fs: rec.fs });

    const index = port.readNamed("session_index.jsonl", 1024);
    expect(index?.bytes.toString("utf8")).toBe(INDEX_BODY);
    expect(index?.size).toBe(INDEX_BODY.length);

    const day = Date.UTC(2026, 9, 6, 12);
    const listed = port.listRolloutFiles({ from: day, to: day });
    expect(listed.map((ref) => ref.path)).toEqual([fake.rolloutPath(DAY, ROLLOUT_NAME)]);

    const first = listed[0];
    if (first === undefined) throw new Error("no rollout listed");
    const chunk = port.readRolloutRange(first, 0, 8);
    expect(chunk.bytes.toString("utf8")).toBe("line-one");
    expect(chunk.size).toBe(ROLLOUT_BODY.length);
    const tail = port.readRolloutRange(first, 9, 1000);
    expect(tail.bytes.toString("utf8")).toBe("line-two\n");

    expect(rec.calls.length).toBeGreaterThan(0);
    for (const call of rec.calls) {
      expect(isAllowedCodexAccess(call.path, fake.root)).toBe(true);
    }
  });

  it("returns null for a missing allowlisted file and no path for a missing database", () => {
    const fake = makeHome({ hooksJson: undefined });
    const port = createCodexHomePort({ root: fake.root });
    expect(port.readNamed("hooks.json", 100)).toBeNull();
    expect(port.stateDbPath()).toBeNull();
  });

  it("bounds a named read to the requested size", () => {
    const fake = makeHome();
    const port = createCodexHomePort({ root: fake.root });
    const read = port.readNamed("session_index.jsonl", 5);
    expect(read?.bytes.length).toBe(5);
    expect(read?.size).toBe(INDEX_BODY.length);
  });

  it("stat-s a rollout and treats a missing one as null", () => {
    const fake = makeHome();
    const port = createCodexHomePort({ root: fake.root });
    const stat = port.statRollout({ path: fake.rolloutPath(DAY, ROLLOUT_NAME) });
    expect(stat?.size).toBe(ROLLOUT_BODY.length);
    expect(typeof stat?.mtimeMs).toBe("number");
    expect(port.statRollout({ path: fake.rolloutPath(DAY, "rollout-missing.jsonl") })).toBeNull();
  });

  it("resolves a contained sessions file and answers null for anything else", () => {
    const fake = makeHome();
    const port = createCodexHomePort({ root: fake.root });
    const target = fake.rolloutPath(DAY, ROLLOUT_NAME);
    expect(port.resolveSessionsFile(target)).toBe(target);
    expect(port.resolveSessionsFile(fake.decoys.credentialPath)).toBeNull();
    expect(port.resolveSessionsFile(fake.rolloutPath(DAY, "rollout-missing.jsonl"))).toBeNull();
  });
});

describe("Test 2: readNamed refuses every name outside the allowlist before any file call", () => {
  it("throws CodexHomeAccessError with no file-system call at all", () => {
    const fake = makeHome();
    const hostile: unknown[] = [
      fake.decoys.credentialName,
      fake.decoys.configName,
      ...fake.decoys.lookalikeNames,
      "../session_index.jsonl",
      "sessions/../session_index.jsonl",
      "a/b",
      ".",
      "..",
      "",
      "SESSION_INDEX.JSONL",
      "Session_Index.jsonl",
      "session_index.jsonl ",
      " session_index.jsonl",
      `session_index.jsonl${NUL_BYTE}`,
      `${NUL_BYTE}`,
      "state_5.sqlite",
      "state_5.sqlite-wal",
      undefined,
      null,
      5,
      {},
    ];
    for (const name of hostile) {
      const rec = recordingFs();
      const port = createCodexHomePort({ root: fake.root, fs: rec.fs });
      expect(() => port.readNamed(name as string, 100)).toThrow(CodexHomeAccessError);
      expect(rec.calls).toEqual([]);
    }
  });

  it("never puts the offending value in the error message", () => {
    const fake = makeHome();
    const port = createCodexHomePort({ root: fake.root });
    let message = "";
    try {
      port.readNamed(fake.decoys.credentialName, 100);
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(fake.decoys.credentialName);
    expect(message).not.toContain(fake.root);
  });

  it("refuses an allowlisted name that is a symlink to a different file", () => {
    const fake = makeHome();
    const versionPath = join(fake.root, "version.json");
    unlinkSync(versionPath);
    symlinkSync(fake.decoys.credentialPath, versionPath);
    const rec = recordingFs();
    const port = createCodexHomePort({ root: fake.root, fs: rec.fs });
    expect(() => port.readNamed("version.json", 100)).toThrow(CodexHomeAccessError);
    expect(rec.calls.filter((call) => call.op === "readBytes")).toEqual([]);
    expect(rec.calls.some((call) => call.path === fake.decoys.credentialPath)).toBe(false);
  });
});

describe("Test 3: rollout paths are contained, dated, named and not archived", () => {
  it("refuses outside, archived, wrongly named, traversal and malformed paths before any read", () => {
    const fake = makeHome();
    const refused: string[] = [
      join(fake.root, "rollout-x.jsonl"),
      join(fake.root, "archived_sessions", "2026", "10", "06", "rollout-x.jsonl"),
      fake.rolloutPath(DAY, "notes.txt"),
      fake.rolloutPath(DAY, "rollout-a.json"),
      fake.rolloutPath(DAY, "rollout-.jsonl"),
      fake.rolloutPath(DAY, "rollout-a b.jsonl"),
      join(fake.root, "sessions", "2026", "rollout-x.jsonl"),
      join(fake.root, "sessions", "rollout-x.jsonl"),
      join(fake.root, "sessions", "2026", "10", "6", "rollout-x.jsonl"),
      `${fake.root}/sessions/2026/10/06/../06/${ROLLOUT_NAME}`,
      `${fake.root}/sessions/2026/10/06/../../../../${fake.decoys.credentialName}`,
      fake.decoys.credentialPath,
      fake.decoys.configPath,
      "rollout-relative.jsonl",
      "",
      `${fake.rolloutPath(DAY, ROLLOUT_NAME)}${NUL_BYTE}`,
      `${fake.root}-sibling/sessions/2026/10/06/${ROLLOUT_NAME}`,
    ];
    for (const path of refused) {
      const rec = recordingFs();
      const port = createCodexHomePort({ root: fake.root, fs: rec.fs });
      expect(() => port.readRolloutRange({ path }, 0, 100)).toThrow(CodexHomeAccessError);
      expect(() => port.statRollout({ path })).toThrow(CodexHomeAccessError);
      expect(rec.calls).toEqual([]);
      expect(port.resolveSessionsFile(path)).toBeNull();
      expect(rec.calls).toEqual([]);
    }
  });

  it("refuses a symlink inside sessions that points at the decoy credential file", () => {
    const fake = makeHome({ escapeSymlink: true });
    const rec = recordingFs();
    const port = createCodexHomePort({ root: fake.root, fs: rec.fs });
    expect(() => port.readRolloutRange({ path: fake.escapeSymlinkPath }, 0, 100)).toThrow(
      CodexHomeAccessError,
    );
    expect(() => port.statRollout({ path: fake.escapeSymlinkPath })).toThrow(CodexHomeAccessError);
    expect(port.resolveSessionsFile(fake.escapeSymlinkPath)).toBeNull();
    expect(rec.calls.filter((call) => call.op === "readBytes")).toEqual([]);
    expect(rec.calls.filter((call) => call.op === "stat")).toEqual([]);
    expect(rec.calls.some((call) => call.path === fake.decoys.credentialPath)).toBe(false);
  });

  it("does not list the escape symlink as a rollout", () => {
    const fake = makeHome({ escapeSymlink: true });
    const port = createCodexHomePort({ root: fake.root });
    const day = Date.UTC(2026, 9, 6, 12);
    const listed = port.listRolloutFiles({ from: day, to: day }).map((ref) => ref.path);
    expect(listed).not.toContain(fake.escapeSymlinkPath);
    expect(listed).toContain(fake.rolloutPath(DAY, ROLLOUT_NAME));
  });

  it("never lists the archived folder", () => {
    const fake = makeHome();
    const port = createCodexHomePort({ root: fake.root });
    const day = Date.UTC(2026, 9, 6, 12);
    const listed = port.listRolloutFiles({ from: day, to: day }).map((ref) => ref.path);
    expect(listed.every((path) => !path.includes("archived_sessions"))).toBe(true);
  });

  it("walks only dated folders in range and answers empty for a missing root", () => {
    const fake = makeHome({
      rollouts: [
        { day: "2026-10-06", name: ROLLOUT_NAME },
        { day: "2026-09-01", name: "rollout-old.jsonl" },
      ],
    });
    const rec = recordingFs();
    const port = createCodexHomePort({ root: fake.root, fs: rec.fs });
    const day = Date.UTC(2026, 9, 6, 12);
    const listed = port.listRolloutFiles({ from: day, to: day }).map((ref) => ref.path);
    expect(listed).toEqual([fake.rolloutPath(DAY, ROLLOUT_NAME)]);
    expect(rec.calls.some((call) => call.path.includes("/2026/09/"))).toBe(false);

    const gone = createCodexHomePort({ root: join(fake.root, "does-not-exist") });
    expect(gone.listRolloutFiles({ from: day, to: day })).toEqual([]);
    expect(gone.stateDbPath()).toBeNull();
  });

  it("rejects non-integer or negative offsets and non-positive sizes", () => {
    const fake = makeHome();
    const port = createCodexHomePort({ root: fake.root });
    const ref = { path: fake.rolloutPath(DAY, ROLLOUT_NAME) };
    expect(() => port.readRolloutRange(ref, -1, 10)).toThrow(CodexHomeAccessError);
    expect(() => port.readRolloutRange(ref, 1.5, 10)).toThrow(CodexHomeAccessError);
    expect(() => port.readRolloutRange(ref, 0, 0)).toThrow(CodexHomeAccessError);
  });

  it("caps a single read at the named maximum", () => {
    const big = "x".repeat(2 * 1024 * 1024);
    const fake = makeHome({ rollouts: [{ day: DAY, name: ROLLOUT_NAME, content: big }] });
    const port = createCodexHomePort({ root: fake.root });
    const read = port.readRolloutRange({ path: fake.rolloutPath(DAY, ROLLOUT_NAME) }, 0, 10 ** 9);
    expect(read.bytes.length).toBeLessThanOrEqual(1024 * 1024);
    expect(read.size).toBe(big.length);
  });
});

describe("Test 4: resolveCodexHome precedence", () => {
  const homeDir = "/Users/USERNAME";
  it("prefers CCC_CODEX_HOME, then CODEX_HOME, then the default", () => {
    expect(resolveCodexHome({ CCC_CODEX_HOME: "/tmp/a", CODEX_HOME: "/tmp/b" }, homeDir)).toBe(
      "/tmp/a",
    );
    expect(resolveCodexHome({ CODEX_HOME: "/tmp/b" }, homeDir)).toBe("/tmp/b");
    expect(resolveCodexHome({}, homeDir)).toBe(join(homeDir, ".codex"));
  });

  it("ignores a relative or empty value in either variable", () => {
    expect(resolveCodexHome({ CCC_CODEX_HOME: "rel/dir", CODEX_HOME: "/tmp/b" }, homeDir)).toBe(
      "/tmp/b",
    );
    expect(resolveCodexHome({ CCC_CODEX_HOME: "", CODEX_HOME: "also/rel" }, homeDir)).toBe(
      join(homeDir, ".codex"),
    );
    expect(resolveCodexHome({ CCC_CODEX_HOME: undefined }, homeDir)).toBe(join(homeDir, ".codex"));
  });
});

describe("Test 5: the port has no write-capable member", () => {
  it("exposes no member named like a mutation", () => {
    const fake = makeHome();
    const port = createCodexHomePort({ root: fake.root });
    // A plain object: no class prototype can hide a member.
    expect(Object.getPrototypeOf(port)).toBe(Object.prototype);
    const names = Object.getOwnPropertyNames(port);
    expect(names.length).toBeGreaterThan(0);
    const mutation =
      /write|create|delete|remove|rename|unlink|chmod|mkdir|append|truncate|copy|link|move|rm$/i;
    for (const name of names) {
      // "resolveSessionsFile" and the read members are the whole surface.
      expect(name, name).not.toMatch(mutation);
    }
    expect(names.sort()).toEqual(
      [
        "listRolloutFiles",
        "readNamed",
        "readRolloutRange",
        "resolveSessionsFile",
        "stateDbPath",
        "statRollout",
      ].sort(),
    );
  });

  it("makes no mutating call when handed a file system that offers them", () => {
    const fake = makeHome({ escapeSymlink: true });
    const writers = [
      "writeFile",
      "writeFileSync",
      "appendFile",
      "unlink",
      "unlinkSync",
      "rm",
      "rmSync",
      "mkdir",
      "mkdirSync",
      "rename",
      "renameSync",
      "chmod",
      "chmodSync",
      "symlink",
      "truncate",
      "open",
      "openSync",
    ];
    const spies = Object.fromEntries(writers.map((name) => [name, vi.fn()]));
    const fs = { ...defaultCodexFs, ...spies } as unknown as CodexFs;
    const port = createCodexHomePort({ root: fake.root, fs });
    exerciseCodexHomePort(port, fake);
    for (const name of writers) {
      expect(spies[name], name).not.toHaveBeenCalled();
    }
  });
});

describe("the real default home is refused under a test runner", () => {
  it("throws before any file call when the root is the owner's real Codex home", () => {
    const rec = recordingFs();
    const real = join(homedir(), ".codex");
    expect(() => createCodexHomePort({ root: real, fs: rec.fs })).toThrow(CodexHomeAccessError);
    expect(rec.calls).toEqual([]);
  });
});
