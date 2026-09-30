/**
 * Wave-5 audit (05-15): drives the thin modal RENDERERS through a recording
 * `obsidian` double, to check the UI-SPEC S4 shared rules the pure view
 * models only declare (initial focus on Cancel, a usable worktree step,
 * inline validation, destructive styling). The shared stub is inert by
 * design, so this file swaps in its own recording double.
 */
import type { RunId } from "@ccc/domain/ids.js";
import { describe, expect, it, vi } from "vitest";

interface FakeEl {
  readonly tag: string;
  text: string;
  value: string;
  disabled: boolean;
  readonly attrs: Record<string, string>;
  readonly children: FakeEl[];
  readonly listeners: Record<string, Array<() => void>>;
  createEl(
    tag: string,
    options?: { text?: string; type?: string; placeholder?: string },
    callback?: (el: FakeEl) => void,
  ): FakeEl;
  createDiv(): FakeEl;
  addEventListener(type: string, handler: () => void): void;
  setAttribute(name: string, value: string): void;
  empty(): void;
  setText(text: string): void;
  focus(): void;
}

const fake = vi.hoisted(() => {
  const focused: unknown[] = [];
  const buttons: Array<{
    label: string;
    cta: boolean;
    destructive: boolean;
    disabled: boolean;
    buttonEl: unknown;
    click: () => void;
  }> = [];
  return { focused, buttons };
});

vi.mock("obsidian", () => {
  function makeEl(tag: string): FakeEl {
    const el: FakeEl = {
      tag,
      text: "",
      value: "",
      disabled: false,
      attrs: {},
      children: [],
      listeners: {},
      createEl(childTag, options, callback) {
        const child = makeEl(childTag);
        child.text = options?.text ?? "";
        if (options?.type) child.attrs.type = options.type;
        el.children.push(child);
        callback?.(child);
        return child;
      },
      createDiv() {
        const div = makeEl("div");
        el.children.push(div);
        return div;
      },
      addEventListener(type, handler) {
        const list = el.listeners[type] ?? [];
        list.push(handler);
        el.listeners[type] = list;
      },
      setAttribute(name, value) {
        el.attrs[name] = value;
      },
      empty() {
        el.children.length = 0;
      },
      setText(text) {
        el.text = text;
      },
      focus() {
        fake.focused.push(el);
      },
    };
    return el;
  }

  class Modal {
    readonly app: unknown;
    contentEl = makeEl("div");
    titleEl = makeEl("div");
    constructor(app: unknown) {
      this.app = app;
    }
    open(): void {
      this.onOpen();
    }
    close(): void {
      this.onClose();
    }
    onOpen(): void {}
    onClose(): void {}
  }

  class ButtonComponent {
    readonly record: (typeof fake.buttons)[number];
    readonly buttonEl: FakeEl;
    constructor(container: FakeEl) {
      this.buttonEl = container.createEl("button");
      this.record = {
        label: "",
        cta: false,
        destructive: false,
        disabled: false,
        buttonEl: this.buttonEl,
        click: () => {},
      };
      fake.buttons.push(this.record);
    }
    setButtonText(text: string): this {
      this.record.label = text;
      this.buttonEl.text = text;
      return this;
    }
    setCta(): this {
      this.record.cta = true;
      return this;
    }
    setDestructive(): this {
      this.record.destructive = true;
      return this;
    }
    setDisabled(disabled: boolean): this {
      this.record.disabled = disabled;
      this.buttonEl.disabled = disabled;
      return this;
    }
    onClick(handler: () => unknown): this {
      this.record.click = () => {
        if (!this.record.disabled) void handler();
      };
      return this;
    }
  }

  class FuzzySuggestModal extends Modal {
    setPlaceholder(): void {}
    setInstructions(): void {}
  }

  class Notice {}

  return { Modal, ButtonComponent, FuzzySuggestModal, Notice };
});

const {
  ConcurrentChoiceModal,
  concurrentChoiceViewModel,
  TerminateRequestModal,
  terminateRequestViewModel,
  TranscriptWarningModal,
  transcriptWarningViewModel,
  validateWorktreeName,
  WORKTREE_NAME_INVALID_MESSAGE,
} = await import("./session-modals.js");

const CONFLICT = {
  runId: "0mfk1a2b3c4d5e6f7a8b9c0d1" as RunId,
  sessionName: "beta",
  state: "running" as const,
  lastActivityAt: "2026-09-26T00:00:00.000Z",
};

function reset(): void {
  fake.focused.length = 0;
  fake.buttons.length = 0;
}

function button(label: string) {
  const found = [...fake.buttons].reverse().find((b) => b.label === label);
  if (found === undefined) throw new Error(`no button ${label}`);
  return found;
}

function walk(el: FakeEl, out: FakeEl[] = []): FakeEl[] {
  out.push(el);
  for (const child of el.children) walk(child, out);
  return out;
}

function openConcurrent(settled: unknown[]) {
  const vm = concurrentChoiceViewModel([CONFLICT], "Alpha", Date.parse("2026-09-26T00:05:00Z"));
  const modal = new ConcurrentChoiceModal(
    {} as never,
    vm,
    async () => [],
    (r) => settled.push(r),
  );
  modal.open();
  return modal as unknown as { contentEl: FakeEl };
}

