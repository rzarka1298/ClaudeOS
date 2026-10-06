// VAULT-01/02/09/11 proven rather than asserted.
//
// The three properties that make setup safe to hand a real vault are all
// measured here against real disk, not argued for in prose:
//
//   1. Plan/apply parity — the set of paths a run actually creates is a
//      subset of the paths the plan displayed beforehand.
//   2. Idempotency — a second run creates nothing and changes no byte
//      anywhere in the vault, including a user note and a user-edited
//      CLAUDE.md, compared with `Buffer.compare`.
//   3. Name independence — a workspace rename moves no path and touches no
//      note (VAULT-09's operative behavior, which plan 02-01 could only
//      prove at the mechanism level).
//
// Like `index-generation.test.ts`, these use a local ephemeral vault root
// rather than `@ccc/test-fixtures`' `withTempVaultDir`: `@ccc/vault-repo`
// sits BELOW test-fixtures in the import-boundary map. The committed
// `examples/vault/` fixture is never a target here — it is a static
// artifact, and a test writing into it is exactly the accumulation this
// phase's research names as Pitfall 6.
import { createHash } from "node:crypto";
import {
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
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TaskFrontmatterSchema, workspaceScope } from "@ccc/domain";
import matter from "gray-matter";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { regenerateIndex } from "./index-generation.js";
import {
  MANAGED_FOLDERS as SHARED_MANAGED_FOLDERS,
  WORKSPACE_LEAF_FOLDERS,
} from "./managed-folders.js";
import {
  createWorkspace,
  initializeVault,
  planVaultSetup,
  VaultRootMissingError,
} from "./setup.js";
import { stringifyTaskNote } from "./task-note.js";
import { VAULT_CLAUDE_MD } from "./vault-claude-md.js";
import { writeNote } from "./write-note.js";

const TEST_BASE = join(homedir(), ".ccc-test");

/** The PRD folder tree (claude-command-center-prd.md:590-605), in the fixed
 * depth-first order the plan displays and the apply walks. */
const MANAGED_FOLDERS = [
  "global",
  "global/raw",
  "global/wiki",
  "global/output",
  "global/tasks",
  "workspaces",
  "inbox",
  "daily",
  "automation-runs",
  "system",
] as const;

/** The whole displayed plan, as `[relativePath, kind]` pairs: every folder
 * depth-first, then every folder's index, then the vault CLAUDE.md. */
const EXPECTED_PLAN: ReadonlyArray<readonly [string, string]> = [
  ...MANAGED_FOLDERS.map((folder) => [folder, "folder"] as const),
  ...MANAGED_FOLDERS.map((folder) => [`${folder}/index.md`, "index"] as const),
  ["CLAUDE.md", "claude-md"] as const,
];

let vaultRoot: string;

beforeEach(() => {
  mkdirSync(TEST_BASE, { recursive: true });
  vaultRoot = mkdtempSync(join(TEST_BASE, "vsetup-"));
});

afterEach(() => {
  rmSync(vaultRoot, { recursive: true, force: true });
});

/** Every path under `root`, vault-relative and POSIX-separated, with
 * directories marked by a trailing slash so a file and a directory of the
 * same name can never be conflated. */
function listTree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        out.push(`${rel}/`);
        walk(full, rel);
      } else {
        out.push(rel);
      }
    }
  };
  walk(root, "");
  return out.sort();
}

/** Content fingerprint of the whole vault: path → sha256 (or `<dir>`).
 * Comparing two of these is how "changed no byte anywhere" is checked
 * without enumerating the files a test happens to think about. */
function hashTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of listTree(root)) {
    if (rel.endsWith("/")) {
      out[rel] = "<dir>";
      continue;
    }
    const bytes = readFileSync(join(root, ...rel.split("/")));
    out[rel] = createHash("sha256").update(bytes).digest("hex");
  }
  return out;
}

/** One schema-valid user note, written through the real write path. */
function seedUserNote(root: string): { path: string; noteId: string } {
  const written = writeNote({
    vaultRoot: root,
    relativePath: "inbox/my-note.md",
    body: "# My note\n\nSomething the user wrote.\n",
    scope: "global",
    stage: "capture",
    generatedBy: {},
    aiGenerated: false,
    confidence: "unverified",
  });
  return { path: written.path, noteId: written.noteId };
}

