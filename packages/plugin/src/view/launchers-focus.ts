import { signal } from "@preact/signals";

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
 */
export const launchersFocusRequested = signal(false);

export function requestLaunchersFocus(): void {
  launchersFocusRequested.value = true;
}
