import { signal } from "@preact/signals";

/**
 * The Settings destination's nine sections and the one-shot deep link that reaches them
 * (plan 08-02, D-15, UI-SPEC S1).
 *
 * The ids are the deep-link keys and appear in this fixed order in the section nav. Setup
 * actions ("go to section X"), the native tab's pointer row and the Codex launcher row call
 * {@link requestSettingsSection}; the destination consumes the request once with
 * {@link takeSettingsSectionRequest}, activates that section and moves focus to its heading.
 * A plain switch to the Settings tab leaves the signal `null`, so it never moves focus. Memory
 * only, in the style of `launchers-focus.ts`; nothing here is persisted.
 *
 * Obsidian-free and import-light on purpose: the visual harness bundle reaches this module.
 */

/** The section ids, in nav order. */
export const SETTINGS_SECTIONS = [
  "projects",
  "launchers",
  "integrations",
  "approvals-tasks",
  "paths",
  "visual",
  "security",
  "schedules",
  "diagnostics",
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number];

/** The locked nav labels (sentence case; the last is exactly `Diagnostics`). */
export const SETTINGS_SECTION_LABELS: Readonly<Record<SettingsSectionId, string>> = {
  projects: "Projects",
  launchers: "Launchers",
  integrations: "Integrations",
  "approvals-tasks": "Approvals and tasks",
  paths: "Paths",
  visual: "Visual",
  security: "Security",
  schedules: "Schedules",
  diagnostics: "Diagnostics",
};

/** True only for one of the nine ids (a type guard for untrusted values such as a stored link). */
export function isSettingsSectionId(value: unknown): value is SettingsSectionId {
  return typeof value === "string" && (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

/** The pending deep link, or `null`. Only {@link requestSettingsSection} sets it. */
export const settingsSectionRequested = signal<SettingsSectionId | null>(null);

/** Asks the Settings destination to show `id`. An unknown id is ignored and changes nothing. */
export function requestSettingsSection(id: SettingsSectionId): void {
  if (!isSettingsSectionId(id)) return;
  settingsSectionRequested.value = id;
}

/** Reads the pending request and clears it: the value is returned exactly once. */
export function takeSettingsSectionRequest(): SettingsSectionId | null {
  const pending = settingsSectionRequested.peek();
  settingsSectionRequested.value = null;
  return pending;
}
