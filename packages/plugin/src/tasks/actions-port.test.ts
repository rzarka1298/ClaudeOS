import { afterEach, describe, expect, it, vi } from "vitest";
import { configureTaskActionsPort, type TaskActionsPort, taskActionsPort } from "./actions-port.js";

afterEach(() => configureTaskActionsPort(null));

function fakePort(): TaskActionsPort {
  return {
    complete: vi.fn(() => Promise.resolve({ kind: "conflict" as const })),
    reopen: vi.fn(() => Promise.resolve({ kind: "conflict" as const })),
    accept: vi.fn(() => Promise.resolve({ kind: "conflict" as const })),
    dismiss: vi.fn(() => Promise.resolve({ kind: "conflict" as const })),
    save: vi.fn(() => Promise.resolve({ kind: "conflict" as const })),
    readForEdit: vi.fn(() =>
      Promise.resolve({ kind: "unreadable" as const, reason: "no-frontmatter" as const }),
    ),
    openNote: vi.fn(),
  };
}

describe("Test 5: the actions port holder", () => {
  it("answers the note-unavailable outcome until configured", async () => {
    const port = taskActionsPort();
    const target = { path: "global/tasks/example-task-3f2a.md" };
    for (const result of await Promise.all([
      port.complete(target),
      port.reopen(target),
      port.accept(target),
      port.dismiss(target),
      port.save(target, { zone: "UTC" }),
      port.readForEdit(target.path),
    ])) {
      expect(result).toEqual({ kind: "unreadable", reason: "read-failed" });
    }
    expect(() => port.openNote(target.path)).not.toThrow();
  });

  it("delegates to the configured port and back to the default when cleared", async () => {
    const fake = fakePort();
    configureTaskActionsPort(fake);
    const target = { path: "global/tasks/example-task-3f2a.md", expectedPriorContent: "x" };
    expect(await taskActionsPort().complete(target)).toEqual({ kind: "conflict" });
    await taskActionsPort().save(target, { zone: "UTC", title: "T" });
    taskActionsPort().openNote(target.path);
    expect(fake.complete).toHaveBeenCalledWith(target);
    expect(fake.save).toHaveBeenCalledWith(target, { zone: "UTC", title: "T" });
    expect(fake.openNote).toHaveBeenCalledWith(target.path);
    configureTaskActionsPort(null);
    expect(await taskActionsPort().complete(target)).toEqual({
      kind: "unreadable",
      reason: "read-failed",
    });
  });

  it("exposes complete, reopen, accept, dismiss, save, read-for-edit and open-note only", () => {
    expect(Object.keys(taskActionsPort()).sort()).toEqual(
      ["accept", "complete", "dismiss", "openNote", "readForEdit", "reopen", "save"].sort(),
    );
  });
});
