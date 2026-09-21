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
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { globalScope, type NoteFrontmatter, workspaceScope } from "@ccc/domain";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { stringifyNote } from "./frontmatter.js";
import { repairVault } from "./repair.js";
import { createWorkspace, initializeVault } from "./setup.js";
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

  test("re-emits a workspace's identity keys while rebuilding its listing", () => {
    const displayName = "Repair 🛠 ワークスペース";
    const workspace = createWorkspace(vaultRoot, displayName);
    writeManagedNote(`workspaces/${workspace.workspaceId}/wiki/gamma.md`, {
      scope: workspaceScope(workspace.workspaceId),
    });

    repairVault(vaultRoot);

    const workspaceIndex = readFileSync(join(workspace.path, "index.md"), "utf8");
    expect(workspaceIndex).toContain(`workspaceId: ${workspace.workspaceId}`);
    expect(workspaceIndex).toContain(displayName);
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
