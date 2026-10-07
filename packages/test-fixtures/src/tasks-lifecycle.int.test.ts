import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  APPROVAL_LIST_PATH,
  type ApprovalsSnapshot,
  newNoteId,
  TASK_ATTENTION_PATH,
  TASK_CHANGED_PATH,
  TASK_COUNTS_PATH,
  TASK_DUE_TODAY_PATH,
  TASK_GET_PATH,
  TASK_LIST_PATH,
  TASK_REBUILD_PATH,
  type TaskAttentionResponse,
  type TaskCountsResponse,
  type TaskDueTodayResponse,
  type TaskFilter,
  type TaskGetResponse,
  type TaskListResponse,
} from "@ccc/domain";
import { acceptTask, completeTask, dismissTask, parseTaskContent } from "@ccc/plugin";
import { parseTaskNote, stringifyTaskNote, writeTaskNote } from "@ccc/vault-repo";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  duplicateTaskNote,
  eventually,
  expectedCounts,
  fileSystemTaskVault,
  type GeneratedTask,
  type GeneratedTaskVault,
  generateTaskVault,
  hashVaultFiles,
  utcDay,
} from "./task-fixtures.js";
import { startTaskService, type TaskServiceSession } from "./task-service-support.js";

/**
 * Plan 06-25 Task 3 (TASK-02, TASK-04, TASK-05, TASK-08, D-35, D-36, D-37; threats
 * T-06-21, T-06-22, T-06-24): external edits, duplicates, completion and the
 * proposed-task flow against the REAL service. Each describe builds its own small
 * vault and service so the cases cannot disturb one another.
 */

const ZONE = "UTC";
const BASE = join(homedir(), ".ccc-test");

interface Fixture {
  readonly base: string;
  readonly vault: GeneratedTaskVault;
  readonly service: TaskServiceSession;
}

async function open(count: number, proposed = true): Promise<Fixture> {
  mkdirSync(BASE, { recursive: true });
  const base = mkdtempSync(join(BASE, "tl-"));
  const vault = generateTaskVault(join(base, "vault"), { count, proposed });
  const service = await startTaskService(vault, { bootWalk: true });
  return { base, vault, service };
}

async function shut(fixture: Fixture | undefined): Promise<void> {
  if (fixture === undefined) return;
  await fixture.service.close();
  rmSync(fixture.base, { recursive: true, force: true });
}

async function listIds(
  service: TaskServiceSession,
  filter: TaskFilter,
  scope = "all",
): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 500; page += 1) {
    const reply = await service.post<TaskListResponse>(TASK_LIST_PATH, {
      context: { scope },
      filter,
      zone: ZONE,
      ...(cursor === undefined ? {} : { cursor }),
    });
    ids.push(...reply.body.rows.map((row) => row.id));
    if (reply.body.nextCursor === null) return ids;
    cursor = reply.body.nextCursor;
  }
  throw new Error("a list never ended");
}

const counts = async (service: TaskServiceSession): Promise<TaskCountsResponse> =>
  (
    await service.post<TaskCountsResponse>(TASK_COUNTS_PATH, {
      context: { scope: "all" },
      zone: ZONE,
    })
  ).body;

const detail = async (service: TaskServiceSession, taskId: string) =>
  service.post<TaskGetResponse | { error: string }>(TASK_GET_PATH, { taskId });

const changed = (service: TaskServiceSession, paths: string[]) =>
  service.post<{ accepted: number; generation: number }>(TASK_CHANGED_PATH, { paths });

const attention = async (service: TaskServiceSession): Promise<TaskAttentionResponse> =>
  (await service.post<TaskAttentionResponse>(TASK_ATTENTION_PATH, {})).body;

const read = (vault: GeneratedTaskVault, path: string): string =>
  readFileSync(join(vault.vaultRoot, ...path.split("/")), "utf8");
const write = (vault: GeneratedTaskVault, path: string, text: string): void =>
  writeFileSync(join(vault.vaultRoot, ...path.split("/")), text);

const firstOfKind = (vault: GeneratedTaskVault, kind: GeneratedTask["kind"], skip = 0) => {
  const found = vault.tasks.filter((task) => task.kind === kind)[skip];
  if (found === undefined) throw new Error(`no ${kind} task`);
  return found;
};

