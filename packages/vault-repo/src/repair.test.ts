// VAULT-04 proven rather than asserted.
//
// The claim repair makes is unusually strong and unusually easy to break:
// "rebuilds every derived artifact from ground truth WITHOUT touching a
// single note body". Two of these tests are the ones that actually hold it
// to that:
//
//   1. Byte invariance — every non-index file in the whole tree is hashed
//      before and after, and compared per file. An assertion listing the
//      files a test author happened to think of would miss exactly the
//      write nobody anticipated.
//   2. Determinism — the same corrupted tree repaired twice produces
//      deep-equal reports, so a caller can diff two runs and learn
//      something about the vault rather than about readdir order.
//
// Like `setup.test.ts` and `index-generation.test.ts`, these use a local
// ephemeral vault under `~/.ccc-test` rather than `@ccc/test-fixtures`'
// `withTempVaultDir`: `@ccc/vault-repo` sits BELOW test-fixtures in the
// import-boundary map. The committed `examples/vault/` fixture is never a
// target here.
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import {
  globalScope,
  type NoteFrontmatter,
  TaskFrontmatterSchema,
  workspaceScope,
} from "@ccc/domain";
import matter from "gray-matter";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { stringifyNote } from "./frontmatter.js";
import { repairVault } from "./repair.js";
import { createWorkspace, initializeVault } from "./setup.js";
import { stringifyTaskNote } from "./task-note.js";
import { writeNote } from "./write-note.js";

const TEST_BASE = join(homedir(), ".ccc-test");

let vaultRoot: string;

beforeEach(() => {
  mkdirSync(TEST_BASE, { recursive: true });
  vaultRoot = mkdtempSync(join(TEST_BASE, "vrepair-"));
  initializeVault(vaultRoot);
});

afterEach(() => {
  rmSync(vaultRoot, { recursive: true, force: true });
});

/** Vault-relative, POSIX-separated — the form the report speaks in. */
function rel(absolutePath: string): string {
  return relative(vaultRoot, absolutePath).split(sep).join("/");
}

/**
 * sha256 of every file in the vault EXCEPT `index.md`, keyed by
 * vault-relative path. This is the instrument for the byte-invariance
 * claim: repair may rewrite indexes and nothing else, so everything this
 * map holds must survive a repair unchanged.
 */
function hashNonIndexFiles(root: string): Map<string, string> {
  const hashes = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const absolute = join(dir, name);
      if (statSync(absolute).isDirectory()) {
        walk(absolute);
        continue;
      }
      if (name === "index.md") continue;
      hashes.set(
        relative(root, absolute).split(sep).join("/"),
        createHash("sha256").update(readFileSync(absolute)).digest("hex"),
      );
    }
  };
  walk(root);
  return hashes;
}

/** One ordinary managed note, written through the real write path. */
function writeManagedNote(
  relativePath: string,
  overrides: { scope?: string; created?: string; body?: string } = {},
): { noteId: string; path: string; frontmatter: NoteFrontmatter } {
  return writeNote({
    vaultRoot,
    relativePath,
    body: overrides.body ?? `# ${relativePath}\n\nbody\n`,
    scope: overrides.scope ?? globalScope(),
    stage: "wiki",
    generatedBy: { skill: "repair-test" },
    aiGenerated: false,
    confidence: "verified",
    ...(overrides.created === undefined ? {} : { created: overrides.created }),
  });
}

