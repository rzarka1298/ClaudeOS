import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import {
  applyMigrations,
  getSessionOverride,
  type OperationalStore,
  openStore,
  setSessionOverride,
} from "@ccc/operational-store";
import pino, { type Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AttributionDeps, attributeCwd } from "./attribution.js";
import { runGit } from "./git-readonly.js";
import type { SessionFactsProvider } from "./pipeline.js";
import { createSessionFactsProvider } from "./process-facts.js";
import { createStoreProjectLookup } from "./project-lookup.js";

let base: string;
let store: OperationalStore;
let logLines: string[];
let logger: Logger;

/** Test seeding only: product code never writes `projects` (D-57). */
function registerProject(projectId: string, root: string): void {
  mkdirSync(root, { recursive: true });
  store.db
    .prepare(
      "INSERT INTO projects (project_id, path, workspace_id, display_name, registered_at) VALUES (?, ?, NULL, ?, ?)",
    )
    .run(projectId, root, projectId, "2026-09-29T00:00:00.000Z");
}

function deps(overrides: Partial<AttributionDeps> = {}): AttributionDeps {
  return {
    lookup: createStoreProjectLookup(store.db),
    getOverride: (claudeSessionId) => getSessionOverride(store.db, claudeSessionId),
    realpath,
    runGit,
    logger,
    ...overrides,
  };
}

/** The test's own git, outside the service code, with no owner config. */
function testGit(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: base,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  });
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "ccc-attr-")));
  store = openStore(join(base, "operational.db"));
  applyMigrations(store.db);
  logLines = [];
  logger = pino(
    { level: "debug" },
    new Writable({
      write(chunk, _encoding, callback) {
        logLines.push(String(chunk));
        callback();
      },
    }),
  );
});

afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

describe("attribution to registered project roots (Test 3, SESS-07, D-23)", () => {
  beforeEach(() => {
    registerProject("alpha", join(base, "x", "alpha"));
    registerProject("beta", join(base, "x", "beta"));
    registerProject("gamma", join(base, "x", "alpha", "nested"));
    mkdirSync(join(base, "x", "alpha", "src"), { recursive: true });
    mkdirSync(join(base, "x", "beta", "lib", "deep"), { recursive: true });
    mkdirSync(join(base, "x", "alpha", "nested", "deep"), { recursive: true });
    mkdirSync(join(base, "x", "alpha-2"), { recursive: true });
    mkdirSync(join(base, "elsewhere"), { recursive: true });
  });

  it("a cwd under alpha resolves to alpha and a cwd under beta to beta", async () => {
    const a = await attributeCwd(
      { cwd: join(base, "x", "alpha", "src"), claudeSessionId: "s1" },
      deps(),
    );
    const b = await attributeCwd(
      { cwd: join(base, "x", "beta", "lib", "deep"), claudeSessionId: "s2" },
      deps(),
    );
    expect(a).toMatchObject({ projectId: "alpha", reason: "project-root" });
    expect(b).toMatchObject({ projectId: "beta", reason: "project-root" });
  });

  it("the project root itself resolves to its project (is-root case)", async () => {
    const at = await attributeCwd({ cwd: join(base, "x", "beta"), claudeSessionId: null }, deps());
    expect(at.projectId).toBe("beta");
  });

  it("the longest registered prefix wins for nested roots", async () => {
    const at = await attributeCwd(
      { cwd: join(base, "x", "alpha", "nested", "deep"), claudeSessionId: null },
      deps(),
    );
    expect(at.projectId).toBe("gamma");
  });

  it("a sibling sharing a string prefix and a cwd elsewhere stay unclassified", async () => {
    const sibling = await attributeCwd(
      { cwd: join(base, "x", "alpha-2"), claudeSessionId: null },
      deps(),
    );
    const elsewhere = await attributeCwd(
      { cwd: join(base, "elsewhere"), claudeSessionId: null },
      deps(),
    );
    expect(sibling).toEqual({ projectId: null, worktreeRoot: null, reason: "no-match" });
    expect(elsewhere).toEqual({ projectId: null, worktreeRoot: null, reason: "no-match" });
  });

  it("a Run with no cwd is unclassified without touching the filesystem", async () => {
    const at = await attributeCwd(
      { cwd: null, claudeSessionId: null },
      deps({
        realpath: async () => {
          throw new Error("must not be called");
        },
      }),
    );
    expect(at).toEqual({ projectId: null, worktreeRoot: null, reason: "no-cwd" });
  });
});

