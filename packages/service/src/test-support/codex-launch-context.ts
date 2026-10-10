import type { LaunchGuard } from "@ccc/domain";
import { createDetector } from "../projects/detection.js";
import { createLaunchService } from "../projects/launch-service.js";
import type { LauncherServices } from "../projects/launcher-routes.js";
import { createStoreProjectLookup } from "../projects/project-lookup.js";
import { ensureScriptDir } from "../projects/script-dir.js";
import type { CodexCompositionOptions } from "./codex-composition.js";
import { createFakeCommandRunner } from "./fake-command-runner.js";

/**
 * The launcher services and the launch service for a Codex composition (plan 05.1-29): what the
 * launcher save, the Codex Test and the pair launch need beyond the Codex route surface. Every
 * process goes through the composition's fake spawner and a fake command runner; nothing opens
 * anything on the desktop.
 */
export function launchContext(
  extras: { guard?: LaunchGuard; capMs?: number } = {},
): NonNullable<CodexCompositionOptions["routeContext"]> {
  return (parts) => {
    const scriptDir = ensureScriptDir(parts.runtimeDir);
    const detector = createDetector({
      runner: createFakeCommandRunner({ script: [] }),
      homeDir: parts.homeDir,
      readdir: () => Promise.resolve([]),
      resolveGit: () => Promise.resolve({ kind: "unavailable" }),
    });
    const launchers: LauncherServices = {
      detector,
      homeDir: parts.homeDir,
      onLaunchersChanged: () => parts.codex?.onLaunchersChanged(),
      spawner: parts.spawner,
      scriptDir,
    };
    const launch = createLaunchService({
      store: parts.store,
      spawner: parts.spawner,
      lookup: createStoreProjectLookup(parts.store),
      collector: { refresh() {}, onRegistryChanged() {}, gitState: () => null },
      logger: { info() {}, warn() {} },
      scriptDir,
      ...(extras.guard === undefined ? {} : { guard: extras.guard }),
      ...(extras.capMs === undefined ? {} : { capMs: extras.capMs }),
    });
    return { launch, launchers };
  };
}
