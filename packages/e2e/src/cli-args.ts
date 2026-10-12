import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import type { UatProfile } from "./profile.js";
import { REPO_ROOT } from "./repo-paths.js";
import { assertShotsDir } from "./uat-env.js";

/** A refusal of the command line (exit code 2). Messages name only the flag, never its value. */
export class UsageError extends Error {}

export const RUN_USAGE = [
  "Usage: node dist/cli.js run [options]",
  "",
  "  --profile standard|full  standard (default) skips the 10,000-task item; full runs it",
  "  --script <path>          the tagged UAT script to map results onto",
  "  --phase-dir <path>       the phase folder that receives the report",
  "  --out <path>             write the report to this file instead",
  "  --shots-dir <path>       parent folder for the screenshots folder (outside the repository)",
  "  --spec <path>            run only this spec file (repeatable)",
  "  --help                   print this text",
].join("\n");

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

type OptionSpec = Record<string, { type: "string" | "boolean"; multiple?: boolean }>;

/**
 * Strict parseArgs with fixed messages: an unknown flag is named, nothing else is echoed, and
 * a positional argument is refused without being quoted.
 */
export function parseStrict(
  argv: readonly string[],
  options: OptionSpec,
): Record<string, string | boolean | string[] | undefined> {
  try {
    const parsed = parseArgs({
      args: [...argv],
      options,
      strict: true,
      allowPositionals: true,
    });
    if (parsed.positionals.length > 0) {
      throw new UsageError("Unexpected argument; positional arguments are not accepted.");
    }
    return parsed.values as Record<string, string | boolean | string[] | undefined>;
  } catch (error) {
    if (error instanceof UsageError) throw error;
    const code = (error as { code?: string }).code;
    const flag = /--[a-z][a-z-]*/.exec((error as Error).message)?.[0];
    if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      throw new UsageError(`Unknown option ${flag ?? "(unrecognised)"}.`);
    }
    throw new UsageError(`Invalid use of option ${flag ?? "(unrecognised)"}.`);
  }
}

const defaultIsDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const RUN_OPTIONS: OptionSpec = {
  help: { type: "boolean" },
  profile: { type: "string" },
  script: { type: "string" },
  "phase-dir": { type: "string" },
  out: { type: "string" },
  "shots-dir": { type: "string" },
  spec: { type: "string", multiple: true },
};

export function parseRunArgs(argv: readonly string[], env: ArgsEnv = {}): RunArgs {
  const values = parseStrict(argv, RUN_OPTIONS);
  const repoRoot = env.repoRoot ?? REPO_ROOT;
  const isDirectory = env.isDirectory ?? defaultIsDirectory;

  const profile = values.profile ?? "standard";
  if (profile !== "standard" && profile !== "full") {
    throw new UsageError("Invalid value for --profile; expected standard or full.");
  }
  const shotsDir = values["shots-dir"] as string | undefined;
  if (shotsDir !== undefined) {
    try {
      assertShotsDir(shotsDir, repoRoot);
    } catch {
      throw new UsageError("--shots-dir must be an absolute path outside the repository.");
    }
    if (!isAbsolute(shotsDir)) {
      throw new UsageError("--shots-dir must be an absolute path outside the repository.");
    }
  }
  const out = values.out as string | undefined;
  if (out !== undefined && isDirectory(out)) {
    throw new UsageError("--out must be a file path, not a directory.");
  }
  return {
    help: values.help === true,
    profile: profile as UatProfile,
    script: values.script as string | undefined,
    phaseDir: values["phase-dir"] as string | undefined,
    out,
    shotsDir,
    specs: (values.spec as string[] | undefined) ?? [],
  };
}
