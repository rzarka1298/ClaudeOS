import { VALID_HOSTILE_TASK_TITLES } from "@ccc/domain/task-corpus.js";
import type { TaskCreateRequest } from "@ccc/domain/tasks.js";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectIdFor, TASK_ZONE } from "../test-support/task-view-fixtures.js";
import {
  cleanTitle,
  EMPTY_FORM_VALUES,
  TaskCreateForm,
  type TaskCreateFormProps,
  validateCreateValues,
} from "./task-form.js";

afterEach(cleanup);

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const PROJECT = { id: projectIdFor(1), name: "Garden" };
const WORKSPACE = { id: "workspace:0mfk1a2b3000000000000000a", name: "Studio" };

function props(overrides: Partial<TaskCreateFormProps> = {}): TaskCreateFormProps {
  return {
    connected: true,
    zone: TASK_ZONE,
    projects: [PROJECT],
    workspaces: [WORKSPACE],
    create: vi.fn(() => Promise.resolve({})),
    onStatus: vi.fn(),
    onNotice: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

function control(label: string): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
  const found = screen.queryByLabelText(label);
  expect(found, `a control labelled ${label}`).not.toBeNull();
  return found as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
}

function button(name: string): HTMLButtonElement {
  const found = screen.queryByRole("button", { name });
  expect(found, `a button named ${name}`).not.toBeNull();
  return found as HTMLButtonElement;
}

function type(label: string, value: string): void {
  fireEvent.input(control(label), { target: { value } });
}

function formElement(): HTMLFormElement {
  const form = document.querySelector("form");
  expect(form, "a form element").not.toBeNull();
  return form as HTMLFormElement;
}

describe("Test 1: the create form fields", () => {
  it("renders every labelled field with its options and defaults", () => {
    render(<TaskCreateForm {...props({ defaultProjectId: PROJECT.id })} />);
    for (const label of [
      "Title",
      "Description",
      "Priority",
      "Due",
      "Due time",
      "Scheduled",
      "Project",
      "Scope",
      "Tags",
    ]) {
      control(label);
    }
    expect(control("Description").tagName).toBe("TEXTAREA");
    expect((control("Description") as HTMLTextAreaElement).rows).toBe(4);
    expect((control("Due") as HTMLInputElement).type).toBe("date");
    expect((control("Due time") as HTMLInputElement).type).toBe("time");
    expect((control("Scheduled") as HTMLInputElement).type).toBe("date");
    const priority = control("Priority") as HTMLSelectElement;
    expect([...priority.options].map((option) => option.text)).toEqual([
      "No priority",
      "Low",
      "Medium",
      "High",
      "Urgent",
    ]);
    expect(priority.options[priority.selectedIndex]?.text).toBe("No priority");
    const project = control("Project") as HTMLSelectElement;
    expect([...project.options].map((option) => option.text)).toEqual(["No project", "Garden"]);
    expect(project.value).toBe(PROJECT.id);
    const scope = control("Scope") as HTMLSelectElement;
    expect([...scope.options].map((option) => option.text)).toEqual(["Global", "Studio"]);
    expect(scope.value).toBe("global");
    expect(screen.queryByText("Separate tags with commas.")).not.toBeNull();
  });

  it("puts focus on Title when the form opens", async () => {
    render(<TaskCreateForm {...props()} />);
    await waitFor(() => expect(document.activeElement).toBe(control("Title")));
  });
});

describe("Test 2: the submit buttons", () => {
  it("has Add to inbox, Add as ready and Close form in that DOM order, the first being the default submit", () => {
    render(<TaskCreateForm {...props()} />);
    const names = [...formElement().querySelectorAll("button")].map(
      (element) => element.textContent,
    );
    expect(names).toEqual(["Add to inbox", "Add as ready", "Close form"]);
    expect(button("Add to inbox").type).toBe("submit");
    expect(button("Close form").type).toBe("button");
  });

  it("submits the inbox intent when the form is submitted by Enter in Title", () => {
    const create = vi.fn(() => Promise.resolve({}));
    render(<TaskCreateForm {...props({ create })} />);
    type("Title", "Pay rent");
    fireEvent.submit(formElement());
    expect(create).toHaveBeenCalledTimes(1);
    expect((create.mock.calls[0] as unknown as [TaskCreateRequest])[0].intent).toBe("inbox");
  });
});

describe("Test 3: the create call", () => {
  it("maps the fields to the domain request once, sets the status in the same event and holds both submits busy", async () => {
    const pending = deferred<unknown>();
    const create = vi.fn(() => pending.promise);
    const onStatus = vi.fn();
    render(<TaskCreateForm {...props({ create, onStatus })} />);
    type("Title", "  Write the report  ");
    type("Description", "Two pages.");
    fireEvent.change(control("Priority"), { target: { value: "high" } });
    type("Due", "2026-10-09");
    type("Due time", "14:30");
    type("Scheduled", "2026-10-08");
    fireEvent.change(control("Project"), { target: { value: PROJECT.id } });
    fireEvent.change(control("Scope"), { target: { value: WORKSPACE.id } });
    type("Tags", "work, deep");
    fireEvent.submit(formElement());

    expect(create).toHaveBeenCalledTimes(1);
    expect((create.mock.calls[0] as unknown as [TaskCreateRequest])[0]).toEqual({
      title: "Write the report",
      description: "Two pages.",
      intent: "inbox",
      zone: TASK_ZONE,
      dueDate: "2026-10-09",
      dueTime: "14:30",
      scheduledDate: "2026-10-08",
      scope: WORKSPACE.id,
      projectId: PROJECT.id,
      priority: "high",
      tags: ["work", "deep"],
    });
    expect(onStatus).toHaveBeenCalledWith("Adding the task…");

    await waitFor(() => {
      expect(button("Add to inbox").getAttribute("aria-busy")).toBe("true");
      expect(button("Add to inbox").getAttribute("aria-disabled")).toBe("true");
      expect(button("Add as ready").getAttribute("aria-busy")).toBe("true");
      expect(button("Add as ready").getAttribute("aria-disabled")).toBe("true");
    });
    pending.resolve({});
    await waitFor(() => expect(button("Add to inbox").getAttribute("aria-busy")).toBeNull());
  });
});

describe("Test 4: success", () => {
  it("announces, clears the form, keeps it open and returns focus to Title", async () => {
    const onStatus = vi.fn();
    const onNotice = vi.fn();
    const onClose = vi.fn();
    render(<TaskCreateForm {...props({ onStatus, onNotice, onClose })} />);
    type("Title", "Pay rent");
    type("Description", "Before Friday.");
    control("Description").focus();
    fireEvent.submit(formElement());
    await waitFor(() =>
      expect(onStatus).toHaveBeenLastCalledWith(
        'Added "Pay rent" to the inbox. Find it under All.',
      ),
    );
    expect(onNotice).toHaveBeenCalledWith('Added "Pay rent" to the inbox. Find it under All.');
    await waitFor(() => expect((control("Title") as HTMLInputElement).value).toBe(""));
    expect((control("Description") as HTMLTextAreaElement).value).toBe("");
    await waitFor(() => expect(document.activeElement).toBe(control("Title")));
    expect(onClose).not.toHaveBeenCalled();
  });
});

function firstRequest(create: { mock: { calls: unknown[][] } }): TaskCreateRequest {
  return (create.mock.calls[0] as unknown as [TaskCreateRequest])[0];
}

function errorFor(label: string): string | null {
  const input = control(label);
  const id = input.getAttribute("aria-describedby");
  if (id === null) return null;
  for (const part of id.split(" ")) {
    const element = document.getElementById(part);
    if (element?.classList.contains("ccc-field-error")) return element.textContent;
  }
  return null;
}

describe("Test 2.1: title validation", () => {
  it("cleans pasted whitespace and control characters", () => {
    expect(cleanTitle("line one\nline two")).toBe("line one line two");
    expect(cleanTitle("a\t\t b\r\n\r\nc")).toBe("a  b c");
    expect(cleanTitle("  padded  ")).toBe("padded");
    expect(cleanTitle("a\u0007b\u202Ec")).toBe("abc");
  });

  it("collapses a pasted newline into a space in the Title control", () => {
    render(<TaskCreateForm {...props()} />);
    const title = control("Title") as HTMLInputElement;
    fireEvent.paste(title, { clipboardData: { getData: () => "line one\nline two" } });
    expect(title.value).toBe("line one line two");
  });

  it("shows Enter a title. on submit, with aria-invalid and aria-describedby, and does not call create", () => {
    const create = vi.fn(() => Promise.resolve({}));
    render(<TaskCreateForm {...props({ create })} />);
    type("Title", "   ");
    fireEvent.submit(formElement());
    expect(create).not.toHaveBeenCalled();
    expect(errorFor("Title")).toBe("Enter a title.");
    expect(control("Title").getAttribute("aria-invalid")).toBe("true");
  });

  it("shows Use 200 characters or fewer. on blur and clears it when fixed", async () => {
    render(<TaskCreateForm {...props()} />);
    type("Title", "x".repeat(201));
    fireEvent.blur(control("Title"));
    await waitFor(() => expect(errorFor("Title")).toBe("Use 200 characters or fewer."));
    type("Title", "short");
    await waitFor(() => expect(errorFor("Title")).toBeNull());
    expect(control("Title").getAttribute("aria-invalid")).toBeNull();
  });
});

describe("Test 2.2: dates and time", () => {
  it("rejects a date that does not exist and a malformed one", () => {
    expect(validateCreateValues({ ...EMPTY_FORM_VALUES, title: "t", due: "2026-02-31" }).due).toBe(
      "Choose a valid date.",
    );
    expect(validateCreateValues({ ...EMPTY_FORM_VALUES, title: "t", due: "10/09/2026" }).due).toBe(
      "Choose a valid date.",
    );
    expect(
      validateCreateValues({ ...EMPTY_FORM_VALUES, title: "t", scheduled: "tomorrow" }).scheduled,
    ).toBe("Choose a valid date.");
    expect(
      validateCreateValues({ ...EMPTY_FORM_VALUES, title: "t", due: "2026-10-09" }).due,
    ).toBeUndefined();
  });

  it("shows Choose a valid date. for a time with no date", async () => {
    const create = vi.fn(() => Promise.resolve({}));
    render(<TaskCreateForm {...props({ create })} />);
    type("Title", "Call back");
    type("Due time", "10:00");
    fireEvent.submit(formElement());
    expect(create).not.toHaveBeenCalled();
    await waitFor(() => expect(errorFor("Due")).toBe("Choose a valid date."));
  });

  it("sends a date-only due for an all-day task and nothing for an empty due", () => {
    const create = vi.fn(() => Promise.resolve({}));
    render(<TaskCreateForm {...props({ create })} />);
    type("Title", "All day");
    type("Due", "2026-10-09");
    fireEvent.submit(formElement());
    const request = firstRequest(create);
    expect(request.dueDate).toBe("2026-10-09");
    expect("dueTime" in request).toBe(false);
  });
});

describe("Test 2.3: tags", () => {
  it("splits on commas, trims, drops empty ones and removes duplicates", () => {
    const create = vi.fn(() => Promise.resolve({}));
    render(<TaskCreateForm {...props({ create })} />);
    type("Title", "Tagged");
    type("Tags", " a, b ,, a ,#c, ");
    fireEvent.submit(formElement());
    expect(firstRequest(create).tags).toEqual(["a", "b", "c"]);
  });

  it("rejects more than 20 tags", () => {
    const tags = Array.from({ length: 21 }, (_, index) => `t${index}`).join(",");
    expect(validateCreateValues({ ...EMPTY_FORM_VALUES, title: "t", tags }).tags).toBe(
      "Use 20 tags or fewer.",
    );
    const twenty = Array.from({ length: 20 }, (_, index) => `t${index}`).join(",");
    expect(validateCreateValues({ ...EMPTY_FORM_VALUES, title: "t", tags: twenty }).tags).toBe(
      undefined,
    );
  });

  it("rejects a tag over 40 characters and a tag that breaks the Obsidian tag rules", () => {
    const tooLong = validateCreateValues({
      ...EMPTY_FORM_VALUES,
      title: "t",
      tags: "x".repeat(41),
    });
    expect(tooLong.tags).toBe("Use 40 characters or fewer for each tag.");
    const digits = validateCreateValues({ ...EMPTY_FORM_VALUES, title: "t", tags: "2026" });
    expect(digits.tags).toBe("Use letters, numbers, _, - or / in tags, and not only digits.");
    const spaced = validateCreateValues({ ...EMPTY_FORM_VALUES, title: "t", tags: "two words" });
    expect(spaced.tags).toBe("Use letters, numbers, _, - or / in tags, and not only digits.");
  });
});

describe("Test 2.4: Add as ready", () => {
  it("sends the ready intent and announces it", async () => {
    const create = vi.fn(() => Promise.resolve({}));
    const onStatus = vi.fn();
    render(<TaskCreateForm {...props({ create, onStatus })} />);
    type("Title", "Ship it");
    fireEvent.click(button("Add as ready"));
    expect(firstRequest(create).intent).toBe("ready");
    await waitFor(() =>
      expect(onStatus).toHaveBeenLastCalledWith('Added "Ship it" as ready. Find it under All.'),
    );
  });
});

describe("Test 2.5: failure", () => {
  const coded = (code: string): Error => Object.assign(new Error("secret detail"), { code });
  const reasons: readonly [string, Error, string][] = [
    ["timeout", coded("timeout"), "the companion service didn't respond within 5 seconds"],
    ["service-disconnected", coded("service-disconnected"), "the service isn't running"],
    ["unrecognised-response", coded("unrecognised-response"), "the service isn't running"],
    ["write-failed", coded("write-failed"), "the vault couldn't be written to"],
    ["no code", new Error("boom at /Users/USERNAME/secret"), "the vault couldn't be written to"],
  ];

  it.each(reasons)(
    "keeps the typed values and names a fixed reason for %s",
    async (_name, error, reason) => {
      // The rejection carries the closed code the way the tasks API error does.
      const create = vi.fn(() => Promise.reject(error));
      const onStatus = vi.fn();
      const onNotice = vi.fn();
      render(<TaskCreateForm {...props({ create, onStatus, onNotice })} />);
      type("Title", "Keep me");
      type("Description", "Typed text");
      fireEvent.submit(formElement());
      const expected = `Couldn't add the task: ${reason}.`;
      await waitFor(() => expect(onStatus).toHaveBeenLastCalledWith(expected));
      expect(onNotice).toHaveBeenCalledWith(expected);
      expect((control("Title") as HTMLInputElement).value).toBe("Keep me");
      expect((control("Description") as HTMLTextAreaElement).value).toBe("Typed text");
      await waitFor(() => expect(button("Add to inbox").getAttribute("aria-busy")).toBeNull());
      expect(button("Add to inbox").getAttribute("aria-disabled")).toBeNull();
      expect(JSON.stringify(onStatus.mock.calls)).not.toContain("secret");
    },
  );
});

describe("Test 2.6: close and focus", () => {
  it("closes on Escape and on Close form, returns focus to the opener and keeps the typed text", async () => {
    render(
      <button type="button" data-opener="true">
        Create a task
      </button>,
    );
    const opener = screen.getByRole("button", { name: "Create a task" });
    const onClose = vi.fn();
    render(<TaskCreateForm {...props({ onClose, getOpener: () => opener })} />);
    type("Title", "Half typed");
    fireEvent.keyDown(control("Title"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect((control("Title") as HTMLInputElement).value).toBe("Half typed");
    control("Title").focus();
    fireEvent.click(button("Close form"));
    expect(onClose).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});

describe("Test 2.7: preselection", () => {
  it("starts Project on the supplied project and keeps Scope editable", () => {
    render(
      <TaskCreateForm {...props({ defaultProjectId: PROJECT.id, defaultScope: WORKSPACE.id })} />,
    );
    expect((control("Project") as HTMLSelectElement).value).toBe(PROJECT.id);
    expect((control("Scope") as HTMLSelectElement).value).toBe(WORKSPACE.id);
    fireEvent.change(control("Scope"), { target: { value: "global" } });
    expect((control("Scope") as HTMLSelectElement).value).toBe("global");
  });

  it("cannot start on, or choose, an unregistered project", () => {
    const create = vi.fn(() => Promise.resolve({}));
    render(<TaskCreateForm {...props({ create, defaultProjectId: projectIdFor(9) })} />);
    expect((control("Project") as HTMLSelectElement).value).toBe("");
    type("Title", "No project");
    fireEvent.change(control("Project"), { target: { value: projectIdFor(9) } });
    fireEvent.submit(formElement());
    expect("projectId" in firstRequest(create)).toBe(false);
  });
});

describe("Test 2.8: disconnected", () => {
  it("disables both submits with the standard reason, does nothing on submit and still accepts typing", () => {
    const create = vi.fn(() => Promise.resolve({}));
    const onStatus = vi.fn();
    render(<TaskCreateForm {...props({ connected: false, create, onStatus })} />);
    for (const name of ["Add to inbox", "Add as ready"]) {
      const submit = button(name);
      expect(submit.getAttribute("aria-disabled")).toBe("true");
      expect(submit.hasAttribute("disabled")).toBe(false);
      const reasonId = submit.getAttribute("aria-describedby");
      expect(reasonId).not.toBeNull();
      expect(document.getElementById(reasonId as string)?.textContent).toBe(
        "The companion service isn't running.",
      );
    }
    type("Title", "Typed anyway");
    expect((control("Title") as HTMLInputElement).value).toBe("Typed anyway");
    fireEvent.submit(formElement());
    fireEvent.click(button("Add as ready"));
    expect(create).not.toHaveBeenCalled();
    expect(onStatus).not.toHaveBeenCalled();
    expect(button("Close form").getAttribute("aria-disabled")).toBeNull();
  });
});

describe("Test 2.9: hostile input", () => {
  it("sends the cleaned title as a string and announces it as text, never as markup", async () => {
    for (const title of VALID_HOSTILE_TASK_TITLES) {
      const create = vi.fn(() => Promise.resolve({}));
      const onStatus = vi.fn();
      const view = render(<TaskCreateForm {...props({ create, onStatus })} />);
      type("Title", title);
      fireEvent.submit(formElement());
      expect(create, title).toHaveBeenCalledTimes(1);
      expect(firstRequest(create).title).toBe(cleanTitle(title));
      await waitFor(() =>
        expect(onStatus).toHaveBeenLastCalledWith(
          `Added "${cleanTitle(title)}" to the inbox. Find it under All.`,
        ),
      );
      expect(view.container.querySelector("script, img, style, a, iframe")).toBeNull();
      view.unmount();
    }
  });
});

describe("Test 2.10: labels and order", () => {
  it("gives every control a visible label and tabs in the specified order", () => {
    render(<TaskCreateForm {...props()} />);
    const focusable = [
      ...formElement().querySelectorAll<HTMLElement>("input, select, textarea, button"),
    ];
    const names = focusable.map((element) =>
      element.tagName === "BUTTON"
        ? (element.textContent ?? "")
        : ((element as HTMLInputElement).labels?.[0]?.textContent ?? "NO LABEL"),
    );
    expect(names).toEqual([
      "Title",
      "Description",
      "Priority",
      "Due",
      "Due time",
      "Scheduled",
      "Project",
      "Scope",
      "Tags",
      "Add to inbox",
      "Add as ready",
      "Close form",
    ]);
    expect(focusable.some((element) => element.tabIndex > 0)).toBe(false);
  });
});

describe("wave-5 review: create form", () => {
  it("ignores Escape while a create is in flight, so typed text is not discarded", async () => {
    const pending = deferred<unknown>();
    const onClose = vi.fn();
    render(<TaskCreateForm {...props({ onClose, create: vi.fn(() => pending.promise) })} />);
    type("Title", "Half typed");
    fireEvent.click(button("Add as ready"));
    fireEvent.keyDown(control("Title"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    pending.resolve({});
    await waitFor(() => expect(button("Add as ready").getAttribute("aria-busy")).toBeNull());
  });

  it("validates the description before sending, with a field message", async () => {
    const create = vi.fn(() => Promise.resolve({}));
    render(<TaskCreateForm {...props({ create })} />);
    type("Title", "A task");
    type("Description", "x".repeat(10_001));
    fireEvent.click(button("Add as ready"));
    await waitFor(() => screen.getByText("Use 10,000 characters or fewer."));
    expect(control("Description").getAttribute("aria-invalid")).toBe("true");
    type("Description", "a\u0000b");
    await waitFor(() => screen.getByText("Remove null characters from the description."));
    fireEvent.click(button("Add as ready"));
    expect(create).not.toHaveBeenCalled();
    type("Description", "fine");
    await waitFor(() => expect(control("Description").getAttribute("aria-invalid")).toBeNull());
  });

  it("reports validateCreateValues description errors", () => {
    expect(
      validateCreateValues({ ...EMPTY_FORM_VALUES, title: "t", description: "x".repeat(10_001) })
        .description,
    ).toBe("Use 10,000 characters or fewer.");
    expect(
      validateCreateValues({ ...EMPTY_FORM_VALUES, title: "t", description: "a\u0000" })
        .description,
    ).toBe("Remove null characters from the description.");
  });
});
