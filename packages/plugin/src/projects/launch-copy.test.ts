import { LAUNCH_ACTIONS, LAUNCH_ERROR_KINDS } from "@ccc/domain";
import { describe, expect, it } from "vitest";
import {
  LAUNCH_ERROR_ACTION_LABELS,
  LAUNCH_ERROR_COPY,
  launchAcknowledgement,
  launchAnnouncement,
  launchErrorNotice,
  launcherDisplayName,
  launchSuccessLine,
  PAIR_AGENT_NAMES,
  PAIR_CODEX_MISSING_NOTE,
  PAIR_CODEX_SETUP_TEXT,
  pairAnnouncement,
  pairLineText,
  renderCopy,
} from "./launch-copy.js";

/**
 * The fixed D-26 copy table (UI-SPEC "Launch error copy", PR-11 for
 * `folder-access-denied`). Every assertion iterates LAUNCH_ERROR_KINDS
 * itself, so a new kind cannot ship without copy.
 */

/** A `/`- or `~/`-rooted path, anywhere in a string. */
const PATH_PATTERN = /(^|\s)(\/|~\/)[A-Za-z]/;

/** Every `{token}` a template may contain. */
const ALLOWED_TOKENS = new Set(["{Launcher}", "{Terminal}", "{project}"]);

function linesOf(kind: (typeof LAUNCH_ERROR_KINDS)[number]): string[] {
  const copy = LAUNCH_ERROR_COPY[kind];
  return [copy.problem, copy.nextStep, copy.notice];
}

describe("LAUNCH_ERROR_COPY (D-26)", () => {
  it("has exactly the thirteen LaunchErrorKind keys", () => {
    expect(Object.keys(LAUNCH_ERROR_COPY).sort()).toEqual([...LAUNCH_ERROR_KINDS].sort());
    expect(LAUNCH_ERROR_KINDS).toHaveLength(13);
  });

  it.each([...LAUNCH_ERROR_KINDS])(
    "%s: no line contains a path, before or after substitution",
    (kind) => {
      for (const line of linesOf(kind)) {
        expect(line).not.toMatch(PATH_PATTERN);
        for (const action of LAUNCH_ACTIONS) {
          const rendered = renderCopy(line, {
            launcher: launcherDisplayName(action),
            terminal: "Terminal",
            project: "example-project",
          });
          expect(rendered).not.toMatch(PATH_PATTERN);
          expect(rendered).not.toContain("~/");
        }
      }
    },
  );

  it.each([...LAUNCH_ERROR_KINDS])(
    "%s: only {Launcher}, {Terminal} and {project} are substituted",
    (kind) => {
      for (const line of linesOf(kind)) {
        for (const token of line.match(/\{[^}]*\}/g) ?? []) {
          expect(ALLOWED_TOKENS.has(token)).toBe(true);
        }
        const rendered = renderCopy(line, {
          launcher: "Antigravity",
          terminal: "Terminal",
          project: "example-project",
        });
        expect(rendered).not.toMatch(/\{[^}]*\}/);
      }
    },
  );

  it.each([...LAUNCH_ERROR_KINDS])(
    "%s: a claude-desktop Notice drops the {project}: prefix",
    (kind) => {
      const notice = launchErrorNotice(kind, {
        launcher: "Claude Desktop",
        terminal: "Terminal",
        project: null,
      });
      expect(notice.startsWith(":")).toBe(false);
      expect(notice).not.toContain("{project}");
      expect(notice).not.toMatch(/^[^ ]*: /);
    },
  );

  it("each action button is one of the fixed kinds, or none", () => {
    for (const kind of LAUNCH_ERROR_KINDS) {
      const action = LAUNCH_ERROR_COPY[kind].action;
      expect([
        undefined,
        "set-up-launchers",
        "go-to-projects",
        "open-automation",
        "open-privacy-security",
        "open-codex-settings",
        "try-again",
      ]).toContain(action);
    }
  });

  it("folder-access-denied uses the PR-11 lines, button and Notice", () => {
    const copy = LAUNCH_ERROR_COPY["folder-access-denied"];
    expect(copy.problem).toBe("macOS blocked access to this project's folder.");
    expect(copy.nextStep).toBe(
      "Move the project out of Documents, Desktop, Downloads or iCloud Drive, or allow access in System Settings › Privacy & Security, then try again. Updating Node.js can make macOS block it again.",
    );
    expect(copy.action).toBe("open-privacy-security");
    expect(copy.notice).toBe(
      "{project}: macOS blocked access to the folder. Move the project, or allow access in System Settings › Privacy & Security.",
    );
  });

  it("matches the UI-SPEC verbatim for the other kinds' action buttons", () => {
    expect(LAUNCH_ERROR_COPY["service-disconnected"].action).toBeUndefined();
    expect(LAUNCH_ERROR_COPY.timeout.action).toBeUndefined();
    expect(LAUNCH_ERROR_COPY["launcher-not-configured"].action).toBe("set-up-launchers");
    expect(LAUNCH_ERROR_COPY["app-not-found"].action).toBe("set-up-launchers");
    expect(LAUNCH_ERROR_COPY["spawn-failed"].action).toBe("set-up-launchers");
    expect(LAUNCH_ERROR_COPY["project-missing"].action).toBe("go-to-projects");
    expect(LAUNCH_ERROR_COPY["project-moved"].action).toBe("go-to-projects");
    expect(LAUNCH_ERROR_COPY["no-github-remote"].action).toBe("go-to-projects");
    expect(LAUNCH_ERROR_COPY["automation-denied"].action).toBe("open-automation");
    expect(LAUNCH_ERROR_COPY["automation-denied"].problem).toBe(
      "macOS blocked the command center from controlling {Terminal}.",
    );
  });

  it("launchErrorNotice is the table's Notice, rendered", () => {
    for (const kind of LAUNCH_ERROR_KINDS) {
      const values = { launcher: "Finder", terminal: "iTerm2", project: "example-project" };
      expect(launchErrorNotice(kind, values)).toBe(
        renderCopy(LAUNCH_ERROR_COPY[kind].notice, values),
      );
    }
  });
});