describe("planVaultSetup", () => {
  test("lists every managed path in one fixed order and writes nothing", () => {
    const before = listTree(vaultRoot);

    const plan = planVaultSetup(vaultRoot);

    expect(plan.vaultRoot).toBe(vaultRoot);
    expect(plan.entries.map((entry) => [entry.relativePath, entry.kind])).toEqual(
      EXPECTED_PLAN.map(([relativePath, kind]) => [relativePath, kind]),
    );
    // Pure read-only: a plan call is something a user is shown BEFORE they
    // agree to anything, so it must not be able to create the vault it is
    // describing.
    expect(listTree(vaultRoot)).toEqual(before);
    expect(plan.entries.every((entry) => entry.exists === false)).toBe(true);
  });

  test("called twice on the same root returns deep-equal output", () => {
    expect(planVaultSetup(vaultRoot)).toEqual(planVaultSetup(vaultRoot));
  });

  test("reports accurate exists flags on a partially existing tree", () => {
    mkdirSync(join(vaultRoot, "global", "wiki"), { recursive: true });
    writeFileSync(join(vaultRoot, "CLAUDE.md"), "user-authored\n", "utf8");

    const byPath = new Map(
      planVaultSetup(vaultRoot).entries.map((entry) => [entry.relativePath, entry.exists]),
    );

    expect(byPath.get("global")).toBe(true);
    expect(byPath.get("global/wiki")).toBe(true);
    expect(byPath.get("CLAUDE.md")).toBe(true);
    expect(byPath.get("global/raw")).toBe(false);
    expect(byPath.get("inbox")).toBe(false);
    expect(byPath.get("global/wiki/index.md")).toBe(false);
  });

  test("refuses a vault root that does not exist", () => {
    expect(() => planVaultSetup(join(vaultRoot, "typo"))).toThrow(VaultRootMissingError);
  });
});

describe("initializeVault", () => {
  test("creates the full PRD tree with an index in every managed folder and a vault CLAUDE.md", () => {
    const result = initializeVault(vaultRoot);

    for (const folder of MANAGED_FOLDERS) {
      expect(statSync(join(vaultRoot, ...folder.split("/"))).isDirectory()).toBe(true);
      expect(existsSync(join(vaultRoot, ...folder.split("/"), "index.md"))).toBe(true);
    }
    expect(existsSync(join(vaultRoot, "CLAUDE.md"))).toBe(true);
    expect(result.created).toEqual(EXPECTED_PLAN.map(([relativePath]) => relativePath));
    expect(result.existing).toEqual([]);
  });

  test("writes only paths the plan displayed", () => {
    const planned = new Set(planVaultSetup(vaultRoot).entries.map((entry) => entry.relativePath));
    const before = new Set(listTree(vaultRoot));

    initializeVault(vaultRoot);

    const added = listTree(vaultRoot)
      .filter((path) => !before.has(path))
      .map((path) => (path.endsWith("/") ? path.slice(0, -1) : path));

    expect(added.length).toBeGreaterThan(0);
    expect(added.filter((path) => !planned.has(path))).toEqual([]);
  });

  test("re-running creates nothing and changes no byte of user-authored content", () => {
    initializeVault(vaultRoot);
    const note = seedUserNote(vaultRoot);
    const claudeMdPath = join(vaultRoot, "CLAUDE.md");
    writeFileSync(claudeMdPath, "# My own notes to Claude\n\nHand-written.\n", "utf8");

    const noteBefore = readFileSync(note.path);
    const claudeMdBefore = readFileSync(claudeMdPath);
    const snapshot = hashTree(vaultRoot);

    const second = initializeVault(vaultRoot);

    expect(second.created).toEqual([]);
    expect(second.existing).toEqual(EXPECTED_PLAN.map(([relativePath]) => relativePath));
    // Nothing anywhere in the vault changed — indexes regenerated to the
    // same bytes, and every other file was left alone.
    expect(hashTree(vaultRoot)).toEqual(snapshot);
    expect(Buffer.compare(readFileSync(note.path), noteBefore)).toBe(0);
    expect(Buffer.compare(readFileSync(claudeMdPath), claudeMdBefore)).toBe(0);
  });

  test("throws VaultRootMissingError for a nonexistent root and creates nothing", () => {
    const missing = join(vaultRoot, "definitely", "not", "here");

    expect(() => initializeVault(missing)).toThrow(VaultRootMissingError);
    expect(existsSync(join(vaultRoot, "definitely"))).toBe(false);
    expect(listTree(vaultRoot)).toEqual([]);
  });

  test("throws VaultRootMissingError when the root is a file rather than a directory", () => {
    const notADirectory = join(vaultRoot, "vault.md");
    writeFileSync(notADirectory, "not a vault\n", "utf8");

    expect(() => initializeVault(notADirectory)).toThrow(VaultRootMissingError);
  });

  test("seeds the vault CLAUDE.md with the lifecycle, finding-notes and scope sections", () => {
    initializeVault(vaultRoot);

    const onDisk = readFileSync(join(vaultRoot, "CLAUDE.md"), "utf8");

    expect(onDisk).toBe(VAULT_CLAUDE_MD);
    // VAULT-11's three required sections.
    expect(onDisk).toContain("## Lifecycle");
    expect(onDisk).toContain("## Finding notes");
    expect(onDisk).toContain("## Scope boundaries");
    for (const stage of ["capture", "raw", "synthesis", "wiki", "deliverable", "output"]) {
      expect(onDisk).toContain(stage);
    }
  });
});

