import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Mirrors `@ccc/service`'s `resolveSocketPath` default: `CCC_SOCKET_PATH`
 * then the short, fixed runtime directory under `$HOME`. The plugin does
 * not import `@ccc/service` (that package may pull in Node built-ins the
 * plugin has no reason to depend on); it re-derives the same default path.
 * `override` is the user's own `socketPathOverride` setting, if set.
 */
export function resolveSocketPath(override: string | null): string {
  if (override) return override;
  return process.env.CCC_SOCKET_PATH ?? join(homedir(), ".claude-command-center", "svc.sock");
}