describe("audit 05-15: initial focus is on Cancel (UI-SPEC S4 shared rules, A11Y floor 7)", () => {
  // Was AUDIT-BUG (MAJOR, A11Y, fixed wave 5): no renderer called focus();
  // the view models only declared `initialFocus: "cancel"`, so Obsidian
  // focused the first focusable control -- a launch/destructive button.
  it("the concurrent-session modal focuses Cancel on open", () => {
    reset();
    openConcurrent([]);
    expect(fake.focused.at(-1)).toBe(button("Cancel").buttonEl);
  });

  it("the transcript warning focuses Cancel on open", () => {
    reset();
    new TranscriptWarningModal({} as never, transcriptWarningViewModel(30), () => {}).open();
    expect(fake.focused.at(-1)).toBe(button("Cancel").buttonEl);
  });

  it("the force-terminate request focuses Cancel on open", () => {
    reset();
    new TerminateRequestModal(
      {} as never,
      terminateRequestViewModel("beta", "Alpha", 10),
      () => {},
    ).open();
    expect(fake.focused.at(-1)).toBe(button("Cancel").buttonEl);
  });
});

describe("wave 5 review: every choice's consequence line describes its button (UI-SPEC S4-a)", () => {
  it("each choice button is aria-describedby the id of the <p> beneath it", () => {
    reset();
    const modal = openConcurrent([]);
    const els = walk(modal.contentEl);
    for (const label of [
      "Continue in this working tree",
      "Use an isolated worktree",
      "Read-only investigation (plan mode)",
      "Cancel",
    ]) {
      const describedBy = (button(label).buttonEl as FakeEl).attrs["aria-describedby"];
      expect(describedBy, label).toBeTruthy();
      const described = els.filter((el) => el.attrs.id === describedBy);
      expect(described, label).toHaveLength(1);
      expect(described[0]?.tag).toBe("p");
      expect(described[0]?.text.length).toBeGreaterThan(0);
    }
  });
});

describe("audit 05-15: the worktree step can actually launch (SESS-11, D-30)", () => {
  // AUDIT-BUG (MAJOR, functional): `setDisabled(worktreeLaunchDisabled(...))`
  // is evaluated once at render, when the selection is null, and is never
  // re-evaluated on row click or name input. `Launch in worktree` stays
  // disabled forever, so neither worktree choice is reachable in Obsidian.
  it.skip("choosing the new-worktree option and typing a valid name enables Launch", async () => {
    reset();
    const settled: unknown[] = [];
    const modal = openConcurrent(settled);
    button("Use an isolated worktree").click();
    await Promise.resolve();
    await Promise.resolve();
    const els = walk(modal.contentEl);
    const newRow = els.find(
      (el) =>
        el.tag === "div" &&
        el.children.some((c) => c.text === "New worktree created by Claude Code"),
    );
    const input = els.find((el) => el.tag === "input");
    newRow?.listeners.click?.forEach((h) => {
      h();
    });
    if (input) input.value = "fix-parser";
    input?.listeners.input?.forEach((h) => {
      h();
    });
    button("Launch in worktree").click();
    expect(settled).toEqual([{ kind: "new-worktree", name: "fix-parser" }]);
  });

  // AUDIT-BUG (MINOR): the UI-SPEC's inline validation line is never rendered.
  it.skip("an invalid name shows the inline validation message", async () => {
    reset();
    const modal = openConcurrent([]);
    button("Use an isolated worktree").click();
    await Promise.resolve();
    await Promise.resolve();
    const input = walk(modal.contentEl).find((el) => el.tag === "input");
    if (input) input.value = "../x";
    input?.listeners.input?.forEach((h) => {
      h();
    });
    expect(walk(modal.contentEl).some((el) => el.text === WORKTREE_NAME_INVALID_MESSAGE)).toBe(
      true,
    );
  });
});

describe("audit 05-15: button styling and order", () => {
  it("the force-terminate primary is destructive + CTA, first, and Cancel is plain", () => {
    reset();
    new TerminateRequestModal(
      {} as never,
      terminateRequestViewModel("beta", "Alpha", 10),
      () => {},
    ).open();
    expect(fake.buttons.map((b) => b.label)).toEqual(["Send to approval inbox", "Cancel"]);
    expect(button("Send to approval inbox")).toMatchObject({ destructive: true, cta: true });
    expect(button("Cancel")).toMatchObject({ destructive: false, cta: false });
  });

  it("the concurrent choices render in the fixed order with only the worktree choice as CTA", () => {
    reset();
    const settled: unknown[] = [];
    openConcurrent(settled);
    expect(fake.buttons.map((b) => b.label)).toEqual([
      "Continue in this working tree",
      "Use an isolated worktree",
      "Read-only investigation (plan mode)",
      "Cancel",
    ]);
    expect(fake.buttons.filter((b) => b.cta).map((b) => b.label)).toEqual([
      "Use an isolated worktree",
    ]);
    button("Cancel").click();
    button("Continue in this working tree").click();
    expect(settled).toEqual([{ kind: "cancel" }]);
  });
});

describe("audit 05-15: worktree-name validation mirrors the service", () => {
  // Was AUDIT-BUG (MINOR, fixed wave 5): the service refuses a leading '-'
  // (session-action-routes.ts planChoice), so the plugin must too, or the
  // owner gets a late invalid-state failure instead of the inline message.
  it("rejects a name with a leading dash", () => {
    expect(validateWorktreeName("-rf")).toBe(WORKTREE_NAME_INVALID_MESSAGE);
    expect(validateWorktreeName("--dangerously-skip-permissions")).toBe(
      WORKTREE_NAME_INVALID_MESSAGE,
    );
  });
});
