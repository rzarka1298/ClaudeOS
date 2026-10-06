import { describe, expect, it, vi } from "vitest";
import {
  DELETE_USAGE_CANCEL_LABEL,
  DELETE_USAGE_CONFIRM_LABEL,
  DELETE_USAGE_MODAL_BODY_1,
  DELETE_USAGE_MODAL_TITLE,
  DeleteUsageModal,
  deleteUsageViewModel,
} from "./delete-usage-modal.js";

/**
 * Task 3: the delete-usage confirmation modal (UI-SPEC S4-d, D-46, USAGE-08).
 *
 * `deleteUsageViewModel` is the whole DECISION, testable without Obsidian's
 * DOM (the same split as `applyReducedMotionChange`); `DeleteUsageModal`
 * stays a thin renderer over it, proven through the shared obsidian stub.
 */

describe("deleteUsageViewModel (Test 1)", () => {
  it("returns the fixed title, both body strings, the two buttons and initial focus on Cancel", () => {
    const vm = deleteUsageViewModel("2026-08-01T00:00:00.000Z");

    expect(vm.title).toBe(DELETE_USAGE_MODAL_TITLE);
    expect(vm.bodies[0]).toBe(DELETE_USAGE_MODAL_BODY_1);
    expect(vm.bodies[1]).toContain("Aug 1, 2026");
    expect(vm.bodies[1]).not.toContain("/");
    expect(vm.bodies[0]).not.toContain("/");
    expect(vm.buttons).toEqual([
      { label: DELETE_USAGE_CONFIRM_LABEL, destructive: true },
      { label: DELETE_USAGE_CANCEL_LABEL, destructive: false },
    ]);
    expect(vm.initialFocus).toBe("cancel");
  });

  it("never invents a horizon date when none is known", () => {
    const vm = deleteUsageViewModel(null);

    expect(vm.bodies[1]).not.toContain("/");
    expect(vm.bodies[1]).not.toMatch(/\bundefined\b|\bnull\b|\bNaN\b/);
  });
});

describe("deleteUsageViewModel with transcript analysis on (wave 4)", () => {
  const RECOUNT =
    "Transcript analysis is on, so token counts will be recounted right away from the transcripts Claude Code still keeps.";

  it("says the counts are recounted right away while analysis is on", () => {
    const vm = deleteUsageViewModel("2026-08-01T00:00:00.000Z", true);
    expect(vm.bodies.join(" ")).toContain(RECOUNT);
    expect(vm.bodies[0]).toBe(DELETE_USAGE_MODAL_BODY_1);
  });

  it("keeps the current copy, unchanged, while analysis is off", () => {
    const off = deleteUsageViewModel("2026-08-01T00:00:00.000Z", false);
    expect(off.bodies.join(" ")).not.toContain(RECOUNT);
    expect(off).toEqual(deleteUsageViewModel("2026-08-01T00:00:00.000Z"));
  });
});

describe("DeleteUsageModal (Test 2)", () => {
  it("settles exactly once, and onClose without a choice resolves false", () => {
    const decide = vi.fn();
    const modal = new DeleteUsageModal({} as never, "2026-08-01T00:00:00.000Z", decide);

    modal.open();
    modal.close();
    modal.close(); // a second close must not re-fire the decision

    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledWith(false);
  });

  it("the confirm path settles true exactly once", () => {
    const decide = vi.fn();
    const modal = new DeleteUsageModal({} as never, "2026-08-01T00:00:00.000Z", decide);

    modal.open();
    modal.confirm();
    modal.close(); // confirm() already closed the modal; a further close must not re-fire

    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledWith(true);
  });
});
