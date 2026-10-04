import { cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import type { VNode } from "preact";
import { useState } from "preact/hooks";
import { afterEach, describe, expect, it } from "vitest";
import { TemplateEditor, type TemplateEditorKind } from "./template-editor.js";

/**
 * S7 argument template editor (Task 2, RR-13, PR-13, D-22): one labelled
 * input per argument, a live one-argument-per-line preview, and only the
 * trivial checks on blur — the service owns the full validation.
 */

interface HarnessProps {
  readonly kind: TemplateEditorKind;
  readonly initial: readonly string[];
  readonly errors?: ReadonlyMap<number, string>;
  readonly sample?: string;
  readonly executableDisplay?: string | null;
}

function Harness({
  kind,
  initial,
  errors = new Map(),
  sample = "~/code/example-project",
  executableDisplay = null,
}: HarnessProps): VNode {
  const [value, setValue] = useState<readonly string[]>(initial);
  return (
    <TemplateEditor
      kind={kind}
      value={value}
      onChange={setValue}
      errors={errors}
      sampleDisplayPath={sample}
      terminalLabel="Terminal"
      executableDisplay={executableDisplay}
    />
  );
}

function previewItems(): string[] {
  const list = screen.getByRole("list", { name: "Preview" });
  return within(list)
    .getAllByRole("listitem")
    .map((item) => item.textContent ?? "");
}

afterEach(cleanup);

describe("rows (S7)", () => {
  it("the terminal editor always shows an Executable row, with no way to remove it", () => {
    render(<Harness kind="terminal" initial={[""]} />);
    expect(screen.getByRole("group", { name: "Terminal arguments" })).toBeTruthy();
    const executable = screen.getByLabelText<HTMLInputElement>("Executable");
    expect(executable.className).toContain("ccc-text-input--mono");
    expect(screen.queryByRole("button", { name: "Remove argument 0" })).toBeNull();
    expect(screen.queryAllByRole("button", { name: /^Remove argument/ })).toHaveLength(0);
  });

  it("the Claude Code editor with no arguments says Claude Code starts with its defaults", () => {
    render(<Harness kind="claude-code" initial={[]} />);
    expect(screen.getByRole("group", { name: "Claude Code arguments" })).toBeTruthy();
    expect(
      screen.getByText("No extra arguments. Claude Code starts with its defaults."),
    ).toBeTruthy();
  });

  it("Add argument appends a labelled mono input Argument {n}", () => {
    render(<Harness kind="terminal" initial={["/usr/bin/example"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Add argument" }));
    const added = screen.getByLabelText<HTMLInputElement>("Argument 1");
    expect(added.className).toContain("ccc-text-input--mono");
    expect(added.value).toBe("");
  });

  it("Add {script} argument and Add {projectPath} argument append the placeholder as a whole argument", () => {
    render(<Harness kind="terminal" initial={["/usr/bin/example"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Add {script} argument" }));
    expect(screen.getByLabelText<HTMLInputElement>("Argument 1").value).toBe("{script}");
    cleanup();
    render(<Harness kind="claude-code" initial={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Add {projectPath} argument" }));
    expect(screen.getByLabelText<HTMLInputElement>("Argument 1").value).toBe("{projectPath}");
  });

  it("at 32 arguments Add argument is aria-disabled with the hidden Up to 32 arguments note", () => {
    const full = ["/usr/bin/example", ...Array.from({ length: 31 }, (_, i) => `arg-${i + 1}`)];
    render(<Harness kind="terminal" initial={full} />);
    const add = screen.getByRole("button", { name: "Add argument" });
    expect(add.getAttribute("aria-disabled")).toBe("true");
    const note = document.getElementById(add.getAttribute("aria-describedby") ?? "");
    expect(note?.textContent).toBe("Up to 32 arguments");
    fireEvent.click(add);
    expect(screen.queryByLabelText("Argument 32")).toBeNull();
  });

  it("Remove argument deletes that row and focuses the next row's input", () => {
    render(<Harness kind="terminal" initial={["/usr/bin/example", "one", "two", "three"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove argument 2" }));
    expect(screen.getByLabelText<HTMLInputElement>("Argument 1").value).toBe("one");
    const next = screen.getByLabelText<HTMLInputElement>("Argument 2");
    expect(next.value).toBe("three");
    expect(document.activeElement).toBe(next);
    expect(screen.queryByLabelText("Argument 3")).toBeNull();
  });

  it("removing the last row focuses Add argument", () => {
    render(<Harness kind="terminal" initial={["/usr/bin/example", "one"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove argument 1" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add argument" }));
  });
});

describe("the preview (S7, RR-13, RR-24)", () => {
  it("shows one item per argument, with {script} and {projectPath} rendered for reading", () => {
    render(
      <Harness
        kind="terminal"
        initial={["/usr/bin/example", "--cwd", "{projectPath}", "{script}"]}
        sample="~/code/example-project"
      />,
    );
    expect(screen.getByText("Starts the terminal with:")).toBeTruthy();
    expect(
      screen.getByText(
        "Exactly what runs, one argument per line. Nothing is passed through a shell.",
      ),
    ).toBeTruthy();
    expect(previewItems()).toEqual([
      "/usr/bin/example",
      "--cwd",
      "~/code/example-project",
      "‹launch script›",
    ]);
  });

  it("falls back to ~/example-project when there is no sample project", () => {
    render(<Harness kind="claude-code" initial={["{projectPath}"]} sample="~/example-project" />);
    expect(previewItems()).toContain("~/example-project");
  });

  it("the Claude Code preview names the terminal and starts with the executable", () => {
    render(
      <Harness
        kind="claude-code"
        initial={["--model", "opus"]}
        executableDisplay="~/.local/bin/claude"
      />,
    );
    expect(screen.getByText("Runs inside Terminal, at the project folder:")).toBeTruthy();
    expect(previewItems()).toEqual(["~/.local/bin/claude", "--model", "opus"]);
  });

  it("updates on every keystroke and never splits an argument on spaces", () => {
    render(<Harness kind="terminal" initial={["/usr/bin/example", ""]} />);
    fireEvent.input(screen.getByLabelText("Argument 1"), { target: { value: "two words" } });
    expect(previewItems()).toEqual(["/usr/bin/example", "two words"]);
    fireEvent.input(screen.getByLabelText("Argument 1"), { target: { value: "two words here" } });
    const items = previewItems();
    expect(items).toHaveLength(2);
    expect(items[1]).toBe("two words here");
    expect(items).not.toContain("words");
  });
});

describe("blur-time checks only (PR-13)", () => {
  it("a relative executable shows the full-path line with aria-invalid and aria-describedby", () => {
    render(<Harness kind="terminal" initial={["example", "{script}"]} />);
    const executable = screen.getByLabelText("Executable");
    expect(screen.queryByText("The executable must be a full path, starting with /.")).toBeNull();
    fireEvent.blur(executable);
    const error = screen.getByText("The executable must be a full path, starting with /.");
    expect(executable.getAttribute("aria-invalid")).toBe("true");
    expect(executable.getAttribute("aria-describedby")).toBe(error.id);
  });

  it("an empty argument shows Arguments can't be empty.", () => {
    render(<Harness kind="terminal" initial={["/usr/bin/example", ""]} />);
    fireEvent.blur(screen.getByLabelText("Argument 1"));
    expect(screen.getByText("Arguments can't be empty.")).toBeTruthy();
  });

  it("a line break shows Arguments can't contain line breaks.", () => {
    render(<Harness kind="claude-code" initial={["one\ntwo"]} />);
    fireEvent.blur(screen.getByLabelText("Argument 1"));
    expect(screen.getByText("Arguments can't contain line breaks.")).toBeTruthy();
    expect(screen.getByLabelText("Argument 1").getAttribute("aria-invalid")).toBe("true");
  });

  it("a service-reported refusal appears under the row it names", () => {
    render(
      <Harness
        kind="claude-code"
        initial={["--model", "--dangerously-skip-permissions"]}
        errors={new Map([[2, "--dangerously-skip-permissions isn't allowed here."]])}
      />,
    );
    const row = screen.getByLabelText("Argument 2");
    expect(row.getAttribute("aria-invalid")).toBe("true");
    const describedBy = document.getElementById(row.getAttribute("aria-describedby") ?? "");
    expect(describedBy?.textContent).toContain(
      "--dangerously-skip-permissions isn't allowed here.",
    );
    expect(screen.getByLabelText("Argument 1").getAttribute("aria-invalid")).toBeNull();
  });
});
