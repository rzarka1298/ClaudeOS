import type { UatProfile } from "./profile.js";

/** A refusal of the command line (exit code 2). Messages name only the flag, never its value. */
export class UsageError extends Error {}

export const RUN_USAGE = "skeleton";

export interface RunArgs {
  help: boolean;
  profile: UatProfile;
  script: string | undefined;
  phaseDir: string | undefined;
  out: string | undefined;
  shotsDir: string | undefined;
  specs: string[];
}

export interface ArgsEnv {
  repoRoot?: string;
  isDirectory?: (path: string) => boolean;
}

export function parseRunArgs(_argv: readonly string[], _env?: ArgsEnv): RunArgs {
  throw new Error("parseRunArgs is not implemented yet (typed skeleton)");
}
