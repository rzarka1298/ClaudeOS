import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, render } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuickActionDescriptor } from "./contract.js";
import { ENABLED_FLAGS, FEATURE_FLAGS } from "./feature-flags.js";
import { WidgetFrame } from "./frame.js";
import { dispatchQuickAction } from "./quick-actions.js";
import { type AnyWidgetDefinition, PRD_PANEL_ORDER, WIDGET_IDS, WIDGETS } from "./registry.js";
import { widgetStateFor } from "./widget-data.js";

/**
 * Test-audit additions for plan 03-06: seams the original suite touched only
 * by value, re-checked by identity, by source scan and end to end.
 */

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse("2026-09-15T00:10:00.000Z");

afterEach(cleanup);

describe("widgetStateFor is one signal per widget", () => {
  it.each(WIDGET_IDS)("%s: repeated reads return the same signal", (id) => {
    expect(widgetStateFor(id)).toBe(widgetStateFor(id));
  });

  it("gives every widget its own signal", () => {
    const signals = WIDGET_IDS.map((id) => widgetStateFor(id));
    expect(new Set(signals).size).toBe(WIDGET_IDS.length);
  });

  // 05-06: `active-sessions` is excluded — it is the one PRD panel this
  // phase gives a real route, so its state is a live derivation
  // (`session-signals.ts`'s `activeSessionsState`), never a constant. The
  // D-17 property it must still hold — no fixture data reaches it — is
  // checked below by source scan and by its honest pre-connection state.
  // `project-shortcuts` and `quick-actions` are real too (Phase 4).
  // Plan 08-14: `today` is service-fed too (a computed over the Overview feeds).
  const CONSTANT_PANEL_ORDER = PRD_PANEL_ORDER.filter(
    (id) =>
      id !== "today" &&
      id !== "active-sessions" &&
      id !== "project-shortcuts" &&
      id !== "quick-actions" &&
      id !== "codex",
  );

  it.each(CONSTANT_PANEL_ORDER)("%s: never holds a ready payload (D-17)", (id) => {
    expect(["permission-required", "unavailable"]).toContain(widgetStateFor(id).value.kind);
  });

  // quick-actions is real now (plan 04-10, D-38): fed by the launcher summary
  // in the projects snapshot. Its honest-state coverage lives in
  // projects-state.test.ts and panels.test.tsx.
  it("quick-actions: loading before any snapshot has arrived", () => {
    expect(widgetStateFor("quick-actions").value.kind).toBe("loading");
  });

  // project-shortcuts is real now (plan 04-07, D-35): a service-fed signal,
  // not a D-17 constant. Its own honest-state coverage lives in
  // projects-state.test.ts and panels.test.tsx.
  it("project-shortcuts: loading before any snapshot has arrived", () => {
    expect(widgetStateFor("project-shortcuts").value.kind).toBe("loading");
  });

  it("active-sessions: derives from the live connection, never a fixture (D-17)", () => {
    // Fresh module load, nothing has connected and no session has ever been
    // observed: the one honest thing left to say is `loading`.
    expect(widgetStateFor("active-sessions").value.kind).toBe("loading");
  });
});

describe("feature flags are one in-code flag per widget", () => {
  it("each widget owns a distinct flag, and ENABLED_FLAGS is exactly those", () => {
    const flags = WIDGET_IDS.map((id) => WIDGETS[id].featureFlag);
    expect(new Set(flags).size).toBe(WIDGET_IDS.length);
    expect([...ENABLED_FLAGS].sort()).toEqual([...flags].sort());
    expect(Object.keys(FEATURE_FLAGS).sort()).toEqual([...flags].sort());
  });

  it("nothing in the widget layer persists or reads flags from storage", () => {
    for (const file of ["feature-flags.ts", "registry.ts", "widget-data.ts"]) {
      const source = readFileSync(join(SRC_DIR, file), "utf8");
      expect(source).not.toMatch(/loadData|saveData|localStorage|sessionStorage/);
    }
  });
});