describe("createWorkspace", () => {
  test("puts only the opaque id in the path and the display name only in frontmatter", () => {
    initializeVault(vaultRoot);
    const displayName = "🚀 研究 Workspace";

    const workspace = createWorkspace(vaultRoot, displayName);

    expect(workspace.path).toBe(join(vaultRoot, "workspaces", workspace.workspaceId));
    expect(basename(workspace.path)).toMatch(/^[0-9a-z]{25}$/);
    expect(workspace.path).not.toContain("研究");
    expect(workspace.path).not.toContain("🚀");

    for (const leaf of ["raw", "wiki", "output", "tasks"]) {
      expect(statSync(join(workspace.path, leaf)).isDirectory()).toBe(true);
      expect(existsSync(join(workspace.path, leaf, "index.md"))).toBe(true);
    }

    const identity = matter(readFileSync(join(workspace.path, "index.md"), "utf8")).data;
    expect(identity.workspaceId).toBe(workspace.workspaceId);
    expect(identity.displayName).toBe(displayName);
  });

  test("renaming a workspace changes neither its id, its path, nor any note's location", () => {
    initializeVault(vaultRoot);
    const workspace = createWorkspace(vaultRoot, "Original name");
    const note = writeNote({
      vaultRoot,
      relativePath: `workspaces/${workspace.workspaceId}/wiki/first-note.md`,
      body: "# First note\n",
      scope: workspaceScope(workspace.workspaceId),
      stage: "wiki",
      generatedBy: {},
      aiGenerated: false,
      confidence: "unverified",
    });

    const noteBefore = readFileSync(note.path);
    const wikiIndexPath = join(workspace.path, "wiki", "index.md");
    expect(readFileSync(wikiIndexPath, "utf8")).toContain(note.noteId);

    // The user rename: a raw edit of `displayName` in the workspace-root
    // index frontmatter, which is the one identity key regeneration
    // preserves rather than recomputes.
    const workspaceIndexPath = join(workspace.path, "index.md");
    writeFileSync(
      workspaceIndexPath,
      readFileSync(workspaceIndexPath, "utf8").replace("Original name", "Renamed workspace"),
      "utf8",
    );
    regenerateIndex(workspace.path, { vaultRoot });
    initializeVault(vaultRoot);

    const identity = matter(readFileSync(workspaceIndexPath, "utf8")).data;

    // 1. Same opaque id, new display name.
    expect(identity.workspaceId).toBe(workspace.workspaceId);
    expect(identity.displayName).toBe("Renamed workspace");
    // 2. Same directory path — and no second directory appeared alongside
    // it, which is what a rename implemented as "move the folder" would
    // have left behind. (`workspaces/` also holds its own generated
    // index.md, so only directories are compared.)
    expect(existsSync(join(vaultRoot, "workspaces", workspace.workspaceId))).toBe(true);
    const workspaceDirs = readdirSync(join(vaultRoot, "workspaces")).filter((name) =>
      statSync(join(vaultRoot, "workspaces", name)).isDirectory(),
    );
    expect(workspaceDirs).toEqual([workspace.workspaceId]);
    // 3. The note sits at its original path, byte-identical.
    expect(Buffer.compare(readFileSync(note.path), noteBefore)).toBe(0);
    // 4. The wiki index still references the note by its original id.
    expect(readFileSync(wikiIndexPath, "utf8")).toContain(note.noteId);
  });
});

