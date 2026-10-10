// Plan 06-15, task 2: the task scanner surfaces duplicate, id-less and
// unreadable notes without resolving them, writes nothing and mints nothing
// (D-37, T-06-21, T-06-26; prohibition TASK-02). Test numbers match the plan.
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  TASK_FILE_MAX_BYTES,
  TASK_STATUSES,
  type TaskFrontmatter,
  TaskFrontmatterSchema,
  YAML_NOTE_VARIANTS,
} from "@ccc/domain";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { repairVault } from "./repair.js";
import { createWorkspace, initializeVault } from "./setup.js";
import { stringifyTaskNote } from "./task-note.js";
import { scanTaskNotes } from "./task-scan.js";

const TEST_BASE = join(homedir(), ".ccc-test");

let vaultRoot: string;

beforeEach(() => {
  mkdirSync(TEST_BASE, { recursive: true });
  vaultRoot = mkdtempSync(join(TEST_BASE, "vscan-"));
  initializeVault(vaultRoot);
});

afterEach(() => {
  rmSync(vaultRoot, { recursive: true, force: true });
});

function put(relativePath: string, text: string): void {
  const target = join(vaultRoot, ...relativePath.split("/"));
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, text, "utf8");
}

/** Every file in the vault with its bytes' hash; directories listed too. */
function fingerprint(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      if (statSync(full).isDirectory()) {
        out[`${rel}/`] = "<dir>";
        walk(full, rel);
      } else {
        out[rel] = createHash("sha256").update(readFileSync(full)).digest("hex");
      }
    }
  };
  walk(root, "");
  return out;
}

const NOTE_ID = (n: number): string => n.toString(36).padStart(25, "0");

function taskFrontmatter(
  n: number,
  extra: Record<string, unknown> = {},
  scope = "global",
): TaskFrontmatter {
  return TaskFrontmatterSchema.parse({
    id: NOTE_ID(n),
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
    status: "inbox",
    ...extra,
  });
}

/** Lays out every shared variant plus the problem notes the plan names. */
function seedFixture(): { workspaceId: string; workspaceTaskPath: string } {
  for (const variant of YAML_NOTE_VARIANTS) {
    put(`global/tasks/${variant.fileName}`, variant.text);
  }
  const workspace = createWorkspace(vaultRoot, "Research");
  const workspaceTaskPath = `workspaces/${workspace.workspaceId}/tasks/workspace-task-12345678.md`;
  put(
    workspaceTaskPath,
    stringifyTaskNote(
      taskFrontmatter(900, { status: "ready" }, `workspace:${workspace.workspaceId}`),
      "A workspace task.\n",
    ),
  );
  // An oversized note, an id-less hand-made note and an index the scan ignores.
  put(
    "global/tasks/huge-note-aaaaaaaa.md",
    `---\nid: ${NOTE_ID(777)}\n---\n${"z".repeat(TASK_FILE_MAX_BYTES)}`,
  );
  // A markdown file that is not in a tasks folder is never scanned.
  put("global/wiki/not-a-task.md", "# Not a task\n");
  return { workspaceId: workspace.workspaceId, workspaceTaskPath };
}

