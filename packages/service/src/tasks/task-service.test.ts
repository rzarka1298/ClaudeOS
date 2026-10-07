import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  isTaskNotePath,
  ProjectIdSchema,
  TASK_FILE_SUFFIX_LENGTH,
  TASK_SLUG_MAX_LENGTH,
  type TaskCreateRequest,
  TaskCreateResponseSchema,
  VALID_HOSTILE_TASK_TITLES,
} from "@ccc/domain";
import { getTask } from "@ccc/operational-store";
import { parseTaskNote } from "@ccc/vault-repo";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeServiceFixture,
  publishedGenerations,
  type ServiceFixture,
} from "../test-support/task-fixtures.js";
import { createTaskServices } from "./task-service.js";
import type { TaskServices } from "./types.js";

let fx: ServiceFixture;
let services: TaskServices;

beforeEach(() => {
  fx = makeServiceFixture();
  services = createTaskServices(fx.deps);
});

afterEach(() => {
  vi.restoreAllMocks();
  fx.cleanup();
});

const ZONE = "America/New_York";
const PROJECT_ID = ProjectIdSchema.parse("abcdefghi0123456789abcdef");

function request(overrides: Partial<TaskCreateRequest> = {}): TaskCreateRequest {
  return { title: "Write the quarterly note", intent: "inbox", zone: ZONE, ...overrides };
}

function createOk(overrides: Partial<TaskCreateRequest> = {}) {
  const result = services.create(request(overrides));
  if (!result.ok) throw new Error(`create refused: ${result.code}`);
  return result.value;
}

function tasksFolder(scopeFolder = "global"): string {
  return join(fx.vault.root, ...scopeFolder.split("/"), "tasks");
}

function noteFiles(scopeFolder = "global"): string[] {
  return readdirSync(tasksFolder(scopeFolder)).filter((name) => name !== "index.md");
}

describe("Test 1 (create, global)", () => {
  it("writes global/tasks/{slug}-{suffix}.md that parses back as an inbox task at the capture stage", () => {
    const { task } = createOk();
    const files = noteFiles();
    expect(files).toHaveLength(1);
    const name = files[0] as string;
    expect(name).toMatch(/^write-the-quarterly-note-[0-9a-z]{8}\.md$/);
    const parsed = parseTaskNote(readFileSync(join(tasksFolder(), name), "utf8"));
    expect(parsed.frontmatter.status).toBe("inbox");
    expect(parsed.frontmatter.stage).toBe("capture");
    expect(parsed.frontmatter.id).toBe(task.id);
    expect(parsed.frontmatter.title).toBe("Write the quarterly note");
    expect(parsed.frontmatter.sourceType).toBe("manual");
  });

  it("indexes the note and answers with the row, which carries no body text or absolute path", () => {
    const { task } = createOk({ description: "A body that must stay in the note." });
    const indexed = getTask(fx.store.db, task.id);
    expect(indexed?.path).toMatch(/^global\/tasks\/.+\.md$/);
    expect(indexed?.title).toBe("Write the quarterly note");
    expect(TaskCreateResponseSchema.safeParse({ task }).success).toBe(true);
    const wire = JSON.stringify({ task });
    expect(wire).not.toContain("A body that must stay");
    expect(wire).not.toContain(fx.vault.root);
    expect(wire).not.toContain(".md");
    expect(task.status).toBe("inbox");
    expect(task.scope).toBe("global");
  });

  it("publishes tasks.changed with a higher generation for each create", () => {
    createOk();
    createOk({ title: "Second task" });
    const generations = publishedGenerations(fx.bus);
    expect(generations).toHaveLength(2);
    expect(generations[1]).toBeGreaterThan(generations[0] as number);
  });
});

describe("Test 2 (intent and fields)", () => {
  it("gives status ready for the ready intent", () => {
    const { task } = createOk({ intent: "ready" });
    expect(task.status).toBe("ready");
  });

  it("stores priority, project, tags, a scheduled date and a local due date with a time converted in the zone", () => {
    const { task } = createOk({
      priority: "high",
      projectId: PROJECT_ID,
      tags: ["alpha", "beta/gamma"],
      dueDate: "2026-10-09",
      dueTime: "15:00",
      scheduledDate: "2026-10-08",
    });
    expect(task.priority).toBe("high");
    expect(task.projectId).toBe(PROJECT_ID);
    expect(task.tags).toEqual(["alpha", "beta/gamma"]);
    expect(task.tagCount).toBe(2);
    // 15:00 in New York on 2026-10-09 is UTC-4.
    expect(task.dueAt).toBe("2026-10-09T19:00:00.000Z");
    expect(task.dueDate).toBeUndefined();
    expect(task.scheduledDate).toBe("2026-10-08");
    const name = noteFiles()[0] as string;
    const parsed = parseTaskNote(readFileSync(join(tasksFolder(), name), "utf8"));
    expect(parsed.frontmatter.due).toBe("2026-10-09T15:00:00-04:00");
    expect(parsed.frontmatter.scheduled).toBe("2026-10-08");
  });

  it("keeps a due date with no time as a date-only value", () => {
    const { task } = createOk({ dueDate: "2026-10-09" });
    expect(task.dueDate).toBe("2026-10-09");
    expect(task.dueAt).toBeUndefined();
  });

  it("writes the description as the note body verbatim", () => {
    createOk({ description: "Line one\n\nLine two" });
    const name = noteFiles()[0] as string;
    const parsed = parseTaskNote(readFileSync(join(tasksFolder(), name), "utf8"));
    expect(parsed.body).toBe("Line one\n\nLine two");
  });
});

