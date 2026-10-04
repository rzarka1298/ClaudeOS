import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProjectId } from "@ccc/domain";
import { describe, expect, it, vi } from "vitest";
import type { QuickActionDescriptor } from "./contract.js";
import { dispatchQuickAction } from "./quick-actions.js";
import { WIDGETS } from "./registry.js";

/**
 * The approval-boundary seam (C-11, APPR-01, threat T-03-13).
 *
 * `dispatchQuickAction` is the SINGLE place every widget's quick action is
 * resolved, and it has exactly two outcomes: navigate to the plugin's own
 * settings destination, or say the action is not available. It executes
 * nothing. That is the point of building it now, before there is anything to
 * approve — Phase 6 inserts its approval check HERE, in one function, rather
 * than hunting per-widget callbacks that were never routable in the first
 * place (PATTERNS Pitfall 6).
 *
 * The source scan below is the structural half of that guarantee: a dispatcher
 * that cannot import Obsidian, a child process, or the service client cannot
 * grow a direct execution path by accident.
 */

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const DISPATCHER_SOURCE = readFileSync(join(SRC_DIR, "quick-actions.ts"), "utf8");

function context() {
  return { navigate: vi.fn(), notify: vi.fn(), requestLaunch: vi.fn(), openSwitcher: vi.fn() };
}

const PROJECT_ID = "project-1" as ProjectId;

const CONNECT_GOOGLE: QuickActionDescriptor = {
  id: "connect-google",
  label: "Connect Google Calendar and Gmail",
  capability: "connect:google",
};

const RUN_SKILL: QuickActionDescriptor = {
  id: "run-skill",
  label: "Run a skill",
  capability: "skill:run",
};

describe("a connect:* capability navigates to settings and says where", () => {
  it("navigates exactly once, to settings, and nowhere else", () => {
    const ctx = context();
    const result = dispatchQuickAction(CONNECT_GOOGLE, ctx);

    expect(result).toEqual({ kind: "navigated", destination: "settings" });
    expect(ctx.navigate).toHaveBeenCalledTimes(1);
    expect(ctx.navigate).toHaveBeenCalledWith("settings");
  });

  it("names the source and where its connector will be configured", () => {
    const ctx = context();
    dispatchQuickAction(CONNECT_GOOGLE, ctx);

    expect(ctx.notify).toHaveBeenCalledTimes(1);
    const message = String(ctx.notify.mock.calls[0]?.[0] ?? "");
    expect(message).toContain("Google Calendar and Gmail");
    expect(message).toContain("Settings");
  });
});

describe("every other capability reports that it is unavailable", () => {
  it("posts the label's own not-available line and never navigates", () => {
    const ctx = context();
    const result = dispatchQuickAction(RUN_SKILL, ctx);

    expect(result).toEqual({ kind: "unavailable" });
    expect(ctx.notify).toHaveBeenCalledTimes(1);
    expect(ctx.notify).toHaveBeenCalledWith("Run a skill isn't available yet.");
    expect(ctx.navigate).not.toHaveBeenCalled();
  });

  // SC-6 (rewritten, not deleted): Phase 4 makes two Quick actions live
  // (D-38, PR-08); every OTHER declared action still executes nothing.
  const UNAVAILABLE_QUICK_ACTIONS = WIDGETS["quick-actions"].quickActions.filter(
    (action) =>
      !action.capability.startsWith("launch:") && !action.capability.startsWith("switcher:"),
  );

  it("four Quick actions stay unavailable in this phase", () => {
    expect(UNAVAILABLE_QUICK_ACTIONS.map((action) => action.id)).toEqual([
      "run-skill",
      "create-task",
      "capture-note",
      "refresh-data",
    ]);
  });

  it.each(UNAVAILABLE_QUICK_ACTIONS.map((action) => [action.label, action] as const))(
    "%s executes nothing in this phase",
    (_label, action) => {
      const ctx = context();
      expect(dispatchQuickAction(action, ctx)).toEqual({ kind: "unavailable" });
      expect(ctx.navigate).not.toHaveBeenCalled();
      expect(ctx.requestLaunch).not.toHaveBeenCalled();
      expect(ctx.openSwitcher).not.toHaveBeenCalled();
      expect(ctx.notify).toHaveBeenCalledWith(`${action.label} isn't available yet.`);
    },
  );

  it("the two live Quick actions call requestLaunch / openSwitcher exactly once", () => {
    const actions = WIDGETS["quick-actions"].quickActions;
    const desktop = actions.find((action) => action.id === "open-claude-desktop");
    const session = actions.find((action) => action.id === "start-session");
    if (desktop === undefined || session === undefined) throw new Error("missing live actions");
    expect(desktop.capability).toBe("launch:claude-desktop");
    expect(session.capability).toBe("switcher:claude-code");

    const ctx = context();
    expect(dispatchQuickAction(desktop, ctx)).toEqual({
      kind: "launch-requested",
      action: "claude-desktop",
    });
    expect(ctx.requestLaunch).toHaveBeenCalledTimes(1);
    expect(ctx.requestLaunch).toHaveBeenCalledWith(null, "claude-desktop");

    expect(dispatchQuickAction(session, ctx)).toEqual({ kind: "switcher-opened" });
    expect(ctx.openSwitcher).toHaveBeenCalledTimes(1);
    expect(ctx.openSwitcher).toHaveBeenCalledWith("Start Claude Code in ");
    expect(ctx.navigate).not.toHaveBeenCalled();
    expect(ctx.notify).not.toHaveBeenCalled();
  });
});