describe("edits made outside the dashboard (Task 3, Tests 3 and 4)", () => {
  let fixture: Fixture;
  beforeAll(async () => {
    fixture = await open(60);
  }, 120_000);
  afterAll(() => shut(fixture), 60_000);

  it("a title and status edit, a deletion, a rename and a broken note reach the lists through the changed route", async () => {
    const { vault, service } = fixture;
    const edited = firstOfKind(vault, "today-date");
    const deleted = firstOfKind(vault, "undated", 1);
    const renamed = firstOfKind(vault, "upcoming-date");
    const broken = firstOfKind(vault, "overdue-date");

    // Edit: new title, done.
    const parsed = parseTaskNote(read(vault, edited.path));
    write(
      vault,
      edited.path,
      stringifyTaskNote(
        {
          ...parsed.frontmatter,
          title: "Edited in another editor",
          status: "done",
          completed: new Date().toISOString(),
        },
        parsed.body,
        parsed.passthrough,
      ),
    );
    // Delete.
    rmSync(join(vault.vaultRoot, ...deleted.path.split("/")));
    // Rename (same folder, new name).
    const renamedPath = `${renamed.path.slice(0, renamed.path.lastIndexOf("/"))}/moved-elsewhere.md`;
    renameSync(
      join(vault.vaultRoot, ...renamed.path.split("/")),
      join(vault.vaultRoot, ...renamedPath.split("/")),
    );
    // Break the YAML.
    write(vault, broken.path, "---\nid: [unclosed\n---\nbody\n");

    const reply = await changed(service, [
      edited.path,
      deleted.path,
      renamed.path,
      renamedPath,
      broken.path,
    ]);
    expect(reply.status).toBe(200);

    const row = await detail(service, edited.id);
    expect(row.status).toBe(200);
    expect((row.body as TaskGetResponse).task.row.title).toBe("Edited in another editor");
    expect((row.body as TaskGetResponse).task.row.status).toBe("done");
    expect(await listIds(service, "completed")).toContain(edited.id);
    expect(await listIds(service, "today")).not.toContain(edited.id);

    expect((await detail(service, deleted.id)).status).toBe(404);
    expect(await listIds(service, "all")).not.toContain(deleted.id);

    const moved = await detail(service, renamed.id);
    expect(moved.status).toBe(200);
    expect((moved.body as TaskGetResponse).task.path).toBe(renamedPath);
    expect((await listIds(service, "all")).filter((id) => id === renamed.id)).toHaveLength(1);

    expect(await listIds(service, "all")).not.toContain(broken.id);
    const listed = await eventually(async () => {
      const page = await attention(service);
      return page.items.some((item) => item.path === broken.path) ? page : undefined;
    }, 15_000);
    expect(listed.items.find((item) => item.path === broken.path)?.reason).toBe("unreadable");

    // Counts agree with what is on disk now: one done, two gone from the lists.
    const total = (await counts(service)).counts.all;
    expect(total).toBe(60 - 2);
  }, 120_000);

  it("an unquoted date from the Properties editor is an all-day due date and survives a plugin rewrite as a date", async () => {
    const { vault, service } = fixture;
    const id = newNoteId();
    const path = `global/tasks/properties-date-${id.slice(-8)}.md`;
    const now = new Date().toISOString();
    const text = stringifyTaskNote(
      parseTaskNote(read(vault, firstOfKind(vault, "undated").path)).frontmatter,
      "Written by hand.\n",
    )
      .replace(/^id: .*$/m, `id: ${id}`)
      .replace(/^scope: .*$/m, "scope: global")
      .replace(/^title: .*$/m, "title: Properties editor task")
      .replace(/^status: .*$/m, "status: ready")
      .replace(/^(due|scheduled): .*\n/gm, "")
      .replace(/^tags:[\s\S]*?(?=^[a-z])/m, "")
      .replace(/^dependencies:[\s\S]*?(?=^[a-z])/m, "")
      .replace(/^sourceType: .*$/m, "sourceType: manual\ndue: 2026-12-24")
      .replace(/^updated: .*$/m, `updated: '${now}'`);
    write(vault, path, text);
    expect(text).toMatch(/^due: 2026-12-24$/m);

    await changed(service, [path]);
    const first = await detail(service, id);
    expect(first.status).toBe(200);
    expect((first.body as TaskGetResponse).task.row.dueDate).toBe("2026-12-24");
    expect((first.body as TaskGetResponse).task.row.dueAt).toBeUndefined();

    const done = await completeTask(
      {
        vault: fileSystemTaskVault(vault.vaultRoot),
        changed: (changedPath) => changed(service, [changedPath]),
      },
      { file: { path } },
      new Date().toISOString(),
    );
    expect(done.kind).toBe("applied");
    const rewritten = read(vault, path);
    expect(rewritten).toMatch(/^due: '2026-12-24'$/m);
    expect(rewritten).not.toMatch(/due: .*T/);
    const reread = parseTaskContent(rewritten);
    expect(reread.kind === "ok" ? reread.task.frontmatter.due : null).toBe("2026-12-24");

    const second = await detail(service, id);
    expect((second.body as TaskGetResponse).task.row.dueDate).toBe("2026-12-24");
    expect((second.body as TaskGetResponse).task.row.dueAt).toBeUndefined();
    expect((second.body as TaskGetResponse).task.row.status).toBe("done");
  }, 120_000);
});