describe("no plugin card is backed by fixture data (D-17)", () => {
  it.each(["panels.tsx", "registry.ts", "widget-data.ts", "list-body.tsx", "frame.tsx"])(
    "%s imports no fixture module",
    (file) => {
      const imports = readFileSync(join(SRC_DIR, file), "utf8")
        .split("\n")
        .filter((line) => /^\s*import\b|from\s+["']/.test(line));
      for (const line of imports) expect(line).not.toMatch(/fixture|mock/i);
    },
  );
});

// Plan 08-14 (research B 2.8, layer 2): the Today feed module is production code
// on the Overview path, so it is held to the same rule as the widget table.
describe("the Overview feed module reads no fixture, harness or JSON (D-22)", () => {
  it("overview-feeds.ts imports no fixture, mock, harness, client package or JSON module", () => {
    const source = readFileSync(join(SRC_DIR, "../overview/overview-feeds.ts"), "utf8");
    const imports = source.split("\n").filter((line) => /^\s*import\b|from\s+["']/.test(line));
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) {
      expect(line).not.toMatch(/fixture|mock|harness|test-support|\.json|service-api-client/i);
    }
  });
});

describe("every button on every registered card routes through the dispatcher", () => {
  it.each(WIDGET_IDS.filter((id) => id !== "service-health"))(
    "%s: clicking every action only ever navigates to settings",
    (id) => {
      const definition: AnyWidgetDefinition = WIDGETS[id];
      const ctx = {
        navigate: vi.fn(),
        notify: vi.fn(),
        requestLaunch: vi.fn(),
        openSwitcher: vi.fn(),
      };
      const emitted: QuickActionDescriptor[] = [];
      const { container } = render(
        <WidgetFrame
          definition={definition}
          state={widgetStateFor(id).value}
          connection={{ kind: "live" }}
          now={NOW}
          onQuickAction={(descriptor) => {
            emitted.push(descriptor);
            dispatchQuickAction(descriptor, ctx);
          }}
        />,
      );
      for (const button of container.querySelectorAll(
        "button.ccc-connect-button, button.ccc-quick-action",
      )) {
        fireEvent.click(button);
      }
      for (const call of ctx.navigate.mock.calls) expect(call).toEqual(["settings"]);
      expect(ctx.notify).toHaveBeenCalledTimes(emitted.length);
      const connects = emitted.filter((d) => d.capability.startsWith("connect:"));
      expect(ctx.navigate).toHaveBeenCalledTimes(connects.length);
    },
  );

  // Rewritten, not deleted (plan 08-14): Today used to carry a Connect button for
  // Google Calendar and Gmail. Both are now named as not part of this version, so
  // the card offers no way to "connect" them and emits no `connect:` descriptor;
  // GitHub discoveries keeps the one Connect button the dispatcher still routes.
  it("Today offers no Connect control for Google Calendar and Gmail, and emits nothing", () => {
    const emitted: QuickActionDescriptor[] = [];
    const { container, queryByRole } = render(
      <WidgetFrame
        definition={WIDGETS.today as AnyWidgetDefinition}
        state={widgetStateFor("today").value}
        connection={{ kind: "live" }}
        now={NOW}
        onQuickAction={(descriptor) => emitted.push(descriptor)}
      />,
    );
    expect(queryByRole("button", { name: /^Connect/ })).toBeNull();
    for (const button of container.querySelectorAll("button")) fireEvent.click(button);
    expect(emitted).toEqual([]);
  });

  it("GitHub discoveries' Connect button still lands on settings and names GitHub", () => {
    const ctx = {
      navigate: vi.fn(),
      notify: vi.fn(),
      requestLaunch: vi.fn(),
      openSwitcher: vi.fn(),
    };
    const { getByRole } = render(
      <WidgetFrame
        definition={WIDGETS["github-discoveries"] as AnyWidgetDefinition}
        state={widgetStateFor("github-discoveries").value}
        connection={{ kind: "live" }}
        now={NOW}
        onQuickAction={(descriptor) => dispatchQuickAction(descriptor, ctx)}
      />,
    );
    fireEvent.click(getByRole("button", { name: "Connect GitHub" }));
    expect(ctx.navigate).toHaveBeenCalledExactlyOnceWith("settings");
    expect(ctx.notify.mock.calls[0]?.[0]).toMatch(/GitHub.*Settings/);
  });

  // SC-6 (rewritten, not deleted): the live Quick actions (D-38, PR-08, and
  // `task:create` from plan 06-10) are covered in quick-actions.test.ts; every
  // other one still reports unavailable.
  it("every not-yet-live PRD quick action reports unavailable and never navigates", () => {
    const notLive = WIDGETS["quick-actions"].quickActions.filter(
      (action) =>
        !action.capability.startsWith("launch:") &&
        !action.capability.startsWith("switcher:") &&
        action.capability !== "task:create",
    );
    expect(notLive).toHaveLength(3);
    for (const action of notLive) {
      const ctx = {
        navigate: vi.fn(),
        notify: vi.fn(),
        requestLaunch: vi.fn(),
        openSwitcher: vi.fn(),
      };
      expect(dispatchQuickAction(action, ctx)).toEqual({ kind: "unavailable" });
      expect(ctx.navigate).not.toHaveBeenCalled();
      expect(ctx.notify).toHaveBeenCalledWith(`${action.label} isn't available yet.`);
    }
  });
});