describe("a launch:* capability requests a launch and touches nothing else (D-24, PR-08)", () => {
  it("requests a launch for a project-targeted action, calling requestLaunch exactly once", () => {
    const ctx = context();
    const descriptor: QuickActionDescriptor = {
      id: "x",
      label: "Finder",
      capability: "launch:finder",
      target: { projectId: PROJECT_ID },
    };

    const result = dispatchQuickAction(descriptor, ctx);

    expect(result).toEqual({ kind: "launch-requested", action: "finder" });
    expect(ctx.requestLaunch).toHaveBeenCalledTimes(1);
    expect(ctx.requestLaunch).toHaveBeenCalledWith(PROJECT_ID, "finder");
    expect(ctx.notify).not.toHaveBeenCalled();
    expect(ctx.navigate).not.toHaveBeenCalled();
    expect(ctx.openSwitcher).not.toHaveBeenCalled();
  });

  it("requests claude-desktop with a null projectId when the descriptor carries no target", () => {
    const ctx = context();
    const descriptor: QuickActionDescriptor = {
      id: "x",
      label: "Claude Desktop",
      capability: "launch:claude-desktop",
    };

    const result = dispatchQuickAction(descriptor, ctx);

    expect(result).toEqual({ kind: "launch-requested", action: "claude-desktop" });
    expect(ctx.requestLaunch).toHaveBeenCalledTimes(1);
    expect(ctx.requestLaunch).toHaveBeenCalledWith(null, "claude-desktop");
  });

  it("reports unavailable when a project-targeted action has no target", () => {
    const ctx = context();
    const descriptor: QuickActionDescriptor = {
      id: "x",
      label: "Finder",
      capability: "launch:finder",
    };

    const result = dispatchQuickAction(descriptor, ctx);

    expect(result).toEqual({ kind: "unavailable" });
    expect(ctx.requestLaunch).not.toHaveBeenCalled();
    expect(ctx.notify).toHaveBeenCalledTimes(1);
  });

  it("reports unavailable for an unrecognised launch action", () => {
    const ctx = context();
    const descriptor: QuickActionDescriptor = {
      id: "x",
      label: "Bogus",
      capability: "launch:bogus",
    };

    const result = dispatchQuickAction(descriptor, ctx);

    expect(result).toEqual({ kind: "unavailable" });
    expect(ctx.requestLaunch).not.toHaveBeenCalled();
  });
});

describe("switcher:claude-code opens the switcher and touches nothing else", () => {
  it("opens the switcher prefilled with the Claude Code prompt", () => {
    const ctx = context();
    const descriptor: QuickActionDescriptor = {
      id: "x",
      label: "Claude Code",
      capability: "switcher:claude-code",
    };

    const result = dispatchQuickAction(descriptor, ctx);

    expect(result).toEqual({ kind: "switcher-opened" });
    expect(ctx.openSwitcher).toHaveBeenCalledTimes(1);
    expect(ctx.openSwitcher).toHaveBeenCalledWith("Start Claude Code in ");
    expect(ctx.notify).not.toHaveBeenCalled();
    expect(ctx.navigate).not.toHaveBeenCalled();
    expect(ctx.requestLaunch).not.toHaveBeenCalled();
  });
});

