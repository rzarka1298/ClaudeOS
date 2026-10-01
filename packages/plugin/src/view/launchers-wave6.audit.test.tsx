import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionState } from "../connection-state.js";
import {
  DETECTION,
  fakeLaunchersActions,
  NOTHING_SAVED,
} from "../test-support/launchers-fixtures.js";
import { ClaudeCodePanel } from "./claude-code-panel.js";
import { createLaunchersSession } from "./launchers-settings.js";
import { scanResultLine } from "./scan-folders.js";

/** Wave 6 audit (04-12, 04-13): truths the plan tests left weak. */

const LIVE: ConnectionState = { kind: "live" };

afterEach(cleanup);

function mountPanel(save = vi.fn()) {
  const session = createLaunchersSession();
  session.detection.value = DETECTION;
  session.configs.value = NOTHING_SAVED;
  const actions = fakeLaunchersActions({ save });
  render(
    <ClaudeCodePanel
      actions={actions}
      session={session}
      connection={LIVE}
      now={Date.parse("2026-09-30T10:05:00.000Z")}
      sampleDisplayPath="~/code/example-project"
    />,
  );
  return save;
}

describe("S7 error: Save launcher refuses while any row is invalid (04-12)", () => {
  it("an empty argument row blocks the save and is marked aria-invalid", async () => {
    const save = mountPanel();
    fireEvent.click(screen.getByRole("radio", { name: "~/.local/bin/claude" }));
    const editor = screen.getByRole("group", { name: "Claude Code arguments" });
    fireEvent.click(within(editor).getByRole("button", { name: "Add argument" }));
    fireEvent.click(screen.getByRole("button", { name: "Save launcher" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(save).not.toHaveBeenCalled();
    expect(within(editor).getByLabelText("Argument 1").getAttribute("aria-invalid")).toBe("true");
  });
});

describe("no free-text command line exists anywhere (04-12, RR-13)", () => {
  it("the Claude Code panel renders no textarea, even with a custom terminal", () => {
    mountPanel();
    fireEvent.click(screen.getByRole("radio", { name: "~/.local/bin/claude" }));
    fireEvent.click(screen.getByRole("radio", { name: /^Custom terminal/ }));
    expect(document.querySelectorAll("textarea")).toHaveLength(0);
  });
});

describe("S7 overflow: the preview wraps anywhere (04-12)", () => {
  it("the preview list rule sets overflow-wrap: anywhere", () => {
    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "styles.css"),
      "utf8",
    );
    const rule = /\.ccc-preview-list\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/overflow-wrap:\s*anywhere/);
  });
});

describe("S5 zero-one-many result line (04-13)", () => {
  it("reads singular for one, plural for many, and the zero copy for none", () => {
    expect(scanResultLine(0)).toBe("No new Git folders found.");
    expect(scanResultLine(1)).toBe("Found 1 new Git folder");
    expect(scanResultLine(2)).toBe("Found 2 new Git folders");
  });
});
