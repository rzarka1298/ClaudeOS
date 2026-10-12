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

const RUN_ID_FORM = /^[0-9a-f]{8}$/;

function requireText(
  values: Record<string, string | boolean | string[] | undefined>,
  flag: string,
): string {
  const value = values[flag];
  if (typeof value !== "string" || value === "") throw new UsageError(`--${flag} is required.`);
  return value;
}

function requireRunId(values: Record<string, string | boolean | string[] | undefined>): string {
  const run = requireText(values, "run");
  if (!RUN_ID_FORM.test(run)) {
    throw new UsageError("--run must be an eight-character hexadecimal run id.");
  }
  return run;
}

function optionalText(
  values: Record<string, string | boolean | string[] | undefined>,
  flag: string,
): string | undefined {
  const value = values[flag];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function wholeNumber(value: string, flag: string, max: number): number {
  if (!/^\d{1,3}$/.test(value) || Number(value) > max) {
    throw new UsageError(`--${flag} must be a whole number from 0 to ${max}.`);
  }
  return Number(value);
}

export type LookArgs =
  | { kind: "list"; run: string; shotsBase: string | undefined }
  | {
      kind: "record";
      run: string;
      shotsBase: string | undefined;
      item: number;
      verdict: "pass" | "fail";
      images: number;
    };

export const LOOK_USAGE = [
  "Usage: node dist/cli.js look list --run <id> [--shots-dir <base>]",
  "       node dist/cli.js look record --run <id> --item <n> --verdict pass|fail --images <count> [--shots-dir <base>]",
].join("\n");

export function parseLookArgs(argv: readonly string[]): LookArgs {
  const [kind, ...rest] = argv;
  if (kind !== "list" && kind !== "record") {
    throw new UsageError("look needs a subcommand: list or record.");
  }
  const values = parseStrict(rest, {
    run: { type: "string" },
    "shots-dir": { type: "string" },
    item: { type: "string" },
    verdict: { type: "string" },
    images: { type: "string" },
  });
  const run = requireRunId(values);
  const shotsBase = optionalText(values, "shots-dir");
  if (kind === "list") return { kind, run, shotsBase };
  const verdict = requireText(values, "verdict");
  if (verdict !== "pass" && verdict !== "fail") {
    throw new UsageError("--verdict must be pass or fail.");
  }
  return {
    kind,
    run,
    shotsBase,
    item: wholeNumber(requireText(values, "item"), "item", 99),
    verdict,
    images: wholeNumber(requireText(values, "images"), "images", 999),
  };
}

export interface ReportArgs {
  run: string;
  report: string;
  script: string | undefined;
  writeScript: boolean;
}

export function parseReportArgs(argv: readonly string[]): ReportArgs {
  const values = parseStrict(argv, {
    run: { type: "string" },
    report: { type: "string" },
    script: { type: "string" },
    "write-script": { type: "boolean" },
  });
  const script = optionalText(values, "script");
  if (values["write-script"] === true && script === undefined) {
    throw new UsageError("--write-script needs --script.");
  }
  return {
    run: requireRunId(values),
    report: requireText(values, "report"),
    script,
    writeScript: values["write-script"] === true,
  };
}

export interface RatifyArgs {
  run: string;
  report: string;
  statement: string;
  script: string | undefined;
  writeResults: boolean;
}

export function parseRatifyArgs(argv: readonly string[]): RatifyArgs {
  const values = parseStrict(argv, {
    run: { type: "string" },
    report: { type: "string" },
    statement: { type: "string" },
    script: { type: "string" },
    "write-results": { type: "boolean" },
  });
  const script = optionalText(values, "script");
  if (values["write-results"] === true && script === undefined) {
    throw new UsageError("--write-results needs --script.");
  }
  return {
    run: requireRunId(values),
    report: requireText(values, "report"),
    statement: requireText(values, "statement"),
    script,
    writeResults: values["write-results"] === true,
  };
}

export interface PreflightArgs {
  requireRealService: boolean;
}

export function parsePreflightArgs(argv: readonly string[]): PreflightArgs {
  const values = parseStrict(argv, { "require-real-service": { type: "boolean" } });
  return { requireRealService: values["require-real-service"] === true };
}

export interface LintArgs {
  script: string;
  specsDir: string;
}

/** Both flags are required and nothing is discovered, so a typo cannot lint nothing. */
export function parseLintArgs(argv: readonly string[]): LintArgs {
  const values = parseStrict(argv, {
    script: { type: "string" },
    "specs-dir": { type: "string" },
  });
  return { script: requireText(values, "script"), specsDir: requireText(values, "specs-dir") };
}