describe("session:* and usage:* descriptors reach the one runner (D-36, 05-17)", () => {
  const SESSION_CAPABILITIES = [
    "session:focus",
    "session:resume",
    "session:branch",
    "session:open-transcript",
    "session:interrupt",
    "session:terminate",
    "session:associate",
    "usage:enable-transcript-analysis",
  ];

  it.each(SESSION_CAPABILITIES)(
    "%s calls ctx.runSessionAction exactly once with it",
    (capability) => {
      const runSessionAction = vi.fn();
      const ctx = { ...context(), runSessionAction };
      const descriptor: QuickActionDescriptor = {
        id: "x",
        label: "A session control",
        capability,
        target: { runId: "run-1" },
      };

      const result = dispatchQuickAction(descriptor, ctx);

      expect(result).toEqual({ kind: "session-action-requested", capability });
      expect(runSessionAction).toHaveBeenCalledTimes(1);
      expect(runSessionAction).toHaveBeenCalledWith(descriptor);
      expect(ctx.navigate).not.toHaveBeenCalled();
      expect(ctx.requestLaunch).not.toHaveBeenCalled();
    },
  );

  it("answers unavailable, calling nothing, when the host wired no runner", () => {
    const ctx = context();
    const descriptor: QuickActionDescriptor = {
      id: "x",
      label: "Focus terminal",
      capability: "session:focus",
    };
    expect(dispatchQuickAction(descriptor, ctx)).toEqual({ kind: "unavailable" });
    expect(ctx.notify).toHaveBeenCalledWith("Focus terminal isn't available yet.");
  });

  it("connect:claude-hooks navigates to settings and posts the exact UI-SPEC Notice", () => {
    const ctx = context();
    const result = dispatchQuickAction(
      {
        id: "connect-claude-hooks",
        label: "Set up Claude hooks",
        capability: "connect:claude-hooks",
      },
      ctx,
    );
    expect(result).toEqual({ kind: "navigated", destination: "settings" });
    expect(ctx.navigate).toHaveBeenCalledWith("settings");
    expect(ctx.notify).toHaveBeenCalledTimes(1);
    expect(ctx.notify).toHaveBeenCalledWith(
      "Claude Code hooks are installed by a command you run yourself. Copy it from Obsidian settings → Claude command center → Claude.",
    );
  });

  it("other connect:* capabilities keep their old copy", () => {
    const ctx = context();
    dispatchQuickAction(CONNECT_GOOGLE, ctx);
    expect(ctx.notify).toHaveBeenCalledWith(
      "Connect Google Calendar and Gmail from Settings → Claude command center once its connector is available.",
    );
  });

  it("the dispatcher names no terminate executor and routes a session:* descriptor to the session runner (SESS-16)", () => {
    expect(DISPATCHER_SOURCE).not.toMatch(/force-terminate|executeTerminate|terminate-execute/);
    const ctx = { ...context(), runSessionAction: vi.fn() };
    const result = dispatchQuickAction(
      { id: "x", label: "Terminate", capability: "session:force-terminate" },
      ctx,
    );
    expect(ctx.runSessionAction).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe("session-action-requested");
  });
});

describe("the dispatcher has no second side-effect channel (T-03-13)", () => {
  it.each(["obsidian", "node:child_process", "child_process", "@ccc/service-api-client"])(
    "never imports %s",
    (specifier) => {
      const importLines = DISPATCHER_SOURCE.split("\n").filter((line) => /^\s*import\b/.test(line));
      const offenders = importLines.filter((line) => line.includes(`"${specifier}"`));
      expect(offenders).toEqual([]);
    },
  );

  it("reaches the outside world only through the injected context", () => {
    // The dispatcher names no global with a side effect. `ctx` is the whole
    // surface, which is what makes the two-outcome guarantee checkable rather
    // than merely stated.
    // Built as regexes, not call-shaped literals: `scripts/check-boundaries.sh`
    // greps tracked plugin files for a network call's literal shape, and this
    // assertion must not trip the very gate it mirrors.
    const calls = ["fetch", "require"].map((name) => new RegExp(`\\b${name}\\s*\\u0028`));
    const globals = ["window", "globalThis", "process"].map((name) => new RegExp(`\\b${name}\\.`));
    for (const forbidden of [...calls, ...globals]) {
      expect(forbidden.test(DISPATCHER_SOURCE)).toBe(false);
    }
  });
});