describe("the changed route writes nothing (Task 3, Test 5, T-06-22)", () => {
  let fixture: Fixture;
  beforeAll(async () => {
    fixture = await open(40);
  }, 120_000);
  afterAll(() => shut(fixture), 60_000);

  it("leaves the hash of every file in the vault unchanged, except the tasks summary indexes after a rebuild", async () => {
    const { vault, service } = fixture;
    const edited = firstOfKind(vault, "today-date");
    const deleted = firstOfKind(vault, "undated", 1);
    const unchanged = firstOfKind(vault, "completed");
    const broken = firstOfKind(vault, "overdue-date");

    const parsed = parseTaskNote(read(vault, edited.path));
    write(
      vault,
      edited.path,
      stringifyTaskNote(
        { ...parsed.frontmatter, title: "Edited outside" },
        parsed.body,
        parsed.passthrough,
      ),
    );
    rmSync(join(vault.vaultRoot, ...deleted.path.split("/")));

    // The vault as the owner left it: every change below is a request to look, not a write.
    const before = hashVaultFiles(vault.vaultRoot);
    for (const paths of [
      [edited.path],
      [unchanged.path],
      [deleted.path],
      [edited.path, unchanged.path, deleted.path],
    ]) {
      expect((await changed(service, paths)).status).toBe(200);
    }
    expect(hashVaultFiles(vault.vaultRoot)).toEqual(before);

    // Invalid, rescan and rebuild branches: nothing but the tasks summary indexes may move.
    write(vault, broken.path, "---\nid: [unclosed\n---\nbody\n");
    const beforeHeavy = hashVaultFiles(vault.vaultRoot);
    expect((await changed(service, [broken.path])).status).toBe(200);
    expect((await service.post(TASK_CHANGED_PATH, { rescan: true })).status).toBe(200);
    expect((await service.post(TASK_REBUILD_PATH, {})).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 6_500));
    const after = hashVaultFiles(vault.vaultRoot);
    expect(Object.keys(after).sort()).toEqual(Object.keys(beforeHeavy).sort());
    const moved = Object.keys(after).filter((path) => after[path] !== beforeHeavy[path]);
    for (const path of moved) expect(path, path).toMatch(/\/tasks\/index\.md$/);
    for (const task of vault.tasks) {
      if (task.id === deleted.id) continue;
      expect(after[task.path], task.path).toBe(beforeHeavy[task.path]);
    }
  }, 120_000);
});