describe("linked worktrees resolve to their main project (Test 4, D-23)", () => {
  it("a cwd inside a linked worktree outside the root maps to the main project", async () => {
    const repo = join(base, "code", "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    testGit(repo, "init", "-q");
    testGit(repo, "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init");
    const worktree = join(base, "trees", "feature");
    testGit(repo, "worktree", "add", "-q", "-b", "feature", worktree);
    mkdirSync(join(worktree, "pkg"), { recursive: true });
    registerProject("repo", repo);

    const inWorktree = await attributeCwd(
      { cwd: join(worktree, "pkg"), claudeSessionId: null },
      deps(),
    );
    expect(inWorktree).toEqual({
      projectId: "repo",
      worktreeRoot: realpathSync(worktree),
      reason: "linked-worktree",
    });

    const inMain = await attributeCwd({ cwd: join(repo, "src"), claudeSessionId: null }, deps());
    expect(inMain).toEqual({ projectId: "repo", worktreeRoot: repo, reason: "project-root" });
  });
});

describe("a manual override wins (Test 5, D-24, SESS-17)", () => {
  it("maps session S to beta even though its cwd lies under alpha", async () => {
    registerProject("alpha", join(base, "x", "alpha"));
    registerProject("beta", join(base, "x", "beta"));
    setSessionOverride(store.db, "S", "beta", "2026-09-29T00:00:00.000Z");
    const at = await attributeCwd({ cwd: join(base, "x", "alpha"), claudeSessionId: "S" }, deps());
    expect(at).toMatchObject({ projectId: "beta", reason: "override" });
    const other = await attributeCwd(
      { cwd: join(base, "x", "alpha"), claudeSessionId: "T" },
      deps(),
    );
    expect(other.projectId).toBe("alpha");
  });
});

describe("failures degrade to unclassified and never crash (Test 6, Pitfall 16, T-05-48)", () => {
  it("a realpath EPERM (TCC) is unclassified with folder-access-denied logged without the path", async () => {
    registerProject("alpha", join(base, "x", "alpha"));
    const secret = join(base, "x", "alpha", "Documents-like");
    const at = await attributeCwd(
      { cwd: secret, claudeSessionId: "sess-eperm" },
      deps({
        realpath: async () => {
          throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
        },
      }),
    );
    expect(at).toEqual({ projectId: null, worktreeRoot: null, reason: "folder-access-denied" });
    const logged = logLines.join("");
    expect(logged).toContain("folder-access-denied");
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain(base);
  });

  it("a missing cwd is unclassified with folder-missing", async () => {
    const at = await attributeCwd(
      { cwd: join(base, "gone", "away"), claudeSessionId: null },
      deps(),
    );
    expect(at).toEqual({ projectId: null, worktreeRoot: null, reason: "folder-missing" });
  });

  it("a failing git is no match rather than a throw", async () => {
    mkdirSync(join(base, "plain"), { recursive: true });
    const at = await attributeCwd(
      { cwd: join(base, "plain"), claudeSessionId: null },
      deps({
        runGit: async () => {
          throw Object.assign(new Error("spawn EPERM"), { code: "EPERM" });
        },
      }),
    );
    expect(at).toEqual({ projectId: null, worktreeRoot: null, reason: "no-match" });
  });
});

describe("attribution only reads (Test 7, SESS-17, D-57)", () => {
  it.each(["attribution.ts", "project-lookup.ts"])(
    "%s holds no INSERT, UPDATE or DELETE and no vault-repo import",
    (file) => {
      const text = readFileSync(join(import.meta.dirname, file), "utf8");
      expect(text).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
      expect(text).not.toMatch(/@ccc\/vault-repo/);
      expect(text).not.toMatch(/\b(setSessionOverride|upsertSessionRun)\b/);
    },
  );
});

describe("the session facts provider carries the attribution (05-08 hand-off, SESS-07)", () => {
  const processFacts = {
    isAlive: () => false,
    readStartTimes: async () => new Map<number, string>(),
    readTty: async () => null,
    readAncestry: async () => [],
  };

  function recordOf(event: string, cwd: string): Parameters<SessionFactsProvider["factsFor"]>[0] {
    return {
      eventId: "e",
      observedAt: "2026-09-29T00:00:00.000Z",
      hook_event_name: event,
      session_id: "sess-facts",
      cwd,
      ...(event === "SessionStart" ? { source: "startup" } : {}),
    } as Parameters<SessionFactsProvider["factsFor"]>[0];
  }

  it("attributes at SessionStart and reuses it for later records of the same cwd", async () => {
    let calls = 0;
    const facts = createSessionFactsProvider({
      processFacts,
      claudeProjectsRoot: base,
      logger,
      attribute: async () => {
        calls += 1;
        return { projectId: "alpha", worktreeRoot: "/w", reason: "project-root" };
      },
    });
    const start = await facts.factsFor(recordOf("SessionStart", "/c"));
    const later = await facts.factsFor(recordOf("UserPromptSubmit", "/c"));
    expect(start).toMatchObject({ projectId: "alpha", worktreeRoot: "/w" });
    expect(later).toMatchObject({ projectId: "alpha", worktreeRoot: "/w" });
    expect(calls).toBe(1);
  });

  it("an attribution that throws reads as unknown, never a failed ingest", async () => {
    const facts = createSessionFactsProvider({
      processFacts,
      claudeProjectsRoot: base,
      logger,
      attribute: async () => {
        throw Object.assign(new Error("boom"), { code: "EPERM" });
      },
    });
    await expect(facts.factsFor(recordOf("SessionStart", "/c"))).resolves.toMatchObject({
      projectId: null,
      worktreeRoot: null,
    });
  });
});
