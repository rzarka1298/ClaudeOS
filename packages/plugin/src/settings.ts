import type { MotionPreference } from "./motion.js";

/**
 * The entire contract for what the plugin persists through Obsidian's own
 * plugin-data storage (`loadData`/`saveData`). PLUG-07 requires that this
 * shape admit no credential field — the socket path override is a local
 * filesystem path, never a secret, and the service itself never returns
 * one to the plugin (ADR-0016/ADR-0017: tokens live in the client's memory
 * for the process lifetime only).
 */
export interface CommandCenterSettings {
  socketPathOverride: string | null;
  lastOpenedDestination: string;
  /**
   * The owner's reduced-motion override (A11Y-03). `auto` defers to the OS.
   * A widening, not a migration: there is no schema version because
   * `loadSettings()` merges whatever is on disk over {@link DEFAULT_SETTINGS},
   * so a `data.json` written before this key existed resolves to `auto`
   * without a single line of upgrade code.
   */
  reducedMotion: MotionPreference;
  /**
   * Whether a new pending approval request raises a macOS notification while
   * Obsidian is unfocused (APPR-09, D-26). Plugin-owned and a pure preference:
   * no approval state, request or decision is ever persisted here (D-21).
   */
  notifyApprovals: boolean;
}

export const DEFAULT_SETTINGS: CommandCenterSettings = {
  socketPathOverride: null,
  lastOpenedDestination: "overview",
  reducedMotion: "auto",
  notifyApprovals: true,
};

/**
 * The settings object a plugin-data file resolves to: whatever is on disk
 * merged over {@link DEFAULT_SETTINGS}, so a file written before a key existed
 * resolves it to its default without upgrade code. `notifyApprovals` is the
 * one key coerced: a persisted non-boolean falls back to the default rather
 * than turning a notification off by accident.
 */
export function mergeSettings(loaded: unknown): CommandCenterSettings {
  const onDisk =
    loaded !== null && typeof loaded === "object" && !Array.isArray(loaded)
      ? (loaded as Partial<CommandCenterSettings>)
      : {};
  const merged: CommandCenterSettings = { ...DEFAULT_SETTINGS, ...onDisk };
  const notifyApprovals: unknown = merged.notifyApprovals;
  return {
    ...merged,
    notifyApprovals:
      typeof notifyApprovals === "boolean" ? notifyApprovals : DEFAULT_SETTINGS.notifyApprovals,
  };
}

/** Case-insensitive: catches `token`, `Token`, `refreshToken`, `INSTALL_SECRET`, etc. */
const CREDENTIAL_KEY_PATTERN = /token|secret|password|authorization/i;

/**
 * Throws if `value` — about to be handed to `saveData` — has any own key
 * that looks like a credential field, at the top level. PLUG-07 is
 * enforced by this guard rather than by reviewer vigilance: a future
 * change that accidentally widens {@link CommandCenterSettings} with a
 * `token`/`secret`/`password`/`authorization`-shaped field fails loudly at
 * save time instead of silently persisting a credential to disk.
 */
export function assertNoCredentialFields(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const key of Object.keys(value)) {
    if (CREDENTIAL_KEY_PATTERN.test(key)) {
      throw new Error(
        `Refusing to persist plugin settings: key "${key}" looks like a credential field.`,
      );
    }
  }
}

/**
 * Keys whose value is legitimately a local filesystem path, and so may hold a
 * home-absolute string. Only the socket path override qualifies: a custom
 * socket location under the owner's home is exactly what that setting is for
 * (04-RESEARCH.md Pitfall 9), and it names the service's runtime directory,
 * never a project. Matched by key name at any depth.
 */
export const PATH_VALUED_KEYS: ReadonlySet<string> = new Set(["socketPathOverride"]);

/** A home-absolute or home-relative path: the shape every project path takes. */
const PRIVATE_PATH_VALUE = /^(\/Users\/|~\/)/;

/** Case-insensitive: `projects`, `projectPaths`, `scanRoots`, `launcherConfig`, `recentProjects`. */
const PROJECT_KEY_PATTERN = /project|scanroot|launcher/i;

/** Deeper than any settings shape this plugin has; a deeper value is refused, not skipped. */
const MAX_SETTINGS_DEPTH = 8;

function refusePrivate(key: string): never {
  throw new Error(
    `Refusing to persist plugin settings: key "${key}" holds a private path or project data.`,
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function walkSettingsValue(key: string, value: unknown, depth: number): void {
  if (typeof value === "string") {
    if (!PATH_VALUED_KEYS.has(key) && PRIVATE_PATH_VALUE.test(value)) refusePrivate(key);
    return;
  }
  if (!Array.isArray(value) && !isPlainObject(value)) return;
  // Fail closed: a value nested too deep to scan is never persisted unscanned.
  if (depth >= MAX_SETTINGS_DEPTH) refusePrivate(key);
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      walkSettingsValue(`${key}[${index}]`, item, depth + 1);
    });
    return;
  }
  for (const [childKey, childValue] of Object.entries(value)) {
    if (PROJECT_KEY_PATTERN.test(childKey)) refusePrivate(childKey);
    walkSettingsValue(childKey, childValue, depth + 1);
  }
}

/**
 * Throws if `value` -- about to be handed to `saveData` -- carries a private
 * path or project data (D-43, PROJ-14). Project data lives only in the
 * service's operational store; the plugin's data file sits in a plugin folder
 * the dev vault symlinks into this repository, so nothing project-shaped may
 * ever reach it.
 *
 * This is the save-time backstop and the value-based sibling of PLUG-07's key
 * guard ({@link assertNoCredentialFields}). It walks own keys of plain
 * objects and array items recursively (depth-capped, failing closed) and
 * refuses:
 *   - any key matching `project`, `scanroot` or `launcher`, whatever its value;
 *   - any string starting with `/Users/` or `~/` under a key outside
 *     {@link PATH_VALUED_KEYS} (only `socketPathOverride`, Pitfall 9).
 *
 * The error names the offending key and never the value, so the refusal
 * itself cannot become the leak (a Notice, a log line, a test report).
 */
export function assertNoPrivatePathValues(value: unknown): void {
  if (!Array.isArray(value) && !isPlainObject(value)) return;
  walkSettingsValue("(settings)", value, 0);
}
