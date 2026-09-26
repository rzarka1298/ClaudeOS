/**
 * Argv builders for every application action (D-19): open a project in an
 * app, bring an app forward, reveal in Finder, open a GitHub URL, and hand a
 * generated launch script to Terminal.app.
 *
 * Every result is an array whose first element is the absolute
 * `/usr/bin/open`, passed to `execFile` as-is — never joined into a string
 * and never parsed by a shell. Apps are targeted by bundle ID (`-b`), never
 * by name: a bundle ID survives the owner renaming or moving the `.app`, and
 * it disambiguates two apps that share a display name (the two Antigravity
 * bundles). `/usr/bin/open` returns as soon as LaunchServices dispatches, so
 * exit status 0 means the hand-off happened (RESEARCH Pattern 1).
 *
 * Each builder validates its input and throws {@link LaunchArgumentError}
 * with a constant message naming only the field, never the value.
 */

export const OPEN = "/usr/bin/open";
/** A macOS bundle identifier: letters, digits, dots and hyphens (matches the domain BundleIdSchema). */
export const BUNDLE_ID_PATTERN = /^[A-Za-z0-9.-]+$/;
export const TERMINAL_BUNDLE_ID = "com.apple.Terminal";

export type LaunchArgumentField = "bundleId" | "projectPath" | "scriptPath" | "url";

/** Thrown when a builder input is not valid. The message never contains the value. */
export class LaunchArgumentError extends Error {
  readonly field: LaunchArgumentField;

  constructor(field: LaunchArgumentField) {
    super(`${field} is not valid for a launch command`);
    this.name = "LaunchArgumentError";
    this.field = field;
  }
}

const NUL = String.fromCharCode(0);

function assertBundleId(bundleId: string): void {
  // A leading hyphen is refused as well, so the value can never read as an option to open.
  if (!BUNDLE_ID_PATTERN.test(bundleId) || bundleId.startsWith("-")) {
    throw new LaunchArgumentError("bundleId");
  }
}

function assertAbsolutePath(path: string, field: "projectPath" | "scriptPath"): void {
  if (!path.startsWith("/") || path.includes(NUL)) throw new LaunchArgumentError(field);
}

function assertHttpsUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new LaunchArgumentError("url");
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
    throw new LaunchArgumentError("url");
  }
}

/** `open -b <bundleId> <projectPath>` — open the project folder in the app (Antigravity). */
export function openInApp(bundleId: string, projectPath: string): readonly string[] {
  assertBundleId(bundleId);
  assertAbsolutePath(projectPath, "projectPath");
  return [OPEN, "-b", bundleId, projectPath];
}

/** `open -b <bundleId>` — launch or foreground the app without a second instance (Claude Desktop). */
export function activateApp(bundleId: string): readonly string[] {
  assertBundleId(bundleId);
  return [OPEN, "-b", bundleId];
}

/** `open -R <projectPath>` — a Finder window with the folder selected. */
export function revealInFinder(projectPath: string): readonly string[] {
  assertAbsolutePath(projectPath, "projectPath");
  return [OPEN, "-R", projectPath];
}

/** `open <https URL>` — the default browser. Only https and no userinfo; callers pass a URL rebuilt from validated parts. */
export function openUrl(url: string): readonly string[] {
  assertHttpsUrl(url);
  return [OPEN, url];
}

/** `open -b com.apple.Terminal <scriptPath>` — Terminal.app runs the generated `.command` script. */
export function openTerminalScript(scriptPath: string): readonly string[] {
  assertAbsolutePath(scriptPath, "scriptPath");
  return [OPEN, "-b", TERMINAL_BUNDLE_ID, scriptPath];
}
