import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionState } from "../connection-state.js";
import type { LaunchersActions } from "../projects/launchers-actions.js";
import { navigationRequest } from "./navigation-request.js";
import { SECTION_VIEWS } from "./settings-destination.js";
import { SETTINGS_SECTION_LABELS, takeSettingsSectionRequest } from "./settings-sections.js";
import { Shell } from "./shell.js";

/**
 * FIX2B M3: the Phase 8 stylesheet section must not restyle the Phase 4 panels the Settings
 * sections embed. The frame's own headings carry explicit classes, and no Phase 8 selector
 * matches a `.ccc-section-label` (or any heading that is not the frame's own) inside the
 * destination, in any registered section.
 */

const STYLESHEET = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "styles.css"),
  "utf8",
);

/** The selectors of the Phase 8 section, minus pseudo-classes a static DOM cannot evaluate. */
function phase8Selectors(): string[] {
  const banner = STYLESHEET.indexOf("Phase 8 - Settings, Diagnostics");
  const start = STYLESHEET.lastIndexOf("/*", banner);
  const end = STYLESHEET.indexOf("/* Phase 05.1 wave-5 visual fixes");
  const code = STYLESHEET.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, "");
  const selectors: string[] = [];
  for (const match of code.matchAll(/([^{};]+)\{/g)) {
    const prelude = (match[1] ?? "").trim();
    if (prelude.startsWith("@")) continue;
    for (const selector of prelude.split(",")) {
      selectors.push(
        selector
          .replace(/::?(?:focus-visible|hover|focus|before|after|-webkit-[\w-]+)/g, "")
          .replace(/\s+/g, " ")
          .trim(),
      );
    }
  }
  return selectors;
}

const PENDING_LAUNCHERS: LaunchersActions = {
  detect: () => new Promise<never>(() => {}),
  getConfigs: () => new Promise<never>(() => {}),
  save: vi.fn(),
  test: vi.fn(),
  markTested: vi.fn(),
  openSystemSettings: vi.fn(),
  codexDoctor: vi.fn(),
};

beforeEach(() => {
  connectionState.value = { kind: "live" };
});

afterEach(() => {
  cleanup();
  connectionState.value = { kind: "connecting" };
  takeSettingsSectionRequest();
  navigationRequest.value = null;
});

describe("FIX2B M3: section headings are explicit, embedded Phase 4 headings are untouched", () => {
  const ids = Object.keys(SECTION_VIEWS) as (keyof typeof SETTINGS_SECTION_LABELS)[];

  it.each(ids)(
    "%s: its h3 is the section title, and no Phase 8 rule matches an embedded heading",
    (id) => {
      // The Shell wraps the destination in `.ccc-command-center`, which the rules are scoped under.
      const { container } = render(
        <Shell initialDestination="settings" launchersActions={PENDING_LAUNCHERS} />,
      );
      fireEvent.click(
        within(screen.getByRole("navigation", { name: "Settings sections" })).getByRole("button", {
          name: SETTINGS_SECTION_LABELS[id],
        }),
      );
      const content = container.querySelector(".ccc-settings-content");
      expect(content).not.toBeNull();
      const title = content?.querySelector('h3[tabindex="-1"]');
      expect(title?.classList.contains("ccc-settings-section-title")).toBe(true);

      const selectors = phase8Selectors();
      // A section's own sub-headings carry the frame's explicit classes (`h4.ccc-settings-group-title`,
      // `h5.ccc-settings-item-title`) and are meant to match them; an embedded Phase 4 heading never does.
      const embedded = [...(content?.querySelectorAll("h3, h4, h5") ?? [])].filter(
        (heading) =>
          heading !== title &&
          !heading.classList.contains("ccc-settings-group-title") &&
          !heading.classList.contains("ccc-settings-item-title"),
      );
      for (const heading of embedded) {
        for (const selector of selectors) {
          expect(
            heading.matches(selector),
            `${selector} matches <${heading.tagName.toLowerCase()} class="${heading.className}">`,
          ).toBe(false);
        }
      }
    },
  );
});