describe("Test 1 (06-15): the managed folder constants are defined once", () => {
  const here = dirname(fileURLToPath(import.meta.url));

  test("the shared list is the PRD tree with the tasks folder after output", () => {
    expect([...SHARED_MANAGED_FOLDERS]).toEqual([...MANAGED_FOLDERS]);
    expect([...WORKSPACE_LEAF_FOLDERS]).toEqual(["raw", "wiki", "output", "tasks"]);
  });

  test("setup and repair import the constants instead of defining their own", () => {
    for (const name of ["setup.ts", "repair.ts"]) {
      const source = readFileSync(join(here, name), "utf8");
      expect(source, name).toContain('from "./managed-folders.js"');
      expect(source, name).not.toMatch(/const MANAGED_FOLDERS\b/);
      expect(source, name).not.toMatch(/const WORKSPACE_LEAF_FOLDERS\b/);
    }
  });
});

describe("Test 2 (06-15): the tasks folder in setup and createWorkspace", () => {
  test("the plan lists global/tasks and its index, and apply creates both", () => {
    const planned = planVaultSetup(vaultRoot).entries.map((entry) => entry.relativePath);
    expect(planned).toContain("global/tasks");
    expect(planned).toContain("global/tasks/index.md");
    initializeVault(vaultRoot);
    expect(statSync(join(vaultRoot, "global", "tasks")).isDirectory()).toBe(true);
    expect(existsSync(join(vaultRoot, "global", "tasks", "index.md"))).toBe(true);
  });

  test("a second run creates nothing and rewrites nothing", () => {
    initializeVault(vaultRoot);
    const before = hashTree(vaultRoot);
    const second = initializeVault(vaultRoot);
    expect(second.created).toEqual([]);
    expect(hashTree(vaultRoot)).toEqual(before);
  });

  test("with tasks present the index carries their counts and a re-run is byte-identical", () => {
    initializeVault(vaultRoot);
    const frontmatter = TaskFrontmatterSchema.parse({
      id: "a0123456789abcdefghijklmn",
      scope: "global",
      stage: "capture",
      created: "2026-10-05T12:00:00.000Z",
      updated: "2026-10-05T12:00:00.000Z",
      generatedBy: {},
      aiGenerated: false,
      sources: [],
      confidence: "unverified",
      lastReviewed: null,
      type: "task",
      title: "Counted",
      status: "ready",
    });
    writeFileSync(
      join(vaultRoot, "global", "tasks", "counted-12345678.md"),
      stringifyTaskNote(frontmatter, ""),
      "utf8",
    );
    initializeVault(vaultRoot);
    const index = readFileSync(join(vaultRoot, "global", "tasks", "index.md"), "utf8");
    expect(index).toMatch(/ready[^\n]*1/);
    const before = hashTree(vaultRoot);
    initializeVault(vaultRoot);
    expect(hashTree(vaultRoot)).toEqual(before);
  });

  test("a new workspace gets a tasks folder with a summary index", () => {
    initializeVault(vaultRoot);
    const workspace = createWorkspace(vaultRoot, "Tasks");
    const index = readFileSync(join(workspace.path, "tasks", "index.md"), "utf8");
    expect(matter(index).data.folder).toBe(`workspaces/${workspace.workspaceId}/tasks`);
    expect(index).not.toContain("_No notes yet._");
  });
});