describe("launchSuccessLine (D-40: claim only what was observed)", () => {
  it("the Claude Code line claims a terminal window, never a session", () => {
    const line = launchSuccessLine("claude-code", "Terminal");
    expect(line).toBe("Opened a Terminal window for Claude Code");
    expect(line.toLowerCase()).not.toContain("session");
  });
});

describe("the three bridge error rows (UI-SPEC Typed errors, D-09, OQ-1)", () => {
  it("carry the UI-SPEC text verbatim, with the action buttons of plan 05.1-17", () => {
    expect(LAUNCH_ERROR_COPY["bridge-not-installed"]).toEqual({
      action: "open-codex-settings",
      problem: "The Antigravity terminal bridge isn't installed.",
      nextStep:
        "Install it from Settings → Codex, or switch to Terminal in Settings → Launchers, then try again.",
      notice:
        "The Antigravity terminal bridge isn't installed. Install it from Settings → Codex, or switch to Terminal in Settings → Launchers.",
    });
    expect(LAUNCH_ERROR_COPY["bridge-outdated"]).toEqual({
      action: "open-codex-settings",
      problem: "The Antigravity terminal bridge is out of date.",
      nextStep: "Run its install step again from Settings → Codex, then try again.",
      notice:
        "The Antigravity terminal bridge is out of date. Run its install step again from Settings → Codex.",
    });
    expect(LAUNCH_ERROR_COPY["window-not-ready"]).toEqual({
      action: "try-again",
      problem: "Antigravity is still starting.",
      nextStep: "Its window is opening now. Try again in a few seconds.",
      notice: "Antigravity is still starting. Try again in a few seconds.",
    });
  });

  it("never uses the word command", () => {
    for (const kind of ["bridge-not-installed", "bridge-outdated", "window-not-ready"] as const) {
      for (const line of linesOf(kind)) {
        expect(line.toLowerCase()).not.toContain("command");
      }
    }
  });
});

describe("the new action buttons and labels (plan 05.1-17)", () => {
  it("labels the three new actions verbatim", () => {
    expect(LAUNCH_ERROR_ACTION_LABELS["open-codex-settings"]).toBe("Open Codex settings");
    expect(LAUNCH_ERROR_ACTION_LABELS["try-again"]).toBe("Try again");
    expect(LAUNCH_ERROR_ACTION_LABELS["set-up-codex"]).toBe("Set up Codex");
  });

  it("no action label contains the word command", () => {
    for (const label of Object.values(LAUNCH_ERROR_ACTION_LABELS)) {
      expect(label.toLowerCase()).not.toContain("command");
    }
  });
});

