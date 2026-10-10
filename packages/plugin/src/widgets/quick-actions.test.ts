import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProjectId } from "@ccc/domain";
import { CAPABILITY_OPERATION, classifyCapability } from "@ccc/domain/classification.js";
import { describe, expect, it, vi } from "vitest";
import type { QuickActionDescriptor } from "./contract.js";
import { dispatchQuickAction } from "./quick-actions.js";
import { WIDGETS } from "./registry.js";

/**
 * The approval-boundary seam (C-11, APPR-01, APPR-02, threat T-03-13, T-06-32).
 *
 * `dispatchQuickAction` is the SINGLE place every widget's quick action is
 * resolved. Plan 06-10 amends this deliberately (D-06): the old two-outcome
 * guarantee ("navigate or say unavailable") became a classified one. Before
 * any direct branch it asks the domain classification table what the
 * capability is; an approval-required one is never executed here, it only
 * reports `proposal-requested`, and a reserved or unknown one fails closed.
 * The service route stays the authority; this is the UX gate in front of it.
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
  // (D-38, PR-08) and plan 06-10 makes a third, `task:create`, live (D-37);
  // every OTHER declared action still executes nothing.
  const UNAVAILABLE_QUICK_ACTIONS = WIDGETS["quick-actions"].quickActions.filter(
    (action) =>
      !action.capability.startsWith("launch:") &&
      !action.capability.startsWith("switcher:") &&
      action.capability !== "task:create",
  );

  it("three Quick actions stay unavailable in this phase (amended in 06-10: task:create is live)", () => {
    expect(UNAVAILABLE_QUICK_ACTIONS.map((action) => action.id)).toEqual([
      "run-skill",
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

  it("the dispatcher names no terminate executor and answers an unclassified session:* string unavailable (SESS-16, amended in 06-10)", () => {
    expect(DISPATCHER_SOURCE).not.toMatch(/force-terminate|executeTerminate|terminate-execute/);
    const ctx = { ...context(), runSessionAction: vi.fn() };
    // `session:force-terminate` is the OPERATION name, not a descriptor
    // capability string: the table does not know it, so it fails closed instead
    // of reaching the runner (before 06-10 it did).
    const result = dispatchQuickAction(
      { id: "x", label: "Terminate", capability: "session:force-terminate" },
      ctx,
    );
    expect(result).toEqual({ kind: "unavailable" });
    expect(ctx.runSessionAction).not.toHaveBeenCalled();
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

describe("classification before every branch (plan 06-10, D-06, APPR-02, T-06-15)", () => {
  const TERMINATE: QuickActionDescriptor = {
    id: "terminate",
    label: "Force-terminate",
    capability: "session:terminate",
    target: { runId: "run-1" },
  };

  it("Test 1: an enabled approval-required capability asks for a proposal and executes nothing", () => {
    const requestProposal = vi.fn();
    const runSessionAction = vi.fn();
    const ctx = { ...context(), requestProposal, runSessionAction };

    const result = dispatchQuickAction(TERMINATE, ctx);

    expect(result).toEqual({ kind: "proposal-requested", operation: "session.force-terminate" });
    expect(requestProposal).toHaveBeenCalledTimes(1);
    expect(requestProposal).toHaveBeenCalledWith(TERMINATE);
    expect(runSessionAction).not.toHaveBeenCalled();
    expect(ctx.navigate).not.toHaveBeenCalled();
    expect(ctx.requestLaunch).not.toHaveBeenCalled();
    expect(ctx.openSwitcher).not.toHaveBeenCalled();
    expect(ctx.notify).not.toHaveBeenCalled();
  });

  it("Test 1: without a requestProposal member the answer is unavailable with the standard Notice", () => {
    const runSessionAction = vi.fn();
    const ctx = { ...context(), runSessionAction };
    expect(dispatchQuickAction(TERMINATE, ctx)).toEqual({ kind: "unavailable" });
    expect(ctx.notify).toHaveBeenCalledWith("Force-terminate isn't available yet.");
    expect(runSessionAction).not.toHaveBeenCalled();
  });

  it.each([
    ["a reserved capability", "skill:run"],
    ["an unknown capability", "vault:erase-everything"],
    ["a table operation name used as a descriptor string", "session.force-terminate"],
    ["an empty connect family", "connect:"],
    ["a prototype member name", "constructor"],
  ])(
    "Test 2: %s is unavailable, calls only notify, and never requests a proposal",
    (_n, capability) => {
      const requestProposal = vi.fn();
      const runSessionAction = vi.fn();
      const requestTaskForm = vi.fn();
      const ctx = { ...context(), requestProposal, runSessionAction, requestTaskForm };

      const result = dispatchQuickAction({ id: "x", label: "Thing", capability }, ctx);

      expect(result).toEqual({ kind: "unavailable" });
      expect(ctx.notify).toHaveBeenCalledWith("Thing isn't available yet.");
      expect(ctx.notify).toHaveBeenCalledTimes(1);
      expect(requestProposal).not.toHaveBeenCalled();
      expect(runSessionAction).not.toHaveBeenCalled();
      expect(requestTaskForm).not.toHaveBeenCalled();
      expect(ctx.navigate).not.toHaveBeenCalled();
      expect(ctx.requestLaunch).not.toHaveBeenCalled();
      expect(ctx.openSwitcher).not.toHaveBeenCalled();
    },
  );
});

describe("table-driven over every R-CAPS descriptor string (plan 06-10, Test 3)", () => {
  type Expectation =
    | { kind: "navigated"; destination: string }
    | { kind: "launch-requested"; action: string }
    | { kind: "switcher-opened" }
    | { kind: "session-action-requested" }
    | { kind: "proposal-requested"; operation: string }
    | { kind: "unavailable" };

  // One expectation per capability string, named by the same strings the
  // domain's `CAPABILITY_OPERATION` map carries (06-RECONCILE.md R-CAPS). A new
  // string added there without an expectation here fails the coverage test.
  const EXPECTED: Readonly<Record<string, Expectation>> = {
    "launch:antigravity": { kind: "launch-requested", action: "antigravity" },
    "launch:claude-code": { kind: "launch-requested", action: "claude-code" },
    "launch:finder": { kind: "launch-requested", action: "finder" },
    "launch:github": { kind: "launch-requested", action: "github" },
    "launch:claude-desktop": { kind: "launch-requested", action: "claude-desktop" },
    "switcher:claude-code": { kind: "switcher-opened" },
    "session:focus": { kind: "session-action-requested" },
    "session:resume": { kind: "session-action-requested" },
    "session:branch": { kind: "session-action-requested" },
    "session:open-transcript": { kind: "session-action-requested" },
    "session:interrupt": { kind: "session-action-requested" },
    "session:associate": { kind: "session-action-requested" },
    "session:terminate": { kind: "proposal-requested", operation: "session.force-terminate" },
    "usage:enable-transcript-analysis": { kind: "session-action-requested" },
    "skill:run": { kind: "unavailable" },
    "task:create": { kind: "navigated", destination: "tasks" },
    "note:capture": { kind: "unavailable" },
    "data:refresh": { kind: "unavailable" },
    // Phase 05.1 wave 2 rows (plan 02). The dispatcher arms for these land in
    // plans 17 and 18, which replace these placeholders with real outcomes.
    "launch:codex": { kind: "unavailable" },
    "launch:claude-codex-pair": { kind: "unavailable" },
    "codex:open-transcript": { kind: "unavailable" },
    "codex:follow-log": { kind: "unavailable" },
  };

  /** The connect family is matched by prefix; every R-CAPS example resolves the same way. */
  const CONNECT_STRINGS = ["connect:claude-hooks", "connect:google", "connect:github"];

  it("has an expectation for every capability string the domain table carries, and no extra", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(Object.keys(CAPABILITY_OPERATION).sort());
  });

  it.each(Object.entries(EXPECTED))(
    "%s resolves to its class's outcome",
    (capability, expected) => {
      const ctx = {
        ...context(),
        runSessionAction: vi.fn(),
        requestProposal: vi.fn(),
        requestTaskForm: vi.fn(),
      };
      const descriptor: QuickActionDescriptor = {
        id: "x",
        label: "An action",
        capability,
        target: { projectId: PROJECT_ID },
      };

      const result = dispatchQuickAction(descriptor, ctx);

      expect(result.kind).toBe(expected.kind);
      if (expected.kind === "navigated" && result.kind === "navigated") {
        expect(result.destination).toBe(expected.destination);
      }
      if (expected.kind === "launch-requested" && result.kind === "launch-requested") {
        expect(result.action).toBe(expected.action);
      }
      if (expected.kind === "proposal-requested" && result.kind === "proposal-requested") {
        expect(result.operation).toBe(expected.operation);
      }
      // Only an approval-required capability may reach the proposal member, and
      // a proposal request never reaches any executing member.
      expect(ctx.requestProposal).toHaveBeenCalledTimes(
        expected.kind === "proposal-requested" ? 1 : 0,
      );
      if (expected.kind === "proposal-requested") {
        expect(ctx.runSessionAction).not.toHaveBeenCalled();
        expect(ctx.requestLaunch).not.toHaveBeenCalled();
      }
    },
  );

  it.each(CONNECT_STRINGS)(
    "%s navigates to settings (direct gesture, no approval)",
    (capability) => {
      const ctx = { ...context(), requestProposal: vi.fn() };
      const result = dispatchQuickAction({ id: "x", label: "Connect Something", capability }, ctx);
      expect(result).toEqual({ kind: "navigated", destination: "settings" });
      expect(ctx.requestProposal).not.toHaveBeenCalled();
    },
  );

  it("every classified string's outcome class agrees with the domain class", () => {
    for (const [capability, expected] of Object.entries(EXPECTED)) {
      const classified = classifyCapability(capability);
      expect(classified, capability).toBeDefined();
      const isApproval = classified?.row.class === "approval-required";
      if (expected.kind === "proposal-requested") expect(isApproval).toBe(true);
      if (isApproval && classified?.row.class === "approval-required") {
        expect(
          classified.row.status === "enabled"
            ? expected.kind === "proposal-requested"
            : expected.kind === "unavailable",
          capability,
        ).toBe(true);
      }
    }
  });
});

