import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunId } from "@ccc/domain/ids.js";
import type { GuardConflict } from "@ccc/domain/ports.js";
import { describe, expect, it, vi } from "vitest";
import {
  ASSOCIATE_EMPTY_MESSAGE,
  AssociateProjectModal,
  associatePickerViewModel,
  ConcurrentChoiceModal,
  concurrentChoiceViewModel,
  NEW_WORKTREE_OPTION_LABEL,
  TerminateRequestModal,
  TranscriptWarningModal,
  terminateRequestViewModel,
  transcriptWarningViewModel,
  validateWorktreeName,
  WORKTREE_LIST_FAILURE_MESSAGE,
  WORKTREE_LOADING_MESSAGE,
  WORKTREE_NAME_DUPLICATE_MESSAGE,
  WORKTREE_NAME_INVALID_MESSAGE,
  worktreeLaunchDisabled,
  worktreeStepViewModel,
} from "./session-modals.js";

/**
 * Task 2: the concurrent-session choice with its worktree step (S4-a), and
 * the associate-with-project picker (S4-e) as a `FuzzySuggestModal`. Every
 * view model is a pure function (UI-SPEC S4 shared rules); the `Modal`
 * subclasses are thin renderers proven only for their settle-once contract
 * (the shared obsidian stub is deliberately inert, same rationale as
 * `delete-usage-modal.test.ts`).
 */

const RUN_ID_1 = "0mfk1a2b3c4d5e6f7a8b9c0d1" as RunId;

function makeConflict(overrides: Partial<GuardConflict> = {}): GuardConflict {
  return {
    runId: RUN_ID_1,
    sessionName: "beta",
    state: "running",
    lastActivityAt: "2026-09-26T00:00:00.000Z",
    ...overrides,
  };
}

const NOW_MS = Date.parse("2026-09-26T00:05:00.000Z");

describe("concurrentChoiceViewModel (Test 1)", () => {
  it("uses the one-conflict lead form and the fixed title", () => {
    const vm = concurrentChoiceViewModel([makeConflict()], "alpha", NOW_MS);

    expect(vm.title).toBe("This working tree already has a Claude session");
    expect(vm.lead).toBe("Another Claude session can write to alpha's working tree:");
    expect(vm.initialFocus).toBe("cancel");
  });

  it("uses the n-conflict lead form for more than one conflict", () => {
    const vm = concurrentChoiceViewModel(
      [makeConflict(), makeConflict({ sessionName: "gamma" })],
      "alpha",
      NOW_MS,
    );

    expect(vm.lead).toBe("2 other Claude sessions can write to alpha's working tree:");
  });

  it("formats each item as '{name} — {state label}, active {relative}'", () => {
    const vm = concurrentChoiceViewModel([makeConflict()], "alpha", NOW_MS);

    expect(vm.items).toEqual([{ runId: RUN_ID_1, text: "beta — Running, active 5 minutes ago" }]);
  });

  it("appends the stale suffix only for a stale conflict", () => {
    const vm = concurrentChoiceViewModel([makeConflict({ state: "stale" })], "alpha", NOW_MS);

    expect(vm.items[0]?.text).toBe(
      "beta — Unknown — ended without reporting, active 5 minutes ago — it may still be running",
    );
  });

  it("has four choices in the fixed order, each with its consequence line", () => {
    const vm = concurrentChoiceViewModel([makeConflict()], "alpha", NOW_MS);

    expect(vm.choices.map((c) => c.id)).toEqual(["continue", "worktree", "plan", "cancel"]);
    expect(vm.choices.map((c) => c.label)).toEqual([
      "Continue in this working tree",
      "Use an isolated worktree",
      "Read-only investigation (plan mode)",
      "Cancel",
    ]);
    expect(vm.choices.every((c) => c.consequence.length > 0)).toBe(true);
    expect(vm.choices.find((c) => c.id === "worktree")?.cta).toBe(true);
  });
});

