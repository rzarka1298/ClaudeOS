import type { LaunchAction } from "@ccc/domain";

/**
 * STUB (Task 1 RED phase). Task 1 scope: acknowledgement/success copy and the
 * launcher display-name map. Task 2 adds the D-26 error table.
 */

export function launcherDisplayName(_action: LaunchAction): string {
  return "TODO";
}

export function launchAcknowledgement(_action: LaunchAction, _terminalLabel: string): string {
  return "TODO";
}

export function launchSuccessLine(_action: LaunchAction, _terminalLabel: string): string {
  return "TODO";
}
