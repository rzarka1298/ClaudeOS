import { signal } from "@preact/signals";
import { requestSettingsSection } from "./settings-sections.js";

/**
 * The "Set up launchers" focus hand-off (UI-SPEC S6, D-30): every entry
 * point — the S10 callout button, a launch error's `Set up launchers`
 * action and (plan 04-14) the Obsidian command — calls
 * {@link requestLaunchersFocus} and then navigates to the Settings
 * destination. The Launchers section consumes the request exactly once,
 * moving focus to its heading; reaching Settings by its tab leaves focus
 * where it was.
 *
 * A separate module (rather than living in `launchers-settings.tsx`) so the
 * widgets that offer the action import a single signal, not the whole
 * section and its dependencies.
 *
 * Phase 8 (08-11, D-15): the Settings destination has nine sections and one
 * generic deep link, `requestSettingsSection`. {@link requestLaunchersFocus}
 * is now a wrapper over it for the `launchers` section, so the destination
 * activates Launchers and focuses its heading; the flag below stays for the
 * Launchers section's own once-only consumption, which every existing caller
 * and test still relies on.
 */
export const launchersFocusRequested = signal(false);

export function requestLaunchersFocus(): void {
  launchersFocusRequested.value = true;
  requestSettingsSection("launchers");
}
