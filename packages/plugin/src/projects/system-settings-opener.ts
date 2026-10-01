import type { SystemSettingsPane } from "@ccc/domain";

/**
 * The Notice a failed System Settings open posts (wave-5 review finding 6).
 * Constant per pane: it names where to go by hand and never carries the
 * failure's own message, which could name a socket path (SC-3).
 */
export const SYSTEM_SETTINGS_OPEN_FAILED_NOTICE: Readonly<Record<SystemSettingsPane, string>> = {
  automation:
    "System Settings didn't open. Open System Settings › Privacy & Security › Automation yourself.",
  "privacy-security":
    "System Settings didn't open. Open System Settings › Privacy & Security yourself.",
};

/**
 * Binds the RR-16 route to the view host's notice port: the returned
 * function fires the open and, if it rejects (service refused, `open`
 * failed, or the socket is unreachable), posts the pane's constant Notice.
 * It never rejects and never throws.
 */
export function createSystemSettingsOpener(
  open: (pane: SystemSettingsPane) => Promise<unknown>,
  notify: (message: string) => void,
): (pane: SystemSettingsPane) => void {
  return (pane) => {
    let pending: Promise<unknown>;
    try {
      pending = open(pane);
    } catch {
      notify(SYSTEM_SETTINGS_OPEN_FAILED_NOTICE[pane]);
      return;
    }
    pending.catch(() => {
      notify(SYSTEM_SETTINGS_OPEN_FAILED_NOTICE[pane]);
    });
  };
}
