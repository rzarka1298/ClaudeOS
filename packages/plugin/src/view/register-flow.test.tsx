import { EMPTY_PROJECTS_SNAPSHOT, newProjectId } from "@ccc/domain";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectActionOutcome, ProjectsActions } from "../projects/projects-actions.js";
import { projectsSnapshot, resetProjectsState } from "../projects/projects-state.js";
import { RegisterFlow } from "./register-flow.js";

function noopActions(): ProjectsActions {
  const notCalled: () => Promise<ProjectActionOutcome> = () =>
    Promise.reject(new Error("not expected to be called in this test"));
  return {
    register: notCalled,
    remove: notCalled,
    rename: notCalled,
    pin: notCalled,
    setGithubLink: notCalled,
    refresh: notCalled,
  };
}

afterEach(() => {
  cleanup();
  resetProjectsState();
});

describe("RegisterFlow (Task 2, S4)", () => {
  it("Type a path instead opens the labelled mono input with its help and placeholder", () => {
    render(
      <RegisterFlow
        actions={noopActions()}
        pickFolder={() => Promise.resolve({ kind: "unavailable" })}
        onRegistered={vi.fn()}
        onDuplicate={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Type a path instead" }));

    const input = screen.getByLabelText("Folder path");
    expect(input.getAttribute("placeholder")).toBe("/Users/USERNAME/code/example-project");
    expect(screen.getByText("The full path, starting with /.")).toBeTruthy();
  });

  it("a pickFolder returning unavailable opens the typed form automatically with the picker-unavailable notice", async () => {
    render(
      <RegisterFlow
        actions={noopActions()}
        pickFolder={() => Promise.resolve({ kind: "unavailable" })}
        onRegistered={vi.fn()}
        onDuplicate={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Register a project" }));

    await screen.findByText(
      "The folder picker isn't available here. Paste the folder's full path instead.",
    );
    expect(screen.getByLabelText("Folder path")).toBeTruthy();
  });

  it("a cancelled picker changes nothing and returns focus to the opener", async () => {
    const pickFolder = vi.fn().mockResolvedValue({ kind: "cancelled" });
    render(
      <RegisterFlow
        actions={noopActions()}
        pickFolder={pickFolder}
        onRegistered={vi.fn()}
        onDuplicate={vi.fn()}
      />,
    );

    const opener = screen.getByRole("button", { name: "Register a project" });
    fireEvent.click(opener);

    await vi.waitFor(() => expect(pickFolder).toHaveBeenCalledTimes(1));
    expect(screen.queryByLabelText("Folder path")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("'code/x' shows the absolute-path error under the input, invalid, described-by, and sends no request", async () => {
    const register = vi.fn();
    render(
      <RegisterFlow
        actions={{ ...noopActions(), register }}
        pickFolder={() => Promise.resolve({ kind: "unavailable" })}
        onRegistered={vi.fn()}
        onDuplicate={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Type a path instead" }));
    const input = screen.getByLabelText("Folder path");
    fireEvent.input(input, { target: { value: "code/x" } });
    fireEvent.click(screen.getByRole("button", { name: "Register folder" }));

    const error = await screen.findByText("▲ Enter the full path, starting with /.");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe(error.id);
    expect(register).not.toHaveBeenCalled();
  });

  it("a value with a control character shows the control-character message", async () => {
    render(
      <RegisterFlow
        actions={noopActions()}
        pickFolder={() => Promise.resolve({ kind: "unavailable" })}
        onRegistered={vi.fn()}
        onDuplicate={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Type a path instead" }));
    const input = screen.getByLabelText("Folder path");
    // A single-line <input>'s value sanitization algorithm strips CR/LF
    // (they can never reach `.value`), so this uses a non-newline control
    // character (U+0001) — still one `hasControlCharacter` must catch,
    // and the one an <input> genuinely lets through.
    fireEvent.input(input, { target: { value: "/Users/USERNAME/code/exa\u0001mple" } });
    fireEvent.click(screen.getByRole("button", { name: "Register folder" }));

    await screen.findByText("▲ Paths can't contain line breaks or control characters.");
  });

  it("shows Registering… in the same render as the submit click, before any await resolves", async () => {
    let resolveRegister: (outcome: ProjectActionOutcome) => void = () => {};
    const register = vi.fn(
      () =>
        new Promise<ProjectActionOutcome>((resolve) => {
          resolveRegister = resolve;
        }),
    );

    render(
      <RegisterFlow
        actions={{ ...noopActions(), register }}
        pickFolder={() => Promise.resolve({ kind: "unavailable" })}
        onRegistered={vi.fn()}
        onDuplicate={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Type a path instead" }));
    fireEvent.input(screen.getByLabelText("Folder path"), {
      target: { value: "/Users/USERNAME/code/example-project" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Register folder" }));

    // No await before this assertion (D-40): the in-flight text is set
    // synchronously before the first await inside the click handler.
    expect(screen.getByRole("status").textContent).toBe("Registering…");
    expect(
      screen.getByRole("button", { name: "Register folder" }).getAttribute("aria-disabled"),
    ).toBe("true");

    resolveRegister({ kind: "failed" });
    await screen.findByText(/Couldn't register this folder\./);
  });

  it("registered: announces success, clears the form, and hands the projectId to onRegistered", async () => {
    const projectId = newProjectId();
    const register = vi.fn().mockResolvedValue({ kind: "registered", projectId });
    const onRegistered = vi.fn();

    render(
      <RegisterFlow
        actions={{ ...noopActions(), register }}
        pickFolder={() => Promise.resolve({ kind: "unavailable" })}
        onRegistered={onRegistered}
        onDuplicate={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Type a path instead" }));
    fireEvent.input(screen.getByLabelText("Folder path"), {
      target: { value: "/Users/USERNAME/code/example-project" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Register folder" }));

    await screen.findByText("Registered example-project.");
    expect(onRegistered).toHaveBeenCalledWith(projectId);
    expect(screen.queryByLabelText("Folder path")).toBeNull();
  });

  it("already-registered: names the existing project and calls onDuplicate", async () => {
    const projectId = newProjectId();
    projectsSnapshot.value = {
      projects: [
        {
          projectId,
          displayName: "renamed-project",
          displayPath: "~/code/renamed-project",
          pinned: false,
          lastOpenedAt: null,
          observedAt: null,
          gitReadFailed: false,
          git: { kind: "pending" },
          github: { kind: "none" },
        },
      ],
      launchers: EMPTY_PROJECTS_SNAPSHOT.launchers,
    };
    const register = vi.fn().mockResolvedValue({ kind: "already-registered", projectId });
    const onDuplicate = vi.fn();

    render(
      <RegisterFlow
        actions={{ ...noopActions(), register }}
        pickFolder={() => Promise.resolve({ kind: "unavailable" })}
        onRegistered={vi.fn()}
        onDuplicate={onDuplicate}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Type a path instead" }));
    fireEvent.input(screen.getByLabelText("Folder path"), {
      target: { value: "/Users/USERNAME/code/renamed-project" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Register folder" }));

    await screen.findByText("This folder is already registered as renamed-project.");
    expect(onDuplicate).toHaveBeenCalledWith(projectId);
  });

  it("refused: shows the constant refusal copy, keeps the typed value, and echoes it nowhere", async () => {
    const register = vi.fn().mockResolvedValue({ kind: "refused" });
    const { container } = render(
      <RegisterFlow
        actions={{ ...noopActions(), register }}
        pickFolder={() => Promise.resolve({ kind: "unavailable" })}
        onRegistered={vi.fn()}
        onDuplicate={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Type a path instead" }));
    const input = screen.getByLabelText("Folder path");
    fireEvent.input(input, { target: { value: "/etc/example-project" } });
    fireEvent.click(screen.getByRole("button", { name: "Register folder" }));

    await screen.findByText(/Couldn't register this folder\./);
    expect((input as HTMLInputElement).value).toBe("/etc/example-project");
    // No rendered TEXT NODE contains the path — the only place it appears is
    // the input's own `value`, which is not part of `textContent` (D-04).
    expect(container.textContent ?? "").not.toContain("/etc/example-project");
  });

  it("protected-location: sends nothing further until Register folder is chosen, then re-sends with acknowledgeProtectedLocation", async () => {
    const projectId = newProjectId();
    const register = vi
      .fn()
      .mockResolvedValueOnce({ kind: "protected-location", location: "documents" })
      .mockResolvedValueOnce({ kind: "registered", projectId });

    render(
      <RegisterFlow
        actions={{ ...noopActions(), register }}
        pickFolder={() => Promise.resolve({ kind: "unavailable" })}
        onRegistered={vi.fn()}
        onDuplicate={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Type a path instead" }));
    fireEvent.input(screen.getByLabelText("Folder path"), {
      target: { value: "/Users/USERNAME/Documents/example-project" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Register folder" }));

    await screen.findByText("This folder is in Documents");
    expect(register).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Register folder" }));

    await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(2));
    expect(register).toHaveBeenNthCalledWith(2, "/Users/USERNAME/Documents/example-project", true);
  });

  it("protected-location: Choose another folder returns to the typed form with the path kept", async () => {
    const register = vi.fn().mockResolvedValue({ kind: "protected-location", location: "desktop" });

    render(
      <RegisterFlow
        actions={{ ...noopActions(), register }}
        pickFolder={() => Promise.resolve({ kind: "unavailable" })}
        onRegistered={vi.fn()}
        onDuplicate={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Type a path instead" }));
    fireEvent.input(screen.getByLabelText("Folder path"), {
      target: { value: "/Users/USERNAME/Desktop/example-project" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Register folder" }));

    await screen.findByText("This folder is in Desktop");
    fireEvent.click(screen.getByRole("button", { name: "Choose another folder" }));

    const input = await screen.findByLabelText("Folder path");
    expect((input as HTMLInputElement).value).toBe("/Users/USERNAME/Desktop/example-project");
  });

  it("Escape cancels the typed form and returns focus to the opener", () => {
    render(
      <RegisterFlow
        actions={noopActions()}
        pickFolder={() => Promise.resolve({ kind: "unavailable" })}
        onRegistered={vi.fn()}
        onDuplicate={vi.fn()}
      />,
    );

    const opener = screen.getByRole("button", { name: "Register a project" });
    fireEvent.click(screen.getByRole("button", { name: "Type a path instead" }));
    const input = screen.getByLabelText("Folder path");
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByLabelText("Folder path")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