describe("repairVault", () => {
  test("rebuilds every managed folder's index while leaving every non-index file byte-identical", () => {
    writeManagedNote("global/wiki/alpha.md");
    writeManagedNote("inbox/beta.md");
    const workspace = createWorkspace(vaultRoot, "Repair 🛠 ワークスペース");
    writeManagedNote(`workspaces/${workspace.workspaceId}/raw/gamma.md`, {
      scope: workspaceScope(workspace.workspaceId),
    });

    // Corrupt the DERIVED layer only: a note the index never saw, a deleted
    // index, and a hand-edited one. Repair must fix all three and touch
    // nothing else.
    const smuggled = join(vaultRoot, "global", "raw", "delta.md");
    writeFileSync(
      smuggled,
      stringifyNote(
        {
          id: "0000000000000000000000001",
          scope: globalScope(),
          stage: "raw",
          created: "2026-01-01T00:00:00.000Z",
          updated: "2026-01-01T00:00:00.000Z",
          generatedBy: { skill: "repair-test" },
          aiGenerated: false,
          sources: [],
          confidence: "unverified",
          lastReviewed: null,
        },
        "# delta\n",
      ),
      "utf8",
    );
    rmSync(join(vaultRoot, "inbox", "index.md"));
    writeFileSync(join(vaultRoot, "daily", "index.md"), "hand-edited garbage\n", "utf8");

    const before = hashNonIndexFiles(vaultRoot);
    expect(before.size).toBeGreaterThan(0);

    repairVault(vaultRoot);

    const after = hashNonIndexFiles(vaultRoot);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [path, hash] of before) {
      expect(`${path}:${after.get(path)}`).toBe(`${path}:${hash}`);
    }

    // And the derived layer really was rebuilt — otherwise the invariance
    // assertion above would pass vacuously.
    expect(existsSync(join(vaultRoot, "inbox", "index.md"))).toBe(true);
    expect(readFileSync(join(vaultRoot, "global", "raw", "index.md"), "utf8")).toContain(
      "0000000000000000000000001",
    );
    expect(readFileSync(join(vaultRoot, "daily", "index.md"), "utf8")).not.toContain("garbage");
  });

  test("returns one record per valid note and no warnings for a healthy vault", () => {
    const alpha = writeManagedNote("global/wiki/alpha.md");
    const beta = writeManagedNote("inbox/beta.md");
    const workspace = createWorkspace(vaultRoot, "Healthy");
    const gamma = writeManagedNote(`workspaces/${workspace.workspaceId}/wiki/gamma.md`, {
      scope: workspaceScope(workspace.workspaceId),
    });

    const report = repairVault(vaultRoot);

    expect(report.warnings).toEqual([]);
    expect(report.notes.map((note) => note.path).sort()).toEqual(
      [rel(alpha.path), rel(beta.path), rel(gamma.path)].sort(),
    );
    const alphaRecord = report.notes.find((note) => note.path === rel(alpha.path));
    expect(alphaRecord?.frontmatter.id).toBe(alpha.noteId);
    expect(alphaRecord?.frontmatter.scope).toBe(globalScope());
  });

  test("flags a duplicated note id with BOTH paths and excludes both copies from the records", () => {
    const original = writeManagedNote("global/wiki/alpha.md");
    const survivor = writeManagedNote("inbox/beta.md");
    const copy = join(vaultRoot, "global", "raw", "alpha-copy.md");
    copyFileSync(original.path, copy);

    const report = repairVault(vaultRoot);

    const duplicates = report.warnings.filter((warning) => warning.kind === "duplicate-id");
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.paths).toEqual([rel(copy), rel(original.path)].sort());
    expect(duplicates[0]?.detail).toContain(original.noteId);

    // Flag, never pick: NEITHER copy is offered as the truth.
    expect(report.notes.map((note) => note.path)).toEqual([rel(survivor.path)]);
  });

  test("flags an id listed in a hand-edited index but absent from disk, and drops it from the regenerated index", () => {
    writeManagedNote("global/wiki/alpha.md");
    const ghostId = "0000000000000000000000ghost";
    const indexPath = join(vaultRoot, "global", "wiki", "index.md");
    writeFileSync(
      indexPath,
      `${readFileSync(indexPath, "utf8")}- [[ghost]] — id \`${ghostId}\` · stage \`wiki\` · updated 2026-01-01T00:00:00.000Z\n`,
      "utf8",
    );

    const report = repairVault(vaultRoot);

    const orphans = report.warnings.filter((warning) => warning.kind === "orphaned-index-entry");
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.paths).toEqual(["global/wiki/index.md"]);
    expect(orphans[0]?.detail).toContain(ghostId);
    expect(readFileSync(indexPath, "utf8")).not.toContain(ghostId);

    // Convergence: regeneration dropped the ghost, so a second run has
    // nothing left to flag. An orphan warning is one-shot BY DESIGN, which
    // is why it is deliberately absent from the determinism case below.
    expect(repairVault(vaultRoot).warnings).toEqual([]);
  });

  test("a listed note that exists but failed to validate is not ALSO reported as an orphan", () => {
    // The file is right there. Reporting "not present anywhere in the
    // vault" for it is a false statement, and it sends the user looking
    // for a deleted note that exists -- repair's whole value is the
    // accuracy of this report.
    const alpha = writeManagedNote("global/wiki/alpha.md");
    const brokenId = "brokenid00000000000000000";
    const broken = join(vaultRoot, "global", "wiki", "broken.md");
    writeFileSync(
      broken,
      `---\nid: ${brokenId}\nscope: global\nstage: not-a-stage\n---\n\n# broken\n`,
      "utf8",
    );
    const indexPath = join(vaultRoot, "global", "wiki", "index.md");
    writeFileSync(
      indexPath,
      `${readFileSync(indexPath, "utf8")}- [[broken]] — id \`${brokenId}\` · stage \`wiki\` · updated 2026-01-01T00:00:00.000Z\n`,
      "utf8",
    );

    const report = repairVault(vaultRoot);

    expect(report.warnings.filter((w) => w.kind === "invalid-frontmatter")).toHaveLength(1);
    expect(report.warnings.filter((w) => w.kind === "orphaned-index-entry")).toEqual([]);
    // Not vacuous: the healthy sibling is still the only returned record,
    // so the broken note really was excluded from the ground truth.
    expect(report.notes.map((note) => note.path)).toEqual([rel(alpha.path)]);
    expect(existsSync(broken)).toBe(true);
  });

  test("flags a note with invalid frontmatter, never rewrites it, and leaves its siblings in the records", () => {
    const sibling = writeManagedNote("global/wiki/alpha.md");
    const broken = join(vaultRoot, "global", "wiki", "broken.md");
    const brokenContent = "---\nid: not-a-valid-note\nstage: nonsense\n---\n\n# broken\n";
    writeFileSync(broken, brokenContent, "utf8");

    const report = repairVault(vaultRoot);

    const invalid = report.warnings.filter((warning) => warning.kind === "invalid-frontmatter");
    expect(invalid).toHaveLength(1);
    expect(invalid[0]?.paths).toEqual(["global/wiki/broken.md"]);
    expect(report.notes.map((note) => note.path)).toEqual([rel(sibling.path)]);
    expect(readFileSync(broken, "utf8")).toBe(brokenContent);
  });

  test("reports zero notes and zero warnings on a vault whose managed folders are all empty", () => {
    const report = repairVault(vaultRoot);

    expect(report.notes).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(readFileSync(join(vaultRoot, "system", "index.md"), "utf8")).toContain(
      "_No notes yet._",
    );
  });

  test("regenerates every deleted index.md", () => {
    writeManagedNote("global/wiki/alpha.md");
    const workspace = createWorkspace(vaultRoot, "Deleted indexes");
    const removed = [
      join(vaultRoot, "global", "wiki", "index.md"),
      join(vaultRoot, "system", "index.md"),
      join(workspace.path, "raw", "index.md"),
    ];
    for (const path of removed) rmSync(path);

    repairVault(vaultRoot);

    for (const path of removed) {
      expect(`${rel(path)}:${existsSync(path)}`).toBe(`${rel(path)}:true`);
    }
  });

  test("does not invent an index.md inside a user's own subfolder, under workspaces/ or global/", () => {
    // The filter used to be `folder.startsWith(workspaces + sep)`, which
    // matches at EVERY depth -- so a folder the user made for their own
    // reasons got a generated file dropped into it, at any nesting. The
    // identical folder under `global/` was correctly left alone, so the two
    // scopes disagreed for no stated reason.
    const workspace = createWorkspace(vaultRoot, "User folders");
    const deep = join(workspace.path, "my-notes", "2026", "drafts");
    mkdirSync(deep, { recursive: true });
    const globalOwn = join(vaultRoot, "global", "my-notes");
    mkdirSync(globalOwn, { recursive: true });

    repairVault(vaultRoot);

    expect(existsSync(join(workspace.path, "my-notes", "index.md"))).toBe(false);
    expect(existsSync(join(workspace.path, "my-notes", "2026", "index.md"))).toBe(false);
    expect(existsSync(join(deep, "index.md"))).toBe(false);
    expect(existsSync(join(globalOwn, "index.md"))).toBe(false);

    // The folders this package DOES own still get one -- otherwise the
    // assertions above would pass by simply never regenerating anything.
    expect(existsSync(join(workspace.path, "index.md"))).toBe(true);
    for (const leaf of ["raw", "wiki", "output", "tasks"]) {
      expect(`${leaf}:${existsSync(join(workspace.path, leaf, "index.md"))}`).toBe(`${leaf}:true`);
    }
  });

  test("a note stashed in a user subfolder is still SCANNED even though it gets no index", () => {
    // Scanning and indexing are deliberately different sets: a duplicate id
    // hidden in a user's folder must still be caught.
    const workspace = createWorkspace(vaultRoot, "Stashed");
    const original = writeManagedNote(`workspaces/${workspace.workspaceId}/wiki/gamma.md`, {
      scope: workspaceScope(workspace.workspaceId),
    });
    const stash = join(workspace.path, "my-notes");
    mkdirSync(stash, { recursive: true });
    copyFileSync(original.path, join(stash, "gamma-copy.md"));

    const report = repairVault(vaultRoot);

    const duplicates = report.warnings.filter((warning) => warning.kind === "duplicate-id");
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.detail).toContain(original.noteId);
    expect(existsSync(join(stash, "index.md"))).toBe(false);
  });

  test("re-emits a workspace's identity keys while rebuilding its listing", () => {
    const displayName = "Repair 🛠 ワークスペース";
    const workspace = createWorkspace(vaultRoot, displayName);
    const gamma = writeManagedNote(`workspaces/${workspace.workspaceId}/wiki/gamma.md`, {
      scope: workspaceScope(workspace.workspaceId),
    });
    // The listing below the identity keys is the part repair rebuilds, so
    // make it stale first — otherwise "rebuilding" is untested.
    rmSync(join(workspace.path, "wiki", "index.md"));

    repairVault(vaultRoot);

    // Asserted through a YAML parse, not a substring: js-yaml escapes
    // astral-plane characters in a double-quoted scalar (the emoji is
    // written `\U0001F6E0`), so a substring match would fail on a perfectly
    // preserved name — and, worse, would pass on a mangled one that happened
    // to contain the same bytes. What the contract promises is that the VALUE
    // round-trips, which is what this reads.
    const identity = matter(readFileSync(join(workspace.path, "index.md"), "utf8")).data;
    expect(identity.workspaceId).toBe(workspace.workspaceId);
    expect(identity.displayName).toBe(displayName);
    expect(readFileSync(join(workspace.path, "wiki", "index.md"), "utf8")).toContain(gamma.noteId);
  });

  test("flags a workspace whose index will not parse instead of erasing its displayName", () => {
    const displayName = "My Research Workspace";
    const workspace = createWorkspace(vaultRoot, displayName);
    const indexPath = join(workspace.path, "index.md");
    const damaged = readFileSync(indexPath, "utf8").replace(
      `displayName: ${displayName}`,
      `displayName: '${displayName}`,
    );
    writeFileSync(indexPath, damaged, "utf8");

    const report = repairVault(vaultRoot);

    const flagged = report.warnings.filter((warning) => warning.kind === "index-not-regenerated");
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.paths).toEqual([rel(workspace.path)]);
    // Not merely reported — left alone. `displayName` is stored in this
    // file and nowhere else, so an overwrite here is unrecoverable.
    expect(readFileSync(indexPath, "utf8")).toBe(damaged);

    // And one refusal does not abort the run: every other index in the
    // vault was still rebuilt.
    expect(readFileSync(join(workspace.path, "wiki", "index.md"), "utf8")).toContain("type: index");
    expect(readFileSync(join(vaultRoot, "system", "index.md"), "utf8")).toContain("type: index");
  });

  describe("containment (VAULT-10, read side)", () => {
    let outside: string;

    beforeEach(() => {
      outside = mkdtempSync(join(TEST_BASE, "voutside-"));
      writeFileSync(
        join(outside, "private.md"),
        stringifyNote(
          {
            id: "0000000000000000000000002",
            scope: globalScope(),
            stage: "raw",
            created: "2026-01-01T00:00:00.000Z",
            updated: "2026-01-01T00:00:00.000Z",
            generatedBy: { skill: "repair-test" },
            aiGenerated: false,
            sources: [],
            confidence: "unverified",
            lastReviewed: null,
          },
          "# private\n",
        ),
        "utf8",
      );
    });

    afterEach(() => {
      rmSync(outside, { recursive: true, force: true });
    });

    test("a symlinked directory escaping the vault contributes no notes to the report", () => {
      // Every WRITE in this package resolves through `checkPathContainment`;
      // the walk did not, and `statSync` follows symlinks. The records this
      // produced are the documented input to `rebuildVaultNotes`, so an
      // escape here puts metadata for files outside the approved root into
      // the operational store under a path that lies about where they live.
      symlinkSync(outside, join(vaultRoot, "global", "escape"), "dir");
      const inside = writeManagedNote("global/wiki/alpha.md");

      const report = repairVault(vaultRoot);

      expect(report.notes.map((note) => note.path)).toEqual([rel(inside.path)]);
      expect(report.notes.some((note) => note.path.includes("escape"))).toBe(false);
      expect(existsSync(join(outside, "index.md"))).toBe(false);
    });

    test("a symlinked note file escaping the vault is not reported as a vault note", () => {
      symlinkSync(join(outside, "private.md"), join(vaultRoot, "inbox", "linked.md"), "file");
      const inside = writeManagedNote("global/wiki/alpha.md");

      const report = repairVault(vaultRoot);

      expect(report.notes.map((note) => note.path)).toEqual([rel(inside.path)]);
    });

    test("a symlink under workspaces/ does not abort the run", () => {
      // The escaping folder made `indexFolders` include a path
      // `regenerateIndex` refuses, and the throw propagated out of
      // `repairVault` AFTER earlier indexes had already been rewritten —
      // leaving the vault half-repaired and the command permanently failing
      // until a human found the symlink unaided.
      const workspace = createWorkspace(vaultRoot, "Escape hatch");
      symlinkSync(outside, join(workspace.path, "esc"), "dir");
      writeManagedNote(`${rel(workspace.path)}/wiki/gamma.md`, {
        scope: workspaceScope(workspace.workspaceId),
      });

      const report = repairVault(vaultRoot);

      expect(report.notes.some((note) => note.path.includes("esc/"))).toBe(false);
      expect(readFileSync(join(workspace.path, "wiki", "index.md"), "utf8")).toContain("gamma");
      expect(existsSync(join(outside, "index.md"))).toBe(false);
    });

    test("a directory symlink cycle terminates on the walk's own guard", () => {
      // Termination today relies on macOS returning ELOOP after ~32
      // resolutions, which is an accident of the platform rather than
      // anything this code guarantees. Deduplicating by REAL path makes it
      // a property of the walk.
      const loop = join(vaultRoot, "global", "raw", "loop");
      symlinkSync(join(vaultRoot, "global"), loop, "dir");
      const inside = writeManagedNote("global/wiki/alpha.md");

      const report = repairVault(vaultRoot);

      expect(report.notes.map((note) => note.path)).toEqual([rel(inside.path)]);
      expect(report.warnings.filter((w) => w.kind === "duplicate-id")).toEqual([]);
    });
  });

  test("produces deep-equal reports on two runs over the same corrupted tree", () => {
    // Deliberately only the two conditions repair does NOT resolve — a
    // duplicate and an invalid note are both still there after run one,
    // because repair never edits a note. (An orphaned index entry IS
    // resolved by regeneration; its one-shot behavior is asserted above.)
    const original = writeManagedNote("global/wiki/alpha.md");
    copyFileSync(original.path, join(vaultRoot, "global", "raw", "alpha-copy.md"));
    writeManagedNote("inbox/beta.md");
    writeFileSync(join(vaultRoot, "daily", "broken.md"), "---\nid: nope\n---\n", "utf8");

    const first = repairVault(vaultRoot);
    const second = repairVault(vaultRoot);

    expect(second).toEqual(first);
    // Not vacuous: the corrupted tree really did produce warnings.
    expect(first.warnings.length).toBe(2);
  });

  test("sorts notes by created then id, and warnings by kind then path", () => {
    writeManagedNote("global/wiki/later.md", { created: "2026-03-03T00:00:00.000Z" });
    writeManagedNote("global/raw/earlier.md", { created: "2026-01-01T00:00:00.000Z" });
    writeManagedNote("inbox/middle.md", { created: "2026-02-02T00:00:00.000Z" });

    const duplicated = writeManagedNote("daily/dup.md", { created: "2026-04-04T00:00:00.000Z" });
    copyFileSync(duplicated.path, join(vaultRoot, "system", "dup-copy.md"));
    writeFileSync(join(vaultRoot, "global", "output", "broken.md"), "---\nid: nope\n---\n", "utf8");

    const report = repairVault(vaultRoot);

    expect(report.notes.map((note) => note.frontmatter.created)).toEqual([
      "2026-01-01T00:00:00.000Z",
      "2026-02-02T00:00:00.000Z",
      "2026-03-03T00:00:00.000Z",
    ]);
    expect(report.warnings.map((warning) => warning.kind)).toEqual([
      "duplicate-id",
      "invalid-frontmatter",
    ]);
  });
});

