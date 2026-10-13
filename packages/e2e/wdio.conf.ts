/**
 * The real wdio configuration for the live UAT runner (05.2-03). It is loaded only by the
 * runner's CLI (`pnpm run uat`), which builds the run environment first; started any other way
 * it throws because there is no run root. The work is in src/wdio-config.ts.
 */

import {
  assertInstallerVersionMatches,
  readInstalledInstallerVersion,
} from "./src/installed-app.js";
import { SPIKE_DECISIONS } from "./src/spike-decisions.js";
import { buildWdioConfig } from "./src/wdio-config.js";

if (SPIKE_DECISIONS.launch === "binaryPath") {
  assertInstallerVersionMatches(SPIKE_DECISIONS.installerVersion, readInstalledInstallerVersion());
}

export const config: WebdriverIO.Config = buildWdioConfig(process.env);
