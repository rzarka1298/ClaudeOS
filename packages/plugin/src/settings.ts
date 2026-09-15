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
}

export const DEFAULT_SETTINGS: CommandCenterSettings = {
  socketPathOverride: null,
  lastOpenedDestination: "overview",
};

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
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (CREDENTIAL_KEY_PATTERN.test(key)) {
      throw new Error(
        `Refusing to persist plugin settings: key "${key}" looks like a credential field.`,
      );
    }
  }
}