describe("a copied note (Task 3, Test 6, D-37, T-06-21)", () => {
  let fixture: Fixture;
  beforeAll(async () => {
    fixture = await open(30);
  }, 120_000);
  afterAll(() => shut(fixture), 60_000);

  it("puts both copies in the attention list, in no list or count, and resolves nothing", async () => {
    const { vault, service } = fixture;
    const original = firstOfKind(vault, "today-date");
    const before = hashVaultFiles(vault.vaultRoot);
    const copy = duplicateTaskNote(vault.vaultRoot, original.path, "copy-of-the-task.md");
    const withCopy = hashVaultFiles(vault.vaultRoot);

    expect((await changed(service, [copy, original.path])).status).toBe(200);
    const page = await eventually(async () => {
      const current = await attention(service);
      return current.items.length >= 2 ? current : undefined;
    }, 15_000);

    const originalItem = page.items.find((item) => item.path === original.path);
    const copyItem = page.items.find((item) => item.path === copy);
    expect(originalItem?.reason).toBe("duplicate-id");
    expect(copyItem?.reason).toBe("duplicate-id");
    expect(originalItem?.otherPaths).toContain(copy);
    expect(copyItem?.otherPaths).toContain(original.path);

    for (const filter of ["all", "today", "upcoming", "overdue", "blocked", "completed"] as const) {
      expect(await listIds(service, filter), filter).not.toContain(original.id);
    }
    expect((await detail(service, original.id)).status).toBe(404);
    const day = utcDay(new Date());
    const withoutBoth = vault.tasks.filter((task) => task.id !== original.id);
    expect(await counts(service)).toEqual(expectedCounts(withoutBoth, "all", day));

    // Nothing was minted, renamed, deleted or modified.
    await new Promise((resolve) => setTimeout(resolve, 6_500));
    const after = hashVaultFiles(vault.vaultRoot);
    expect(Object.keys(after).sort()).toEqual(Object.keys(withCopy).sort());
    for (const path of Object.keys(after)) {
      if (path.endsWith("/tasks/index.md")) continue;
      expect(after[path], path).toBe(withCopy[path]);
    }
    expect(withCopy[original.path]).toBe(before[original.path]);
    expect(read(vault, copy)).toBe(read(vault, original.path));
    expect(existsSync(join(vault.vaultRoot, ...original.path.split("/")))).toBe(true);
  }, 120_000);
});

describe("completion through the plugin write path (Task 3, Test 7, TASK-08, T-06-24)", () => {
  let fixture: Fixture;
  beforeAll(async () => {
    fixture = await open(30);
  }, 120_000);
  afterAll(() => shut(fixture), 60_000);

  it("changes only that note and creates no approval proposal", async () => {
    const { vault, service } = fixture;
    const target = firstOfKind(vault, "today-date");
    const before = hashVaultFiles(vault.vaultRoot);
    const approvalsBefore = await service.get<ApprovalsSnapshot>(APPROVAL_LIST_PATH);
    expect(approvalsBefore.body.counts).toEqual({ pending: 0, decided: 0, expired: 0 });

    const now = new Date().toISOString();
    const result = await completeTask(
      {
        vault: fileSystemTaskVault(vault.vaultRoot),
        changed: (path) => changed(service, [path]),
      },
      { file: { path: target.path } },
      now,
    );
    expect(result.kind).toBe("applied");

    const after = hashVaultFiles(vault.vaultRoot);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    const differing = Object.keys(after).filter((path) => after[path] !== before[path]);
    expect(differing).toEqual([target.path]);

    const parsed = parseTaskNote(read(vault, target.path));
    expect(parsed.frontmatter.status).toBe("done");
    expect(parsed.frontmatter.completed).toBe(now);
    expect(parsed.frontmatter.updated).toBe(now);

    const row = await detail(service, target.id);
    expect((row.body as TaskGetResponse).task.row.status).toBe("done");
    expect(await listIds(service, "completed")).toContain(target.id);

    const approvalsAfter = await service.get<ApprovalsSnapshot>(APPROVAL_LIST_PATH);
    expect(approvalsAfter.body.pending).toEqual([]);
    expect(approvalsAfter.body.counts).toEqual({ pending: 0, decided: 0, expired: 0 });
  }, 120_000);
});

