import { SIZE_HINTS } from "@ccc/domain";
import { cleanup, render } from "@testing-library/preact";
import { h } from "preact";
import { afterEach, describe, expect, it } from "vitest";
import { FEATURE_FLAGS } from "./feature-flags.js";
import { WidgetFrame } from "./frame.js";
import {
  type AnyWidgetDefinition,
  isWidgetId,
  PRD_PANEL_ORDER,
  WIDGET_IDS,
  WIDGETS,
  type WidgetId,
} from "./registry.js";
import { serviceHealthState } from "./service-health.js";
import { widgetStateFor } from "./widget-data.js";

/**
 * The UI-04 contract test (research Pattern 2, threat T-03-04).
 *
 * It is table-driven over `Object.entries(WIDGETS)` rather than written once
 * per widget on purpose: a widget added in Phase 4, 5, 6 or 7 is measured by
 * these same assertions the moment it is registered, with nobody having to
 * remember to extend this file. A definition that drops its data keys, names
 * a source by PATH instead of display name, invents a size, or references an
 * unregistered feature flag fails here at the commit that introduces it.
 *
 * The honest-state block below is the D-17 rule made checkable: every PRD §7.1
 * panel is `permission-required` or `unavailable` by CONSTANT, so there is no
 * code path through which fixture data could reach a plugin card at all.
 */

const NOW = Date.parse("2026-09-15T00:10:00.000Z");

afterEach(cleanup);

/** The eight titles UI-SPEC "Widget titles" fixes by contract. */
const FIXED_TITLES: ReadonlySet<string> = new Set([
  "Service health",
  "Today",
  "Active Claude sessions",
  "Project shortcuts",
  "Claude usage",
  "Technology and market intelligence",
  "GitHub discoveries",
  "Quick actions",
]);

/**
 * Proper nouns that keep their capitals mid-sentence (UI-SPEC Copywriting
 * Contract: "Proper nouns keep their capitals"). `Claude Code` and
 * `Claude Desktop` are product names, so both halves are listed.
 */
const PROPER_NOUNS: ReadonlySet<string> = new Set([
  "Calendar",
  "Claude",
  "Code",
  "Desktop",
  "Gmail",
  "GitHub",
  "Google",
]);

/** Words that break sentence case, or `["(first word)"]` if the head is lowercase. */
function sentenceCaseViolations(text: string): readonly string[] {
  const words = text.split(" ").filter((word) => word.length > 0);
  const first = words[0];
  if (first === undefined) return ["(empty)"];
  const head = first.charAt(0);
  const offenders: string[] = head === head.toUpperCase() ? [] : ["(first word)"];
  for (const word of words.slice(1)) {
    const initial = word.charAt(0);
    if (initial === initial.toLowerCase()) continue;
    if (PROPER_NOUNS.has(word)) continue;
    offenders.push(word);
  }
  return offenders;
}

const REFRESH_KINDS: ReadonlySet<string> = new Set(["event-driven", "interval", "manual"]);

const ENTRIES = Object.entries(WIDGETS) as readonly [WidgetId, AnyWidgetDefinition][];

describe("every registered widget satisfies the full UI-04 contract", () => {
  it.each(ENTRIES)("%s: id, title and copy", (key, definition) => {
    expect(definition.id).toBe(key);
    expect(FIXED_TITLES.has(definition.title)).toBe(true);
    expect(sentenceCaseViolations(definition.title)).toEqual([]);
  });

  it.each(ENTRIES)("%s: data keys are display names, never paths (T-03-04)", (_key, definition) => {
    expect(definition.dataKeys.length).toBeGreaterThan(0);
    for (const dataKey of definition.dataKeys) {
      expect(dataKey.key.length).toBeGreaterThan(0);
      expect(dataKey.sourceLabel.length).toBeGreaterThan(0);
      expect(["service", "local"]).toContain(dataKey.transport);
      // A label carrying a path separator would put the owner's home
      // directory into every committed baseline screenshot (PRIV-04).
      expect(dataKey.sourceLabel).not.toContain("/");
      expect(dataKey.sourceLabel).not.toContain("\\");
    }
  });

  it.each(ENTRIES)("%s: refresh policy and size hints", (_key, definition) => {
    expect(REFRESH_KINDS.has(definition.refresh.kind)).toBe(true);
    if (definition.refresh.kind === "interval") {
      expect(definition.refresh.everyMs).toBeGreaterThan(0);
    }
    expect(SIZE_HINTS).toContain(definition.minSize);
    expect(SIZE_HINTS).toContain(definition.preferredSize);
  });

  it.each(ENTRIES)("%s: its feature flag is registered", (_key, definition) => {
    expect(Object.keys(FEATURE_FLAGS)).toContain(definition.featureFlag);
  });

  it.each(ENTRIES)(
    "%s: quick actions are unique, sentence-case descriptors",
    (_key, definition) => {
      const ids = definition.quickActions.map((action) => action.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const action of definition.quickActions) {
        expect(action.id.length).toBeGreaterThan(0);
        expect(action.capability.length).toBeGreaterThan(0);
        expect(sentenceCaseViolations(action.label)).toEqual([]);
      }
    },
  );

  it.each(ENTRIES)("%s: renders a body and an empty body", (_key, definition) => {
    expect(typeof definition.renderBody).toBe("function");
    expect(typeof definition.renderEmpty).toBe("function");
  });
});

