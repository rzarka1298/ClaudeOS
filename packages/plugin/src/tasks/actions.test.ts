// Plan 06-18, Task 2: accept, dismiss, reopen and save (D-36, TASK-04, TASK-05,
// UI-SPEC R-17). The fake vault holds hand-written notes, so no expectation is
// produced by the code under test.
import { describe, expect, it, vi } from "vitest";
import { FakeVault } from "../test-support/fake-obsidian-host.js";
import {
  COMPLETED_NOTE,
  NOW,
  OPEN_BODY,
  OPEN_NOTE,
  TASK_PATH,
  taskEditVault,
} from "../test-support/task-note-fixtures.js";
import {
  acceptTask,
  completeTask,
  dismissTask,
  reopenTask,
  saveTask,
  type TaskActionResult,
} from "./actions.js";
import { parseTaskContent } from "./task-update.js";

const PROPOSED_NOTE = OPEN_NOTE.replace("status: ready", "status: proposed");

function setup(content: string) {
  const vault = new FakeVault({ [TASK_PATH]: content });
  const changed = vi.fn((_path: string) => Promise.resolve({ accepted: 1, generation: 1 }));
  return {
    vault,
    changed,
    deps: { vault: taskEditVault(vault), changed },
    target: { file: vault.file(TASK_PATH) },
  };
}

function parsed(vault: FakeVault) {
  const result = parseTaskContent(vault.read(TASK_PATH));
  if (result.kind !== "ok") throw new Error(`unreadable: ${result.reason}`);
  return result.task;
}

describe("Test 1: accept, dismiss and reopen", () => {
  it("accept sets ready and records the decision as accepted with its time", async () => {
    const { vault, deps, target, changed } = setup(PROPOSED_NOTE);
    const result = await acceptTask(deps, target, NOW);
    expect(result.kind).toBe("applied");
    const task = parsed(vault);
    expect(task.frontmatter.status).toBe("ready");
    expect(task.frontmatter.decision).toEqual({ outcome: "accepted", at: NOW });
    expect(task.frontmatter.updated).toBe(NOW);
    expect(task.body).toBe(OPEN_BODY);
    expect(task.passthrough.map(([key]) => key)).toEqual(["zeta", "aliases", "cssclasses"]);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledWith(TASK_PATH);
  });

  it("dismiss sets cancelled, records the decision as dismissed with its time and keeps the note", async () => {
    const { vault, deps, target } = setup(PROPOSED_NOTE);
    const result = await dismissTask(deps, target, NOW);
    expect(result.kind).toBe("applied");
    const task = parsed(vault);
    expect(task.frontmatter.status).toBe("cancelled");
    expect(task.frontmatter.decision).toEqual({ outcome: "dismissed", at: NOW });
    expect(task.body).toBe(OPEN_BODY);
  });

  it("reopen sets ready and clears completed", async () => {
    const { vault, deps, target } = setup(COMPLETED_NOTE);
    const result = await reopenTask(deps, target, "2026-10-07T08:00:00.000Z");
    expect(result.kind).toBe("applied");
    const task = parsed(vault);
    expect(task.frontmatter.status).toBe("ready");
    expect(task.frontmatter.completed).toBeUndefined();
    expect(task.frontmatter.updated).toBe("2026-10-07T08:00:00.000Z");
    expect(task.body).toBe(OPEN_BODY);
  });

  it("returns conflict (telling the service the path changed) or unreadable (no write, no notice)", async () => {
    for (const action of [acceptTask, dismissTask, reopenTask]) {
      const base = action === reopenTask ? COMPLETED_NOTE : PROPOSED_NOTE;
      const conflicted = setup(base);
      conflicted.vault.setExternally(TASK_PATH, `${base}typed\n`);
      const conflict: TaskActionResult = await action(
        conflicted.deps,
        { ...conflicted.target, expectedPriorContent: base },
        NOW,
      );
      expect(conflict).toEqual({ kind: "conflict" });
      // M1 case A: the external edit's event may have been dropped as an echo.
      expect(conflicted.changed).toHaveBeenCalledTimes(1);
      expect(conflicted.changed).toHaveBeenCalledWith(TASK_PATH);

      const broken = setup("not a task");
      const unreadable = await action(broken.deps, broken.target, NOW);
      expect(unreadable.kind).toBe("unreadable");
      expect(broken.changed).not.toHaveBeenCalled();
    }
  });
});