describe("Test 9 (06-15): repair of tasks folders", () => {
  function taskText(n: number, scope: string, status: string): string {
    return stringifyTaskNote(
      TaskFrontmatterSchema.parse({
        id: n.toString(36).padStart(25, "0"),
        scope,
        stage: "capture",
        created: "2026-10-05T12:00:00.000Z",
        updated: "2026-10-05T12:00:00.000Z",
        generatedBy: {},
        aiGenerated: false,
        sources: [],
        confidence: "unverified",
        lastReviewed: null,
        type: "task",
        title: `Task ${n}`,
        status,
      }),
      `Body ${n}\n`,
    );
  }

  test("regenerates a tasks index as the summary with counts and leaves the notes untouched", () => {
    const workspace = createWorkspace(vaultRoot, "Repair tasks");
    const scope = workspaceScope(workspace.workspaceId);
    const folder = join(workspace.path, "tasks");
    const files = [
      [1, "inbox"],
      [2, "inbox"],
      [3, "done"],
    ] as const;
    for (const [n, status] of files) {
      writeFileSync(join(folder, `task-${n}-12345678.md`), taskText(n, scope, status), "utf8");
    }
    writeFileSync(join(folder, "index.md"), "stale per-note listing\n", "utf8");
    const before = files.map(([n]) => readFileSync(join(folder, `task-${n}-12345678.md`)));

    const report = repairVault(vaultRoot);

    expect(report.warnings).toEqual([]);
    const index = readFileSync(join(folder, "index.md"), "utf8");
    expect(index).not.toContain("stale per-note listing");
    expect(index).toMatch(/inbox[^\n]*2/);
    expect(index).toMatch(/done[^\n]*1/);
    expect(index).not.toContain("task-1-12345678");
    files.forEach(([n], i) => {
      expect(readFileSync(join(folder, `task-${n}-12345678.md`)).equals(before[i] as Buffer)).toBe(
        true,
      );
    });
    expect(report.notes.filter((note) => note.path.includes("/tasks/"))).toHaveLength(3);
    // Repairing twice is byte-stable.
    const again = readFileSync(join(folder, "index.md"), "utf8");
    repairVault(vaultRoot);
    expect(readFileSync(join(folder, "index.md"), "utf8")).toBe(again);
  });

  test("a hand-edited task with an unquoted instant is not reported as invalid", () => {
    writeFileSync(
      join(vaultRoot, "global", "tasks", "hand-made-12345678.md"),
      taskText(9, "global", "inbox").replace(
        "created: '2026-10-05T12:00:00.000Z'",
        "created: 2026-10-05T12:00:00.000Z",
      ),
      "utf8",
    );
    expect(repairVault(vaultRoot).warnings).toEqual([]);
  });

  test("a deleted tasks index is rebuilt, and a nested folder under tasks gets none", () => {
    const workspace = createWorkspace(vaultRoot, "Rebuild");
    rmSync(join(workspace.path, "tasks", "index.md"));
    mkdirSync(join(workspace.path, "tasks", "archive"), { recursive: true });
    repairVault(vaultRoot);
    expect(existsSync(join(workspace.path, "tasks", "index.md"))).toBe(true);
    expect(existsSync(join(workspace.path, "tasks", "archive", "index.md"))).toBe(false);
  });
});