describe("tasks suggested by an automation (Task 3, Test 8, TASK-04, TASK-05, D-36)", () => {
  let fixture: Fixture;
  beforeAll(async () => {
    fixture = await open(24, false);
  }, 120_000);
  afterAll(() => shut(fixture), 60_000);

  const propose = (vault: GeneratedTaskVault, title: string, extra: Record<string, unknown>) => {
    const written = writeTaskNote({
      vaultRoot: vault.vaultRoot,
      scope: "global",
      title,
      body: "Suggested by the daily brief.\n",
      intent: "proposed",
      assignee: "automation",
      sourceType: "automation",
      generatedBy: { automation: "daily-brief" },
      aiGenerated: true,
      claimType: "recommendation",
      ...extra,
    });
    return written;
  };

  it("keeps a proposed task out of every actionable view until it is accepted, then records the decision", async () => {
    const { vault, service } = fixture;
    const anchor = firstOfKind(vault, "undated");
    const project = vault.tasks.find((task) => task.projectId !== undefined)?.projectId;
    const today = utcDay(new Date()).localDate;
    const accepted = propose(vault, "Suggested: plan the offsite", {
      due: today,
      projectId: project,
      dependencies: [anchor.id],
    });
    const dismissed = propose(vault, "Suggested: reorganise the archive", { due: today });
    expect((await changed(service, [accepted.path, dismissed.path])).status).toBe(200);

    const actionable = ["today", "upcoming", "overdue", "project", "blocked", "completed"] as const;
    for (const filter of actionable) {
      const ids = await listIds(service, filter);
      expect(ids, filter).not.toContain(accepted.id);
      expect(ids, filter).not.toContain(dismissed.id);
    }
    const proposedIds = await listIds(service, "proposed");
    expect(proposedIds).toContain(accepted.id);
    expect(proposedIds).toContain(dismissed.id);
    const everything = await listIds(service, "all");
    expect(everything).toContain(accepted.id);
    expect(everything).toContain(dismissed.id);
    const feed = (await service.post<TaskDueTodayResponse>(TASK_DUE_TODAY_PATH, { zone: ZONE }))
      .body;
    const feedIds = [...feed.due, ...feed.overdue].map((row) => row.taskId);
    expect(feedIds).not.toContain(accepted.id);
    expect(feedIds).not.toContain(dismissed.id);
    const before = await counts(service);
    expect(before.counts.proposed).toBe(2);
    expect(before.counts.all).toBe(26);
    expect(before.open).toBe(expectedCounts(vault.tasks, "all", utcDay(new Date())).open);

    const deps = {
      vault: fileSystemTaskVault(vault.vaultRoot),
      changed: (path: string) => changed(service, [path]),
    };
    const acceptedAt = new Date().toISOString();
    const acceptResult = await acceptTask(deps, { file: { path: accepted.path } }, acceptedAt);
    expect(acceptResult.kind).toBe("applied");
    const acceptedNote = parseTaskNote(read(vault, accepted.path));
    expect(acceptedNote.frontmatter.status).toBe("ready");
    expect(acceptedNote.frontmatter.decision).toEqual({ outcome: "accepted", at: acceptedAt });
    const acceptedRow = (await detail(service, accepted.id)).body as TaskGetResponse;
    expect(acceptedRow.task.row.status).toBe("ready");
    expect(acceptedRow.task.decision).toEqual({ outcome: "accepted", at: acceptedAt });
    expect(await listIds(service, "today")).toContain(accepted.id);
    expect(await listIds(service, "blocked")).toContain(accepted.id);
    expect(await listIds(service, "proposed")).not.toContain(accepted.id);

    const dismissedAt = new Date().toISOString();
    const dismissResult = await dismissTask(deps, { file: { path: dismissed.path } }, dismissedAt);
    expect(dismissResult.kind).toBe("applied");
    const dismissedNote = parseTaskNote(read(vault, dismissed.path));
    expect(dismissedNote.frontmatter.status).toBe("cancelled");
    expect(dismissedNote.frontmatter.decision).toEqual({ outcome: "dismissed", at: dismissedAt });
    const dismissedRow = (await detail(service, dismissed.id)).body as TaskGetResponse;
    expect(dismissedRow.task.row.status).toBe("cancelled");
    expect(dismissedRow.task.decision).toEqual({ outcome: "dismissed", at: dismissedAt });
    expect(await listIds(service, "all")).toContain(dismissed.id);
    for (const filter of ["proposed", "today", "completed", "blocked"] as const) {
      expect(await listIds(service, filter), filter).not.toContain(dismissed.id);
    }
    expect((await counts(service)).counts.proposed).toBe(0);
  }, 120_000);
});
