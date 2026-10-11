/**
 * Minimal wdio configuration for the orchestrator's spike and diagnostic runs
 * (05.2-01 Task 4, spikes S0 to S6). It is NOT the real runner configuration, which
 * arrives in plan 05.2-03. Run it only through the package script, from the repository
 * root, with the environment below set; an executor never runs it (D-15):
 *
 *   pnpm --filter @ccc/e2e run uat:smoke
 *
 * Required environment (all absolute paths; the config refuses to run if any is missing):
 *   CCC_UAT_RUN_ROOT    the short mode-700 run root (mktemp -d /tmp/ccc-uat.XXXXXX)
 *   CCC_UAT_VAULT       the generated synthetic vault; must sit strictly inside the run root
 *   CCC_UAT_PLUGIN_DIR  the staged plugin folder holding only main.js, manifest.json, styles.css
 *   CCC_UAT_CACHE_DIR   the wdio-obsidian-service download cache (the gitignored .obsidian-cache)
 *   CCC_UAT_SHOTS_DIR   a mode-700 folder outside the repository for page screenshots
 * Optional:
 *   CCC_UAT_SPEC        smoke (default, spike S0) or spikes (S1 to S5)
 * The isolation variables CCC_SOCKET_PATH, CCC_RUNTIME_DIR, CLAUDE_CONFIG_DIR and CODEX_HOME
 * (all inside the run root) and CCC_INSTALL_SECRET_ACCOUNT (a ccc-uat- account) are also
 * REQUIRED, inherited from the calling shell; assertIsolatedEnv refuses to run without them.
 * Spike S0 records whether the renderer sees CCC_SOCKET_PATH.
 */

import { homedir } from "node:os";
import {
  assertInstallerVersionMatches,
  readInstalledInstallerVersion,
} from "./src/installed-app.js";
import { buildLaunchCapabilities } from "./src/launch-options.js";
import { REPO_ROOT } from "./src/repo-paths.js";
import { SPIKE_DECISIONS } from "./src/spike-decisions.js";
import { assertCacheDir, assertIsolatedEnv, assertShotsDir } from "./src/uat-env.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable ${name}; see the header of this file.`);
  }
  return value;
}

const runRoot = requireEnv("CCC_UAT_RUN_ROOT");
const vaultPath = requireEnv("CCC_UAT_VAULT");
const pluginStageDir = requireEnv("CCC_UAT_PLUGIN_DIR");
const cacheDir = requireEnv("CCC_UAT_CACHE_DIR");
const shotsDir = requireEnv("CCC_UAT_SHOTS_DIR");

// Fail closed (D-05, L-3): without these the sandbox plugin would talk to the owner's live
// service socket, and spike S1 would write a real approval into the owner's store.
assertIsolatedEnv(process.env, { runRoot, home: homedir() });
assertShotsDir(shotsDir, REPO_ROOT);
assertCacheDir(cacheDir, REPO_ROOT);

const which = process.env.CCC_UAT_SPEC ?? "smoke";
if (which !== "smoke" && which !== "spikes") {
  throw new Error("CCC_UAT_SPEC must be smoke or spikes.");
}
const specFile = which === "smoke" ? "./smoke/smoke.e2e.ts" : "./smoke/spikes.e2e.ts";

if (SPIKE_DECISIONS.launch === "binaryPath") {
  assertInstallerVersionMatches(SPIKE_DECISIONS.installerVersion, readInstalledInstallerVersion());
}

// buildLaunchCapabilities refuses a vault outside the run root, the home directory, the plugin
// package folder (it holds the owner's data.json) and any binary other than the installed app.
const capabilities = buildLaunchCapabilities({
  decisions: SPIKE_DECISIONS,
  pluginStageDir,
  vaultPath,
  runRoot,
  cacheDir,
});

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: [specFile],
  maxInstances: 1,
  capabilities,
  services: ["obsidian"],
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { ui: "bdd", timeout: 180_000 },
  cacheDir,
  logLevel: "warn",
  specFileRetries: 0,
  waitforTimeout: 10_000,
};
