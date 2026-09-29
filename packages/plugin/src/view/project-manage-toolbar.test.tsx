import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectActionOutcome, ProjectsActions } from "../projects/projects-actions.js";
import type { ProjectRow } from "../widgets/panels.js";
import { ProjectManageToolbar } from "./project-manage-toolbar.js";

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

function row(overrides: Partial<Pick<ProjectRow, "id" | "name" | "pinned" | "github">> = {}) {
  return {
    id: "abcdefghi0123456789abcdef",
    name: "example-project",
    pinned: false,
    github: { kind: "none" as const },
    ...overrides,
  };
}

afterEach(cleanup);

describe("ProjectManageToolbar (Task 3, S3 manage toolbar, RR-01)", () => {
  it("is a role=toolbar with one tab stop, and Right/Left/Home/End move it (RR-01)", () => {
    render(
      <ProjectManageToolbar
        row={row()}
        actions={noopActions()}
        onRemoved={vi.fn()}
        onStatus={vi.fn()}
      />,
    );

    const toolbar = screen.getByRole("toolbar");
    const buttons = within_(toolbar);

    expect(buttons.map((b) => b.tabIndex)).toEqual([0, -1, -1, -1]);

    fireEvent.keyDown(toolbar, { key: "ArrowRight" });
    expect(within_(toolbar).map((b) => b.tabIndex)).toEqual([-1, 0, -1, -1]);

    fireEvent.keyDown(toolbar, { key: "End" });
    expect(within_(toolbar).map((b) => b.tabIndex)).toEqual([-1, -1, -1, 0]);

    fireEvent.keyDown(toolbar, { key: "Home" });
    expect(within_(toolbar).map((b) => b.tabIndex)).toEqual([0, -1, -1, -1]);

    fireEvent.keyDown(toolbar, { key: "ArrowLeft" });
    expect(within_(toolbar).map((b) => b.tabIndex)).toEqual([-1, -1, -1, 0]);
  });

  function within_(toolbar: HTMLElement): HTMLButtonElement[] {
    return Array.from(toolbar.querySelectorAll("button"));
  }

  it("Pin project calls actions.pin(id, true), and after the reorder the same (now Unpin project) button keeps focus", async () => {
    const pin = vi.fn().mockResolvedValue({ kind: "ok" });
    const { rerender } = render(
      <ProjectManageToolbar
        row={row({ pinned: false })}
        actions={{ ...noopActions(), pin }}
        onRemoved={vi.fn()}
        onStatus={vi.fn()}
      />,
    );

    const pinButton = screen.getByRole("button", { name: "Pin project" });
    pinButton.focus();
    fireEvent.click(pinButton);

    await vi.waitFor(() => expect(pin).toHaveBeenCalledWith("abcdefghi0123456789abcdef", true));

    // Simulate the reorder: the parent re-renders this same component with
    // the new pinned state, exactly as projects-view.tsx would once the
    // projects.updated delta lands.
    rerender(
      <ProjectManageToolbar
        row={row({ pinned: true })}
        actions={{ ...noopActions(), pin }}
        onRemoved={vi.fn()}
        onStatus={vi.fn()}
      />,
    );

    const unpinButton = screen.getByRole("button", { name: "Unpin project" });
    expect(document.activeElement).toBe(unpinButton);
  });

  it("Rename project swaps in a labelled input; Enter saves via actions.rename", async () => {
    const rename = vi.fn().mockResolvedValue({ kind: "ok" });
    render(
      <ProjectManageToolbar
        row={row()}
        actions={{ ...noopActions(), rename }}
        onRemoved={vi.fn()}
        onStatus={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Rename project" }));
    const input = screen.getByLabelText("Project name");
    fireEvent.input(input, { target: { value: "renamed-project" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    await vi.waitFor(() =>
      expect(rename).toHaveBeenCalledWith("abcdefghi0123456789abcdef", "renamed-project"),
    );
  });

  it("Escape while renaming keeps the current name and returns focus to Rename project", () => {
    render(
      <ProjectManageToolbar
        row={row()}
        actions={noopActions()}
        onRemoved={vi.fn()}
        onStatus={vi.fn()}
      />,
    );

    const renameButton = screen.getByRole("button", { name: "Rename project" });
    fireEvent.click(renameButton);
    const input = screen.getByLabelText("Project name");
    fireEvent.input(input, { target: { value: "should not save" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByLabelText("Project name")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Rename project" }));
  });

  it("a 65-character name shows the length error and sends no request", () => {
    const rename = vi.fn();
    render(
      <ProjectManageToolbar
        row={row()}
        actions={{ ...noopActions(), rename }}
        onRemoved={vi.fn()}
        onStatus={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Rename project" }));
    const input = screen.getByLabelText("Project name");
    fireEvent.input(input, { target: { value: "x".repeat(65) } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    expect(screen.getByText("▲ Enter a name between 1 and 64 characters.")).toBeTruthy();
    expect(rename).not.toHaveBeenCalled();
  });

  it("Set GitHub link validates https://github.com/owner/repo client-side and Clear GitHub link sends null", async () => {
    const setGithubLink = vi.fn().mockResolvedValue({ kind: "ok" });
    render(
      <ProjectManageToolbar
        row={row({
          github: { kind: "github", label: "github.com/owner/repo", source: "override" },
        })}
        actions={{ ...noopActions(), setGithubLink }}
        onRemoved={vi.fn()}
        onStatus={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit GitHub link" }));
    const input = screen.getByLabelText("GitHub link");
    fireEvent.input(input, { target: { value: "not a link" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(
      screen.getByText("▲ Enter a GitHub link like https://github.com/owner/repo."),
    ).toBeTruthy();
    expect(setGithubLink).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Clear GitHub link" }));
    await vi.waitFor(() =>
      expect(setGithubLink).toHaveBeenCalledWith("abcdefghi0123456789abcdef", null),
    );
  });

  it("a remote-derived link offers Set GitHub link with an empty draft and no Clear GitHub link", () => {
    const setGithubLink = vi.fn().mockResolvedValue({ kind: "ok" });
    render(
      <ProjectManageToolbar
        row={row({
          github: { kind: "github", label: "github.com/owner/repo", source: "remote" },
        })}
        actions={{ ...noopActions(), setGithubLink }}
        onRemoved={vi.fn()}
        onStatus={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "Edit GitHub link" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Set GitHub link" }));
    expect((screen.getByLabelText("GitHub link") as HTMLInputElement).value).toBe("");
    expect(screen.queryByRole("button", { name: "Clear GitHub link" })).toBeNull();
    expect(setGithubLink).not.toHaveBeenCalled();
  });

  it("Remove from projects shows the confirmation with focus on Keep project; Escape keeps", () => {
    render(
      <ProjectManageToolbar
        row={row()}
        actions={noopActions()}
        onRemoved={vi.fn()}
        onStatus={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove from projects" }));
    expect(
      screen.getByText("Remove example-project from projects? Its folder and files stay on disk."),
    ).toBeTruthy();
    const keepButton = screen.getByRole("button", { name: "Keep project" });
    expect(document.activeElement).toBe(keepButton);

    fireEvent.keyDown(keepButton, { key: "Escape" });
    expect(screen.queryByText(/Its folder and files stay on disk\./)).toBeNull();
    expect(screen.getByRole("button", { name: "Remove from projects" })).toBeTruthy();
  });

  it("Remove project calls actions.remove and hands the removal (id and name) to onRemoved, not to the card's own status", async () => {
    const remove = vi.fn().mockResolvedValue({ kind: "ok" });
    const onRemoved = vi.fn();
    const onStatus = vi.fn();
    render(
      <ProjectManageToolbar
        row={row()}
        actions={{ ...noopActions(), remove }}
        onRemoved={onRemoved}
        onStatus={onStatus}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove from projects" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove project" }));

    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith("abcdefghi0123456789abcdef"));
    expect(onRemoved).toHaveBeenCalledWith("abcdefghi0123456789abcdef", "example-project");
    // The card is about to unmount with its row, taking its status region
    // with it — the view owns the removal announcement instead.
    expect(onStatus).not.toHaveBeenCalledWith("Removed example-project from projects.");
  });

  it("a failed action reports the constant save-failure copy via onStatus", async () => {
    const pin = vi.fn().mockResolvedValue({ kind: "failed" });
    const onStatus = vi.fn();
    render(
      <ProjectManageToolbar
        row={row()}
        actions={{ ...noopActions(), pin }}
        onRemoved={vi.fn()}
        onStatus={onStatus}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Pin project" }));

    await vi.waitFor(() =>
      expect(onStatus).toHaveBeenCalledWith(
        "▲ Couldn't save that change. Check the service in Settings → Diagnostics, then try again.",
      ),
    );
  });

  it("never uses confirm() or a modal for removal", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <ProjectManageToolbar
        row={row()}
        actions={noopActions()}
        onRemoved={vi.fn()}
        onStatus={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove from projects" }));

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    confirmSpy.mockRestore();
  });
});