describe("Test 2: save applies only the edited fields", () => {
  it("changes the title and priority and leaves every other field, the body and passthrough keys alone", async () => {
    const { vault, deps, target } = setup(OPEN_NOTE);
    const before = parsed(vault).frontmatter;
    const result = await saveTask(deps, target, NOW, {
      zone: "America/New_York",
      title: "Draft the monthly review",
      priority: "urgent",
    });
    expect(result.kind).toBe("applied");
    const after = parsed(vault);
    expect(after.frontmatter).toEqual({
      ...before,
      title: "Draft the monthly review",
      priority: "urgent",
      updated: NOW,
    });
    expect(after.body).toBe(OPEN_BODY);
  });

  it("Done sets completed when it was empty, keeps an existing one, and leaving Done clears it (R-17)", async () => {
    const done = setup(OPEN_NOTE);
    await saveTask(done.deps, done.target, NOW, { zone: "UTC", status: "done" });
    expect(parsed(done.vault).frontmatter.completed).toBe(NOW);

    const already = setup(COMPLETED_NOTE);
    await saveTask(already.deps, already.target, "2026-10-09T00:00:00.000Z", {
      zone: "UTC",
      status: "done",
      title: "Renamed",
    });
    expect(parsed(already.vault).frontmatter.completed).toBe(NOW);

    const left = setup(COMPLETED_NOTE);
    await saveTask(left.deps, left.target, "2026-10-09T00:00:00.000Z", {
      zone: "UTC",
      status: "in-progress",
    });
    const task = parsed(left.vault).frontmatter;
    expect(task.status).toBe("in-progress");
    expect(task.completed).toBeUndefined();
  });

  it("clears an empty due, keeps a date-only due a date and turns a due with a time into an offset instant", async () => {
    const cleared = setup(OPEN_NOTE);
    await saveTask(cleared.deps, cleared.target, NOW, { zone: "UTC", due: { date: "" } });
    expect(parsed(cleared.vault).frontmatter.due).toBeUndefined();

    const dateOnly = setup(OPEN_NOTE);
    await saveTask(dateOnly.deps, dateOnly.target, NOW, {
      zone: "America/New_York",
      due: { date: "2026-10-12" },
      scheduled: { date: "2026-10-11" },
    });
    expect(parsed(dateOnly.vault).frontmatter.due).toBe("2026-10-12");
    expect(parsed(dateOnly.vault).frontmatter.scheduled).toBe("2026-10-11");

    const timed = setup(OPEN_NOTE);
    await saveTask(timed.deps, timed.target, NOW, {
      zone: "America/New_York",
      due: { date: "2026-10-12", time: "15:30" },
    });
    expect(parsed(timed.vault).frontmatter.due).toBe("2026-10-12T15:30:00-04:00");
  });

  it("trims, deduplicates and bounds tags, and applies project and description edits", async () => {
    const { vault, deps, target } = setup(OPEN_NOTE);
    const projectId = "mfz0a1b2c0123456789abcdef";
    await saveTask(deps, target, NOW, {
      zone: "UTC",
      tags: [" work ", "#work", "q4/plan", ""],
      projectId,
      description: "Rewritten.\n",
    });
    const task = parsed(vault);
    expect(task.frontmatter.tags).toEqual(["work", "q4/plan"]);
    expect(task.frontmatter.projectId).toBe(projectId);
    expect(task.body).toBe("Rewritten.\n");
  });

  it("returns a field-keyed validation result before any write", async () => {
    const { vault, deps, target, changed } = setup(OPEN_NOTE);
    const result = await saveTask(deps, target, NOW, {
      zone: "UTC",
      title: "",
      due: { date: "2026-02-31" },
      tags: ["has space", ...Array.from({ length: 25 }, (_, i) => `t${i}x`)],
    });
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(Object.keys(result.fields).sort()).toEqual(["due", "tags", "title"]);
    }
    expect(vault.processCallCount).toBe(0);
    expect(vault.read(TASK_PATH)).toBe(OPEN_NOTE);
    expect(changed).not.toHaveBeenCalled();

    const badTime = setup(OPEN_NOTE);
    const time = await saveTask(badTime.deps, badTime.target, NOW, {
      zone: "UTC",
      due: { date: "2026-10-12", time: "25:99" },
    });
    expect(time).toEqual({ kind: "invalid", fields: { due: "invalid-time" } });
  });
});

describe("M2: allowed-from status guards read the fresh note", () => {
  const withStatus = (status: string) => OPEN_NOTE.replace("status: ready", `status: ${status}`);
  const cases: ReadonlyArray<
    readonly [string, typeof acceptTask, readonly string[], readonly string[]]
  > = [
    [
      "accept",
      acceptTask,
      ["proposed"],
      ["inbox", "ready", "in-progress", "blocked", "done", "cancelled"],
    ],
    [
      "dismiss",
      dismissTask,
      ["proposed"],
      ["inbox", "ready", "in-progress", "blocked", "done", "cancelled"],
    ],
    [
      "reopen",
      reopenTask,
      ["done", "cancelled"],
      ["inbox", "proposed", "ready", "in-progress", "blocked"],
    ],
    [
      "complete",
      completeTask,
      ["inbox", "ready", "in-progress", "blocked"],
      ["proposed", "done", "cancelled"],
    ],
  ];
  for (const [name, action, allowed, refused] of cases) {
    it(`${name} applies from ${allowed.join("/")} only`, async () => {
      for (const status of allowed) {
        const note = status === "done" ? COMPLETED_NOTE : withStatus(status);
        const { deps, target } = setup(note);
        expect((await action(deps, target, NOW)).kind).toBe("applied");
      }
      for (const status of refused) {
        const note = status === "done" ? COMPLETED_NOTE : withStatus(status);
        const { vault, deps, target, changed } = setup(note);
        const result = await action(deps, target, NOW);
        expect(result).toEqual({ kind: "invalid", fields: { status: "stale-status" } });
        expect(vault.read(TASK_PATH)).toBe(note);
        expect(changed).toHaveBeenCalledWith(TASK_PATH);
      }
    });
  }
});