describe("Test 7: scanTaskNotes", () => {
  test("returns the valid tasks with parsed fields, vault-relative paths and whole-file hashes", () => {
    const { workspaceTaskPath } = seedFixture();
    const result = scanTaskNotes(vaultRoot);

    const validVariants = YAML_NOTE_VARIANTS.filter(
      (variant) => variant.outcome === "valid" && !variant.name.startsWith("duplicate-id"),
    );
    const paths = result.tasks.map((task) => task.path).sort();
    expect(paths).toEqual(
      [
        ...validVariants.map((variant) => `global/tasks/${variant.fileName}`),
        workspaceTaskPath,
      ].sort(),
    );

    const canonical = YAML_NOTE_VARIANTS.find((variant) => variant.name === "canonical");
    const found = result.tasks.find((task) => task.path === `global/tasks/${canonical?.fileName}`);
    expect(found?.frontmatter.id).toBe(canonical?.id);
    expect(found?.frontmatter.title).toBe("Draft the weekly review");
    expect(found?.contentHash).toBe(
      createHash("sha256")
        .update(readFileSync(join(vaultRoot, "global", "tasks", canonical?.fileName ?? "")))
        .digest("hex"),
    );
    const dated = result.tasks.find((task) => task.path.includes("unquoted-date"));
    expect(dated?.frontmatter.due).toBe("2026-10-09");
  });

  test("the content hash covers the frontmatter: a status or date edit with an unchanged body changes it", () => {
    seedFixture();
    const variant = YAML_NOTE_VARIANTS.find((entry) => entry.name === "unquoted-date");
    if (variant === undefined) throw new Error("variant missing");
    const path = `global/tasks/${variant.fileName}`;
    const before = scanTaskNotes(vaultRoot).tasks.find((task) => task.path === path);

    put(path, variant.text.replace(/^status: inbox$/m, "status: done"));
    const statusEdit = scanTaskNotes(vaultRoot).tasks.find((task) => task.path === path);
    expect(statusEdit?.frontmatter.status).toBe("done");
    expect(statusEdit?.contentHash).not.toBe(before?.contentHash);

    put(path, variant.text.replace("due: 2026-10-09", "due: 2026-10-10"));
    const dateEdit = scanTaskNotes(vaultRoot).tasks.find((task) => task.path === path);
    expect(dateEdit?.frontmatter.due).toBe("2026-10-10");
    expect(dateEdit?.contentHash).not.toBe(before?.contentHash);
    expect(dateEdit?.contentHash).not.toBe(statusEdit?.contentHash);
  });

  test("duplicates, an id-less note, unreadable and oversized notes go to the attention list", () => {
    seedFixture();
    const result = scanTaskNotes(vaultRoot);

    const duplicates = result.attention.filter((entry) => entry.reason === "duplicate-id");
    expect(duplicates).toHaveLength(1);
    const first = YAML_NOTE_VARIANTS.find((entry) => entry.name === "duplicate-id-first");
    const second = YAML_NOTE_VARIANTS.find((entry) => entry.name === "duplicate-id-second");
    expect(duplicates[0]?.id).toBe(first?.id);
    expect(duplicates[0]?.paths).toEqual(
      [`global/tasks/${first?.fileName}`, `global/tasks/${second?.fileName}`].sort(),
    );

    const missing = result.attention.filter((entry) => entry.reason === "missing-id");
    expect(missing.map((entry) => entry.paths)).toEqual([
      [`global/tasks/${YAML_NOTE_VARIANTS.find((entry) => entry.name === "missing-id")?.fileName}`],
    ]);

    const unreadable = result.attention
      .filter((entry) => entry.reason === "unreadable")
      .flatMap((entry) => entry.paths)
      .sort();
    expect(unreadable).toEqual(
      [
        `global/tasks/${YAML_NOTE_VARIANTS.find((entry) => entry.name === "unquoted-sexagesimal-title")?.fileName}`,
        "global/tasks/huge-note-aaaaaaaa.md",
      ].sort(),
    );
  });

  test("neither copy of a duplicate is among the tasks, and the counts cover valid tasks only", () => {
    const { workspaceId } = seedFixture();
    const result = scanTaskNotes(vaultRoot);
    const duplicateId = YAML_NOTE_VARIANTS.find((entry) => entry.name === "duplicate-id-first")?.id;
    expect(result.tasks.some((task) => task.frontmatter.id === duplicateId)).toBe(false);

    // Nine valid global variants plus one ready workspace task.
    expect(result.counts.inbox).toBe(9);
    expect(result.counts.ready).toBe(1);
    expect(TASK_STATUSES.reduce((sum, status) => sum + result.counts[status], 0)).toBe(
      result.tasks.length,
    );
    expect(result.folderCounts["global/tasks"]?.inbox).toBe(9);
    expect(result.folderCounts[`workspaces/${workspaceId}/tasks`]?.ready).toBe(1);
    expect(Object.keys(result.counts).sort()).toEqual([...TASK_STATUSES].sort());
  });

  test("index.md, dotfiles, non-markdown files and markdown outside a tasks folder are ignored", () => {
    seedFixture();
    put("global/tasks/Index.md", "# an index with different case\n");
    put("global/tasks/.hidden.md", "x\n");
    put("global/tasks/readme.txt", "x\n");
    const result = scanTaskNotes(vaultRoot);
    const everything = [
      ...result.tasks.map((task) => task.path),
      ...result.attention.flatMap((entry) => entry.paths),
    ];
    expect(everything.some((path) => /index\.md$/i.test(path))).toBe(false);
    expect(everything.some((path) => path.includes(".hidden"))).toBe(false);
    expect(everything.some((path) => path.endsWith(".txt"))).toBe(false);
    expect(everything.some((path) => path.includes("not-a-task"))).toBe(false);
  });

  test("a note whose scope names another folder's scope is unreadable, not indexed", () => {
    const workspace = createWorkspace(vaultRoot, "Other");
    put(
      "global/tasks/claims-a-workspace-12345678.md",
      stringifyTaskNote(taskFrontmatter(5, {}, `workspace:${workspace.workspaceId}`), ""),
    );
    const result = scanTaskNotes(vaultRoot);
    expect(result.tasks).toEqual([]);
    expect(result.attention.map((entry) => [entry.reason, entry.paths])).toEqual([
      ["unreadable", ["global/tasks/claims-a-workspace-12345678.md"]],
    ]);
  });

  test("a file name that is not a task note name is skipped and counted, not listed", () => {
    put("global/tasks/bad\u0007name-12345678.md", stringifyTaskNote(taskFrontmatter(6), ""));
    const result = scanTaskNotes(vaultRoot);
    expect(result.tasks).toEqual([]);
    expect(result.attention).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  test("the attention list is deterministic and carries only constant sentences", () => {
    seedFixture();
    const one = scanTaskNotes(vaultRoot);
    const two = scanTaskNotes(vaultRoot);
    expect(two).toEqual(one);
    for (const entry of one.attention) {
      expect(entry.detail).not.toContain("Draft the weekly review");
      expect(entry.detail.length).toBeLessThan(120);
    }
  });
});

describe("Test 8: the scan never resolves anything", () => {
  test("it writes nothing, mints no id and renames nothing", () => {
    seedFixture();
    const before = fingerprint(vaultRoot);
    scanTaskNotes(vaultRoot);
    scanTaskNotes(vaultRoot);
    expect(fingerprint(vaultRoot)).toEqual(before);
    const idless = YAML_NOTE_VARIANTS.find((entry) => entry.name === "missing-id");
    expect(readFileSync(join(vaultRoot, "global", "tasks", idless?.fileName ?? ""), "utf8")).toBe(
      idless?.text,
    );
  });
});

describe("Test 10: speed at 10,000 tasks", () => {
  test("a scan of 10,000 notes takes under 2 seconds and a repair of that vault under 5", () => {
    const folder = join(vaultRoot, "global", "tasks");
    mkdirSync(folder, { recursive: true });
    for (let i = 1; i <= 10_000; i++) {
      const frontmatter = taskFrontmatter(i, {
        status: TASK_STATUSES[i % TASK_STATUSES.length],
        tags: ["load", `t${i % 7}`],
        due: "2026-10-09",
      });
      writeFileSync(
        join(folder, `task-${i.toString(36).padStart(8, "0")}.md`),
        stringifyTaskNote(frontmatter, `Description ${i}.\n`),
        "utf8",
      );
    }

    const scanStart = performance.now();
    const result = scanTaskNotes(vaultRoot);
    const scanMs = performance.now() - scanStart;
    expect(result.tasks).toHaveLength(10_000);
    expect(result.attention).toEqual([]);
    expect(scanMs).toBeLessThan(2000);

    const repairStart = performance.now();
    const report = repairVault(vaultRoot);
    const repairMs = performance.now() - repairStart;
    expect(report.warnings).toEqual([]);
    expect(repairMs).toBeLessThan(5000);
    // The repaired index is the constant-size summary, not a 10,000-row listing.
    expect(statSync(join(folder, "index.md")).size).toBeLessThan(2000);
  }, 120_000);
});