describe("task:create is a live branch (plan 06-10, Test 4, D-37, D-05)", () => {
  const CREATE_TASK: QuickActionDescriptor = {
    id: "create-task",
    label: "Create a task",
    capability: "task:create",
  };

  it("navigates to Tasks and asks the context to open the create form", () => {
    const requestTaskForm = vi.fn();
    const ctx = { ...context(), requestTaskForm };
    const result = dispatchQuickAction(CREATE_TASK, ctx);
    expect(result).toEqual({ kind: "navigated", destination: "tasks" });
    expect(ctx.navigate).toHaveBeenCalledTimes(1);
    expect(ctx.navigate).toHaveBeenCalledWith("tasks");
    expect(requestTaskForm).toHaveBeenCalledTimes(1);
    expect(ctx.notify).not.toHaveBeenCalled();
  });

  it("is classified no-approval and still navigates when the context has no request member", () => {
    expect(classifyCapability("task:create")?.row.class).toBe("no-approval");
    const ctx = context();
    expect(dispatchQuickAction(CREATE_TASK, ctx)).toEqual({
      kind: "navigated",
      destination: "tasks",
    });
    expect(ctx.navigate).toHaveBeenCalledWith("tasks");
  });
});

describe("the amended dispatcher stays free of side-effect channels (plan 06-10, Test 5, T-06-32)", () => {
  const CODE_ONLY = DISPATCHER_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("imports the classification function from the domain's browser-safe deep path", () => {
    expect(DISPATCHER_SOURCE).toMatch(
      /import\s*\{[^}]*\bclassifyCapability\b[^}]*\}\s*from\s*"@ccc\/domain\/classification\.js"/,
    );
  });

  it("imports no obsidian, child_process or service client module and names no side-effecting global", () => {
    const imports = CODE_ONLY.split("\n").filter((line) => /^\s*import\b/.test(line));
    for (const forbidden of ["obsidian", "child_process", "service-api-client", "node:"]) {
      expect(imports.filter((line) => line.includes(forbidden))).toEqual([]);
    }
    for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "setTimeout", "localStorage"]) {
      expect(new RegExp(`\\b${name}\\b`).test(CODE_ONLY), name).toBe(false);
    }
  });

  it("the header comment lists the five outcomes and no longer forbids a fifth", () => {
    const header = DISPATCHER_SOURCE.slice(0, DISPATCHER_SOURCE.indexOf("export interface"));
    expect(header).not.toMatch(/never grow a fifth|MUST NEVER grow/i);
    expect(header).toMatch(/five outcomes/i);
    expect(header).toMatch(/proposal-requested/);
    expect(header).toMatch(/executes nothing/i);
  });
});
