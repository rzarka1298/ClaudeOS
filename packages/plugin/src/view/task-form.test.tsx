import type { TaskCreateRequest } from "@ccc/domain/tasks.js";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectIdFor, TASK_ZONE } from "../test-support/task-view-fixtures.js";
import { TaskCreateForm, type TaskCreateFormProps } from "./task-form.js";

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
