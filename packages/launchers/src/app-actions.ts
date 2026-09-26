export const OPEN = "/usr/bin/open";
export const BUNDLE_ID_PATTERN = /^[A-Za-z0-9.-]+$/;
export const TERMINAL_BUNDLE_ID = "com.apple.Terminal";

/** RED skeleton (plan 04-02 task 2). */
export class LaunchArgumentError extends Error {
  readonly field: string;

  constructor(field: string) {
    super("launch argument is not valid");
    this.name = "LaunchArgumentError";
    this.field = field;
  }
}

export function openInApp(_bundleId: string, _projectPath: string): readonly string[] {
  return [];
}

export function activateApp(_bundleId: string): readonly string[] {
  return [];
}

export function revealInFinder(_projectPath: string): readonly string[] {
  return [];
}

export function openUrl(_url: string): readonly string[] {
  return [];
}

export function openTerminalScript(_scriptPath: string): readonly string[] {
  return [];
}
