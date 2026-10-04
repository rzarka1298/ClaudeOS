import { LAUNCH_ACTIONS, LAUNCH_ERROR_KINDS } from "@ccc/domain";
import { describe, expect, it } from "vitest";
import {
  LAUNCH_ERROR_COPY,
  launchErrorNotice,
  launcherDisplayName,
  launchSuccessLine,
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
  it("has exactly the ten LaunchErrorKind keys", () => {
    expect(Object.keys(LAUNCH_ERROR_COPY).sort()).toEqual([...LAUNCH_ERROR_KINDS].sort());
    expect(LAUNCH_ERROR_KINDS).toHaveLength(10);
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

  it("each action button is one of the four fixed kinds, or none", () => {
    for (const kind of LAUNCH_ERROR_KINDS) {
      const action = LAUNCH_ERROR_COPY[kind].action;
      expect([
        undefined,
        "set-up-launchers",
        "go-to-projects",
        "open-automation",
        "open-privacy-security",
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
