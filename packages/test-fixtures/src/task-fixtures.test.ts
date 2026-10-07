import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TASK_FILE_MAX_BYTES, TASK_FILTERS, TaskFrontmatterSchema } from "@ccc/domain";
import { parseTaskNote } from "@ccc/vault-repo";
import { describe, expect, it } from "vitest";
import {
  duplicateTaskNote,
  expectedCounts,
  expectedIds,
  type GeneratedTaskVault,
  generateTaskVault,
  hashVaultFiles,
  utcDay,
  withTaskVault,
} from "./task-fixtures.js";
import { withTempVaultDir } from "./vault-fixture.js";

const FIXED_NOW = new Date("2026-10-07T15:30:00.000Z");

/** Every file under `root`, with each workspace id replaced by its position, so two runs compare. */
function normalisedFiles(vault: GeneratedTaskVault): Record<string, string> {
  const out: Record<string, string> = {};
  const rename = (text: string): string =>
    vault.workspaceIds.reduce((acc, id, index) => acc.split(id).join(`WS${index}`), text);
  for (const task of vault.tasks) {
    out[rename(task.path)] = rename(readFileSync(join(vault.vaultRoot, task.path), "utf8"));
  }
  return out;
}

describe("generateTaskVault (Task 1, Test 1)", () => {
  it("writes the requested number of valid task notes across global and two workspaces", async () => {
    await withTaskVault({ count: 120, now: FIXED_NOW }, (vault) => {
      expect(vault.tasks).toHaveLength(120);
      expect(vault.scopes).toHaveLength(3);
      expect(vault.scopes[0]).toBe("global");
      expect(new Set(vault.tasks.map((task) => task.scope))).toEqual(new Set(vault.scopes));
      for (const task of vault.tasks) {
        const raw = readFileSync(join(vault.vaultRoot, task.path), "utf8");
        const parsed = parseTaskNote(raw);
        expect(TaskFrontmatterSchema.safeParse(parsed.frontmatter).success).toBe(true);
        expect(parsed.frontmatter.id).toBe(task.id);
        expect(parsed.frontmatter.scope).toBe(task.scope);
        expect(parsed.frontmatter.status).toBe(task.status);
        expect(task.path).toMatch(/^(global|workspaces\/[0-9a-z]{25})\/tasks\/[^/]+\.md$/);
      }
      expect(new Set(vault.tasks.map((task) => task.id)).size).toBe(120);
    });
  });

  it("is deterministic: the same seed and instant give byte-identical files", async () => {
    await withTaskVault({ count: 80, seed: 7, now: FIXED_NOW }, async (first) => {
      await withTaskVault({ count: 80, seed: 7, now: FIXED_NOW }, (second) => {
        expect(normalisedFiles(second)).toEqual(normalisedFiles(first));
      });
    });
  });

  it("differs for another seed", async () => {
    await withTaskVault({ count: 40, seed: 1, now: FIXED_NOW }, async (first) => {
      await withTaskVault({ count: 40, seed: 2, now: FIXED_NOW }, (second) => {
        expect(normalisedFiles(second)).not.toEqual(normalisedFiles(first));
      });
    });
  });

  it("covers every shape, with dates relative to the supplied instant", async () => {
    await withTaskVault({ count: 200, now: FIXED_NOW }, (vault) => {
      const kinds = new Set(vault.tasks.map((task) => task.kind));
      for (const kind of [
        "today-date",
        "today-instant",
        "overdue-date",
        "overdue-instant",
        "upcoming-date",
        "upcoming-instant",
        "undated",
        "in-progress",
        "blocked-status",
        "blocked-unmet",
        "blocked-dangling",
        "completed",
        "cancelled",
        "proposed",
      ] as const) {
        expect(kinds).toContain(kind);
      }
      const day = utcDay(FIXED_NOW);
      expect(day.localDate).toBe("2026-10-07");
      expect(day.startsAt).toBe("2026-10-07T00:00:00.000Z");
      expect(day.endsAt).toBe("2026-10-08T00:00:00.000Z");
      const todayDate = vault.tasks.find((task) => task.kind === "today-date");
      expect(todayDate?.due).toBe("2026-10-07");
      const overdue = vault.tasks.find((task) => task.kind === "overdue-date");
      expect((overdue?.due ?? "9999") < "2026-10-07").toBe(true);
      const upcoming = vault.tasks.find((task) => task.kind === "upcoming-instant");
      expect((upcoming?.due ?? "") >= day.endsAt).toBe(true);
    });
  });

  it("honours an exact number of unmet and dangling dependencies and can leave proposed out", async () => {
    await withTaskVault(
      {
        count: 100,
        now: FIXED_NOW,
        unmetDependencies: 7,
        danglingDependencies: 3,
        proposed: false,
      },
      (vault) => {
        expect(vault.tasks.filter((task) => task.kind === "blocked-unmet")).toHaveLength(7);
        expect(vault.tasks.filter((task) => task.kind === "blocked-dangling")).toHaveLength(3);
        expect(vault.tasks.some((task) => task.kind === "proposed")).toBe(false);
        const ids = new Set(vault.tasks.map((task) => task.id));
        for (const task of vault.tasks.filter((entry) => entry.kind === "blocked-unmet")) {
          expect(task.dependencies.length).toBeGreaterThan(0);
          for (const dependency of task.dependencies) expect(ids.has(dependency)).toBe(true);
        }
        for (const task of vault.tasks.filter((entry) => entry.kind === "blocked-dangling")) {
          for (const dependency of task.dependencies) expect(ids.has(dependency)).toBe(false);
        }
      },
    );
  });

  it("writes boundary-sized notes that the reader still accepts", async () => {
    await withTaskVault({ count: 30, now: FIXED_NOW, boundarySize: 3 }, (vault) => {
      const sizes = vault.tasks.map((task) => statSync(join(vault.vaultRoot, task.path)).size);
      const large = sizes.filter((size) => size > 200_000);
      expect(large).toHaveLength(3);
      for (const size of large) expect(size).toBeLessThanOrEqual(TASK_FILE_MAX_BYTES);
      for (const task of vault.tasks) {
        expect(() =>
          parseTaskNote(readFileSync(join(vault.vaultRoot, task.path), "utf8")),
        ).not.toThrow();
      }
    });
  });

  it("builds into a given empty directory and leaves it a managed vault", async () => {
    await withTempVaultDir((fixture) => {
      const vault = generateTaskVault(fixture.vaultRoot, { count: 10, now: FIXED_NOW });
      expect(vault.vaultRoot).toBe(fixture.vaultRoot);
      expect(existsSync(join(fixture.vaultRoot, "CLAUDE.md"))).toBe(true);
      expect(existsSync(join(fixture.vaultRoot, "global", "tasks"))).toBe(true);
      expect(readdirSync(join(fixture.vaultRoot, "workspaces"))).toHaveLength(2);
    });
  });
});