describe("single Claude Code launches under the Antigravity terminal (UI-SPEC grammar fix)", () => {
  it("reads 'a tab in Antigravity' for the acknowledgement, success line and announcement", () => {
    expect(launchAcknowledgement("claude-code", "Antigravity")).toBe(
      "Opening a tab in Antigravity…",
    );
    expect(launchSuccessLine("claude-code", "Antigravity")).toBe(
      "Opened a tab in Antigravity for Claude Code",
    );
    expect(launchAnnouncement("claude-code", "Antigravity", "example-project")).toBe(
      "Opening a tab in Antigravity for Claude Code in example-project…",
    );
  });

  it("leaves the other terminal labels exactly as before", () => {
    expect(launchAcknowledgement("claude-code", "Terminal")).toBe("Opening a Terminal window…");
    expect(launchAcknowledgement("claude-code", "iTerm2")).toBe("Opening a iTerm2 window…");
    expect(launchSuccessLine("claude-code", "Terminal")).toBe(
      "Opened a Terminal window for Claude Code",
    );
    expect(launchAnnouncement("claude-code", "Terminal", "example-project")).toBe(
      "Opening a Terminal window for Claude Code in example-project…",
    );
  });

  it("does not change the other four launchers' strings for the Antigravity label", () => {
    expect(launchAcknowledgement("antigravity", "Antigravity")).toBe("Opening in Antigravity…");
    expect(launchSuccessLine("finder", "Antigravity")).toBe("Revealed in Finder");
  });
});

describe("the pair's per-agent lines (UI-SPEC S2)", () => {
  const opening = { kind: "opening" } as const;
  const success = { kind: "success" } as const;

  it("names the agents Claude Code and Codex", () => {
    expect(PAIR_AGENT_NAMES).toEqual({ claude: "Claude Code", codex: "Codex" });
    expect(launcherDisplayName("claude-codex-pair")).toBe("Claude + Codex");
  });

  it("opening lines read the Antigravity wording, or the Terminal wording for another label", () => {
    expect(pairLineText("claude", opening, "Antigravity", "p")).toBe(
      "Claude Code: Opening a tab in Antigravity…",
    );
    expect(pairLineText("codex", opening, "Antigravity", "p")).toBe(
      "Codex: Opening a tab in Antigravity…",
    );
    expect(pairLineText("claude", opening, "Terminal", "p")).toBe(
      "Claude Code: Opening a Terminal window…",
    );
  });

  it("success lines read per terminal", () => {
    expect(pairLineText("claude", success, "Antigravity", "p")).toBe(
      "Claude Code: Opened in an Antigravity tab",
    );
    expect(pairLineText("codex", success, "Antigravity", "p")).toBe(
      "Codex: Opened in an Antigravity tab",
    );
    expect(pairLineText("codex", success, "Terminal", "p")).toBe("Codex: Opened a Terminal window");
  });

  it("error lines carry the agent, the problem and the next step from the table", () => {
    expect(
      pairLineText("codex", { kind: "error", error: "window-not-ready" }, "Antigravity", "p"),
    ).toBe(
      "Codex: Antigravity is still starting. Its window is opening now. Try again in a few seconds.",
    );
    expect(
      pairLineText("claude", { kind: "error", error: "launcher-not-configured" }, "Terminal", "p"),
    ).toBe(
      "Claude Code: Claude Code isn't set up yet. Set it up in Settings → Launchers, then try again.",
    );
  });

  it("the Codex setup line is the locked text and never an error", () => {
    expect(PAIR_CODEX_SETUP_TEXT).toBe(
      "Codex isn't set up yet. Install it, then add it in Settings → Launchers.",
    );
    expect(pairLineText("codex", { kind: "setup" }, "Antigravity", "p")).toBe(
      `Codex: ${PAIR_CODEX_SETUP_TEXT}`,
    );
  });

  it("the hidden note for a missing Codex install is the locked sentence", () => {
    expect(PAIR_CODEX_MISSING_NOTE).toBe("Codex isn't set up, so only Claude Code will open.");
  });

  it("announces the two statements, or the opening sentence naming the project", () => {
    expect(pairAnnouncement(opening, opening, "Antigravity", "example-project")).toBe(
      "Opening Claude Code and Codex in example-project…",
    );
    expect(pairAnnouncement(success, { kind: "setup" }, "Antigravity", "example-project")).toBe(
      "Claude Code: Opened in an Antigravity tab. Codex: Codex isn't set up yet. Install it, then add it in Settings → Launchers.",
    );
  });

  it("no pair line contains a path or the word command", () => {
    const lines = [
      pairLineText("claude", success, "Antigravity", "p"),
      pairLineText("codex", { kind: "setup" }, "Antigravity", "p"),
      ...LAUNCH_ERROR_KINDS.map((error) =>
        pairLineText("codex", { kind: "error", error }, "Antigravity", "p"),
      ),
    ];
    for (const line of lines) {
      expect(line).not.toMatch(PATH_PATTERN);
      // "command center" is the product name, the only allowed occurrence.
      expect(line.toLowerCase().replaceAll("command center", "")).not.toContain("command");
      expect(line).not.toContain("{");
    }
  });
});