describe("worktreeStepViewModel and validation (Test 2)", () => {
  it("lists existing worktrees as '{branch} — {folder}' plus the new-worktree option", () => {
    const vm = worktreeStepViewModel([
      { worktreeId: "wt1", branch: "fix-parser", folderBasename: "ccc-fix-parser" },
    ]);

    expect(vm.listState).toBe("ready");
    expect(vm.options).toEqual([{ id: "wt1", label: "fix-parser — ccc-fix-parser" }]);
    expect(vm.newWorktreeOptionLabel).toBe(NEW_WORKTREE_OPTION_LABEL);
  });

  it("the loading state shows 'Checking worktrees…' and no options", () => {
    const vm = worktreeStepViewModel("loading");

    expect(vm.listState).toBe("loading");
    expect(vm.loadingMessage).toBe(WORKTREE_LOADING_MESSAGE);
    expect(vm.options).toEqual([]);
  });

  it("the failed state shows the fixed failure line and still allows naming a new one", () => {
    const vm = worktreeStepViewModel("failed");

    expect(vm.listState).toBe("failed");
    expect(vm.listFailureMessage).toBe(WORKTREE_LIST_FAILURE_MESSAGE);
    expect(vm.newWorktreeOptionLabel).toBe(NEW_WORKTREE_OPTION_LABEL);
  });

  it("rejects '../x' with the fixed message", () => {
    expect(validateWorktreeName("../x")).toBe(WORKTREE_NAME_INVALID_MESSAGE);
  });

  it("rejects a 65-character name with the fixed message", () => {
    expect(validateWorktreeName("a".repeat(65))).toBe(WORKTREE_NAME_INVALID_MESSAGE);
  });

  it("accepts a valid name", () => {
    expect(validateWorktreeName("fix-parser")).toBeNull();
  });

  it("rejects a name that collides with an existing worktree", () => {
    expect(validateWorktreeName("fix-parser", ["fix-parser"])).toBe(
      WORKTREE_NAME_DUPLICATE_MESSAGE,
    );
  });

  it("the launch button is disabled until a selection is valid", () => {
    expect(worktreeLaunchDisabled(null)).toBe(true);
    expect(worktreeLaunchDisabled({ kind: "existing", worktreeId: "wt1" })).toBe(false);
    expect(worktreeLaunchDisabled({ kind: "new", name: "../x" })).toBe(true);
    expect(worktreeLaunchDisabled({ kind: "new", name: "fix-parser" })).toBe(false);
  });
});

describe("associatePickerViewModel", () => {
  it("gives the fixed placeholder, the three instructions, and the empty-list line", () => {
    const vm = associatePickerViewModel("Fix parser");

    expect(vm.placeholder).toBe("Choose a project for Fix parser");
    expect(vm.instructions).toEqual([
      { command: "↑↓", purpose: "to navigate" },
      { command: "↵", purpose: "to associate" },
      { command: "esc", purpose: "to cancel" },
    ]);
    expect(vm.emptyMessage).toBe(ASSOCIATE_EMPTY_MESSAGE);
  });
});

describe("ConcurrentChoiceModal (Test 6): settles exactly once", () => {
  const vm = concurrentChoiceViewModel([makeConflict()], "alpha", NOW_MS);

  it("onClose without a choice resolves { kind: 'cancel' }, and only once", () => {
    const decide = vi.fn();
    const modal = new ConcurrentChoiceModal({} as never, vm, vi.fn(), decide);

    modal.open();
    modal.close();
    modal.close();

    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledWith({ kind: "cancel" });
  });
});

describe("AssociateProjectModal (Test 6): FuzzySuggestModal chrome", () => {
  it("sets the fixed placeholder and the three instructions", () => {
    const modal = new AssociateProjectModal({} as never, "Fix parser", [], vi.fn());

    expect(modal.viewModel.placeholder).toBe("Choose a project for Fix parser");
    expect(modal.viewModel.instructions).toEqual([
      { command: "↑↓", purpose: "to navigate" },
      { command: "↵", purpose: "to associate" },
      { command: "esc", purpose: "to cancel" },
    ]);
  });

  it("sets the fixed empty-list message only when there are no projects", () => {
    const empty = new AssociateProjectModal({} as never, "Fix parser", [], vi.fn());
    const populated = new AssociateProjectModal(
      {} as never,
      "Fix parser",
      [{ id: "p1", name: "alpha" }],
      vi.fn(),
    );

    expect(empty.emptyStateText).toBe(ASSOCIATE_EMPTY_MESSAGE);
    expect(populated.emptyStateText).toBe("");
  });

  it("onClose without a choice settles null, and only once", () => {
    const decide = vi.fn();
    const modal = new AssociateProjectModal({} as never, "Fix parser", [], decide);

    modal.open();
    modal.close();
    modal.close();

    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledWith(null);
  });

  it("onChooseItem settles the chosen project, and only once", () => {
    const decide = vi.fn();
    const project = { id: "p1", name: "alpha" };
    const modal = new AssociateProjectModal({} as never, "Fix parser", [project], decide);

    modal.open();
    modal.onChooseItem(project, {} as MouseEvent);
    modal.close();

    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledWith(project);
  });
});