describe("the independent oracle (Task 1, Test 1)", () => {
  it("counts every note under all and agrees with the ids it lists", async () => {
    await withTaskVault({ count: 160, now: FIXED_NOW }, (vault) => {
      const day = utcDay(FIXED_NOW);
      const counts = expectedCounts(vault.tasks, "all", day);
      expect(counts.counts.all).toBe(160);
      for (const filter of TASK_FILTERS) {
        if (filter === "project") continue;
        const ids = expectedIds(vault.tasks, filter, "all", day);
        expect(ids).toHaveLength(counts.counts[filter]);
      }
      const done = vault.tasks.filter((task) => task.status === "done").length;
      expect(counts.counts.completed).toBe(done);
      const open = vault.tasks.filter(
        (task) => !["done", "cancelled", "proposed"].includes(task.status),
      ).length;
      expect(counts.open).toBe(open);
    });
  });

  it("keeps a proposed task out of every actionable view", async () => {
    await withTaskVault({ count: 160, now: FIXED_NOW }, (vault) => {
      const day = utcDay(FIXED_NOW);
      const proposed = new Set(
        vault.tasks.filter((task) => task.status === "proposed").map((task) => task.id),
      );
      expect(proposed.size).toBeGreaterThan(0);
      for (const filter of ["today", "upcoming", "overdue", "blocked", "completed"] as const) {
        for (const id of expectedIds(vault.tasks, filter, "all", day)) {
          expect(proposed.has(id)).toBe(false);
        }
      }
    });
  });

  it("narrows by scope", async () => {
    await withTaskVault({ count: 90, now: FIXED_NOW }, (vault) => {
      const day = utcDay(FIXED_NOW);
      const sum = vault.scopes
        .map((scope) => expectedCounts(vault.tasks, scope, day).counts.all)
        .reduce((a, b) => a + b, 0);
      expect(sum).toBe(90);
    });
  });
});

describe("hashVaultFiles and duplicateTaskNote (Task 1, Test 1)", () => {
  it("hashes every file, and changes only the file that changed", async () => {
    await withTaskVault({ count: 12, now: FIXED_NOW }, (vault) => {
      const before = hashVaultFiles(vault.vaultRoot);
      expect(Object.keys(before)).toContain("CLAUDE.md");
      expect(
        Object.keys(before).filter((path) => path.includes("/tasks/")).length,
      ).toBeGreaterThanOrEqual(12);
      const target = vault.tasks[0];
      if (target === undefined) throw new Error("no task");
      writeFileSync(join(vault.vaultRoot, target.path), "changed");
      const after = hashVaultFiles(vault.vaultRoot);
      const differing = Object.keys(after).filter((path) => after[path] !== before[path]);
      expect(differing).toEqual([target.path]);
    });
  });

  it("copies a note byte for byte under a second name in the same folder", async () => {
    await withTaskVault({ count: 5, now: FIXED_NOW }, (vault) => {
      const source = vault.tasks[0];
      if (source === undefined) throw new Error("no task");
      const copy = duplicateTaskNote(vault.vaultRoot, source.path, "copy-of-task.md");
      expect(copy.endsWith("/copy-of-task.md")).toBe(true);
      expect(copy.slice(0, copy.lastIndexOf("/"))).toBe(
        source.path.slice(0, source.path.lastIndexOf("/")),
      );
      expect(readFileSync(join(vault.vaultRoot, copy), "utf8")).toBe(
        readFileSync(join(vault.vaultRoot, source.path), "utf8"),
      );
    });
  });
});
