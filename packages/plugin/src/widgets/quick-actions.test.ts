import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  return { navigate: vi.fn(), notify: vi.fn() };
}

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

  it.each(WIDGETS["quick-actions"].quickActions.map((action) => [action.label, action] as const))(
    "%s executes nothing in this phase",
    (_label, action) => {
      const ctx = context();
      expect(dispatchQuickAction(action, ctx)).toEqual({ kind: "unavailable" });
      expect(ctx.navigate).not.toHaveBeenCalled();
    },
  );
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