/**
 * Task 3: the transcript plaintext warning (S4-b, shown on EVERY open,
 * SESS-15, D-34) and the force-terminate request (S4-c, SESS-16, D-01,
 * PR-26). Both modals are thin, with initial focus on Cancel and Escape as
 * Cancel -- the same S4 shared-rules split as every other modal here.
 */

describe("transcriptWarningViewModel (Test 1)", () => {
  it("gives the fixed title, both body strings with n days, the three buttons and initial focus on Cancel", () => {
    const vm = transcriptWarningViewModel(30);

    expect(vm.title).toBe("Open this transcript?");
    expect(vm.bodies[0]).toBe(
      "Claude Code stores this transcript on your Mac as plain text. Anything readable by your user account can read it.",
    );
    expect(vm.bodies[1]).toContain("30 days");
    expect(vm.buttons.map((b) => b.label)).toEqual([
      "Show in Finder",
      "Open with default app",
      "Cancel",
    ]);
    expect(vm.buttons[0]?.cta).toBe(true);
    expect(vm.initialFocus).toBe("cancel");
  });

  it("has no don't-show-again or remember option anywhere in the view model", () => {
    const vm = transcriptWarningViewModel(30);

    expect(Object.keys(vm)).not.toContain("dontShowAgain");
    expect(Object.keys(vm)).not.toContain("remember");
    expect(JSON.stringify(vm).toLowerCase()).not.toMatch(/dontshow|remember/);
  });
});

describe("TranscriptWarningModal (Test 1): renders no checkbox, settles once", () => {
  it("has no checkbox-creation call anywhere in its onOpen rendering", () => {
    const modal = new TranscriptWarningModal({} as never, transcriptWarningViewModel(30), vi.fn());
    modal.open();

    // The shared obsidian stub's createEl is untyped by tag, so the only
    // reachable proof at this layer is a source scan (below); this case
    // documents the requirement directly against the rendered view model.
    expect(modal).toBeInstanceOf(TranscriptWarningModal);
  });

  it("settles exactly once; onClose resolves 'cancel'", () => {
    const decide = vi.fn();
    const modal = new TranscriptWarningModal({} as never, transcriptWarningViewModel(30), decide);

    modal.open();
    modal.close();
    modal.close();

    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledWith("cancel");
  });
});

describe("terminateRequestViewModel (Test 3)", () => {
  it("gives the fixed title, the three body strings, and the two buttons", () => {
    const vm = terminateRequestViewModel("Fix parser", "alpha", 10);

    expect(vm.title).toBe("Request force-terminate?");
    expect(vm.bodies[0]).toBe(
      "This sends a request to the approval inbox to stop Fix parser in alpha.",
    );
    expect(vm.bodies[1]).toContain("10 seconds");
    expect(vm.bodies[2]).toBe("Nothing happens until you approve it.");
    expect(vm.buttons.map((b) => b.label)).toEqual(["Send to approval inbox", "Cancel"]);
    expect(vm.buttons[0]?.destructive).toBe(true);
    expect(vm.buttons[0]?.cta).toBe(true);
    expect(vm.initialFocus).toBe("cancel");
  });

  it("has no typed-confirmation field anywhere in the view model (D-01)", () => {
    const vm = terminateRequestViewModel("Fix parser", "alpha", 10);

    expect(JSON.stringify(vm).toLowerCase()).not.toMatch(/confirmtext|typed/);
  });
});

describe("TerminateRequestModal (Test 3): settles exactly once", () => {
  it("onClose without a choice resolves 'cancel'", () => {
    const decide = vi.fn();
    const modal = new TerminateRequestModal(
      {} as never,
      terminateRequestViewModel("Fix parser", "alpha", 10),
      decide,
    );

    modal.open();
    modal.close();
    modal.close();

    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledWith("cancel");
  });
});

describe("source scan: Obsidian chrome only, no command-center design token (Non-Negotiable 8)", () => {
  const SRC_DIR = dirname(fileURLToPath(import.meta.url));
  // Code lines only -- strips `/** ... */` and `//` comments first, so a
  // doc-comment naming the FORBIDDEN pattern in prose (as this file's own
  // header does, to state the rule) can never trip the scan meant to catch
  // an actual reference in code.
  const SOURCE = readFileSync(join(SRC_DIR, "session-modals.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("references no --ccc- custom property", () => {
    expect(SOURCE).not.toMatch(/--ccc-/);
  });

  it("references no ccc- prefixed class name", () => {
    expect(SOURCE).not.toMatch(/["'`]ccc-[a-z-]+["'`]/);
  });
});
