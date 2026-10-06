/**
 * The one place a view shows the owner a transient message (plan 06-10).
 *
 * The approvals and Tasks views call {@link notify} instead of importing
 * Obsidian's notice function, so they stay renderable anywhere and testable
 * with no host. The wiring plan (06-23) connects this port to Obsidian once,
 * with {@link configureNotify}. Imports nothing, on purpose.
 */

type NotifyFunction = (message: string) => void;

function noNotify(_message: string): void {}

let current: NotifyFunction = noNotify;

/** Installs the function messages go to, or, with `null`, restores the no-op. */
export function configureNotify(fn: NotifyFunction | null): void {
  current = fn ?? noNotify;
}

/** Shows `message` to the owner. Never throws: a failing notice must not break the action that raised it. */
export function notify(message: string): void {
  try {
    current(message);
  } catch {
    // Swallowed deliberately: the message is a courtesy, not the action.
  }
}