describe("Test 3 (workspace scope)", () => {
  it("writes under the workspace's tasks folder", () => {
    const workspaceId = fx.vault.workspace();
    const { task } = createOk({ scope: `workspace:${workspaceId}` });
    expect(task.scope).toBe(`workspace:${workspaceId}`);
    expect(noteFiles(`workspaces/${workspaceId}`)).toHaveLength(1);
    expect(getTask(fx.store.db, task.id)?.path).toMatch(
      new RegExp(`^workspaces/${workspaceId}/tasks/`),
    );
  });

  it("creates the tasks folder and its summary index lazily for a workspace that predates the folder", () => {
    const workspaceId = fx.vault.workspace();
    rmSync(tasksFolder(`workspaces/${workspaceId}`), { recursive: true, force: true });
    expect(existsSync(tasksFolder(`workspaces/${workspaceId}`))).toBe(false);
    createOk({ scope: `workspace:${workspaceId}` });
    expect(existsSync(join(tasksFolder(`workspaces/${workspaceId}`), "index.md"))).toBe(true);
    expect(noteFiles(`workspaces/${workspaceId}`)).toHaveLength(1);
  });

  it("refuses a scope for a workspace that does not exist with invalid-scope and creates nothing", () => {
    const ghost = "workspace:0000000000000000000000000";
    const before = readdirSync(join(fx.vault.root, "workspaces"));
    const result = services.create(request({ scope: ghost }));
    expect(result).toEqual({ ok: false, code: "invalid-scope" });
    expect(readdirSync(join(fx.vault.root, "workspaces"))).toEqual(before);
    expect(noteFiles()).toHaveLength(0);
    expect(publishedGenerations(fx.bus)).toHaveLength(0);
  });
});

describe("Test 5 (hostile title)", () => {
  it("makes ASCII slug file names within the cap and round-trips the stored title exactly", () => {
    expect(VALID_HOSTILE_TASK_TITLES.length).toBeGreaterThan(10);
    for (const title of VALID_HOSTILE_TASK_TITLES) {
      const { task } = createOk({ title });
      expect(task.title).toBe(title);
      const path = getTask(fx.store.db, task.id)?.path as string;
      expect(isTaskNotePath(path)).toBe(true);
      const name = path.slice(path.lastIndexOf("/") + 1);
      expect(name).toMatch(/^[a-z0-9-]+\.md$/);
      expect(name.length).toBeLessThanOrEqual(
        TASK_SLUG_MAX_LENGTH + 1 + TASK_FILE_SUFFIX_LENGTH + ".md".length,
      );
      expect(name).not.toMatch(/\.\./);
      const parsed = parseTaskNote(readFileSync(join(fx.vault.root, ...path.split("/")), "utf8"));
      expect(parsed.frontmatter.title).toBe(title);
    }
  });
});

describe("Test 4 (refusals leave nothing behind)", () => {
  it("answers vault-not-set-up when no vault root is registered and writes nothing", () => {
    fx.setVaultRoot(null);
    expect(services.create(request())).toEqual({ ok: false, code: "vault-not-set-up" });
    expect(noteFiles()).toHaveLength(0);
    expect(publishedGenerations(fx.bus)).toHaveLength(0);
  });

  it("refuses a due time without a date and a time that does not exist in the zone's calendar", () => {
    const badDate = services.create(request({ dueDate: "2026-02-30", dueTime: "10:00" }));
    expect(badDate).toEqual({ ok: false, code: "invalid-body" });
    expect(noteFiles()).toHaveLength(0);
  });
});

describe("Test 6 (failure)", () => {
  it("answers write-failed with no index change and logs the route name and error class only", () => {
    // A regular file where the tasks folder must be makes the folder impossible to create.
    rmSync(tasksFolder(), { recursive: true, force: true });
    writeFileSync(tasksFolder(), "not a folder /Users/USERNAME/secret");
    const result = services.create(request({ title: "A private title" }));
    expect(result).toEqual({ ok: false, code: "write-failed" });
    expect(fx.store.db.prepare("SELECT COUNT(*) AS n FROM task_index").get()).toEqual({ n: 0 });
    expect(publishedGenerations(fx.bus)).toHaveLength(0);
    expect(fx.lines).toHaveLength(1);
    const logged = JSON.stringify(fx.lines);
    expect(logged).toContain("create");
    expect(logged).toMatch(/Error/);
    expect(logged).not.toContain("A private title");
    expect(logged).not.toContain("/Users/");
    expect(logged).not.toContain(fx.vault.root);
  });
});