describe("the registry's shape", () => {
  it("registers exactly eight widgets", () => {
    expect(WIDGET_IDS).toHaveLength(8);
    expect(new Set(WIDGET_IDS).size).toBe(8);
  });

  it("lists the seven PRD §7.1 panels in the PRD's own order", () => {
    expect(PRD_PANEL_ORDER).toEqual([
      "today",
      "active-sessions",
      "project-shortcuts",
      "claude-usage",
      "tech-intel",
      "github-discoveries",
      "quick-actions",
    ]);
  });

  it("narrows an unknown string to a WidgetId", () => {
    expect(isWidgetId("today")).toBe(true);
    expect(isWidgetId("constructor")).toBe(false);
    expect(isWidgetId("not-a-widget")).toBe(false);
  });

  it("flags every registered widget on, in code, with no persisted state (ADR-0023)", () => {
    const flags = Object.entries(FEATURE_FLAGS);
    expect(flags).toHaveLength(8);
    expect(flags.every(([, enabled]) => enabled)).toBe(true);
  });
});

describe("honest panel states (D-17, ADR-0023 Panel state assignment)", () => {
  it("returns the live service-health signal itself, not a copy of its value", () => {
    expect(widgetStateFor("service-health")).toBe(serviceHealthState);
  });

  it("gates Today behind the google capability", () => {
    expect(widgetStateFor("today").value).toEqual({
      kind: "permission-required",
      capability: "google",
      sourceLabel: "Google Calendar and Gmail",
    });
  });

  it("gates GitHub discoveries behind the github capability", () => {
    expect(widgetStateFor("github-discoveries").value).toEqual({
      kind: "permission-required",
      capability: "github",
      sourceLabel: "GitHub",
    });
  });

  it.each(["active-sessions", "claude-usage", "tech-intel", "quick-actions"])(
    "%s has no source yet",
    (id) => {
      expect(widgetStateFor(id as WidgetId).value.kind).toBe("unavailable");
    },
  );

  it("project-shortcuts is a live signal now (plan 04-07, D-35): loading before a snapshot arrives, never a hardcoded unavailable", () => {
    expect(widgetStateFor("project-shortcuts").value.kind).toBe("loading");
  });
});

describe("a registered panel renders its honest state through the shared frame", () => {
  function renderWidget(id: WidgetId) {
    // The registry hands out `AnyWidgetDefinition` (`WidgetDefinition<never>`
    // — see registry.ts), which is exactly what the Overview grid renders. The
    // frame is instantiated at `never` explicitly because `h()` cannot infer a
    // generic component's parameter from its props.
    const definition: AnyWidgetDefinition = WIDGETS[id];
    return render(
      h(WidgetFrame<never>, {
        definition,
        state: widgetStateFor(id).value,
        connection: { kind: "live" },
        now: NOW,
      }),
    );
  }

  it("Today asks to connect Google Calendar and Gmail, and executes nothing", () => {
    const { container } = renderWidget("today");
    const card = container.querySelector("section.ccc-card");

    expect(card?.getAttribute("data-presentation")).toBe("permission-required");
    expect(card?.textContent).toContain("Google Calendar and Gmail isn't connected");

    const labels = [...container.querySelectorAll("button")].map((button) => button.textContent);
    expect(labels).toEqual(["Connect Google Calendar and Gmail", "Source"]);
  });

  it("Active Claude sessions says it has no source yet", () => {
    const { container } = renderWidget("active-sessions");
    const card = container.querySelector("section.ccc-card");

    expect(card?.getAttribute("data-presentation")).toBe("unavailable");
    expect(card?.textContent).toContain("No source yet");
  });
});
