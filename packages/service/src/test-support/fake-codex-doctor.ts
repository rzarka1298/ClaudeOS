import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A contract-test fake of `codex doctor --json` (plan 05.1-21, RESEARCH R4).
 *
 * `writeFakeDoctor(dir, scenario)` writes an executable Node script whose
 * scenario and log path are BAKED into the script text, never read from the
 * environment: the product starts the real child with a minimal environment,
 * so a fake that read its scenario from environment variables would run its
 * default branch and the tests would pass for the wrong reason. The shebang is
 * the absolute path of the running Node binary, because the child's PATH holds
 * no `node`.
 *
 * The script appends one `start` entry to its log (argv, environment key
 * NAMES only, working directory, pid; macOS adds `__CF_USER_TEXT_ENCODING` to
 * every exec'd process itself, so that one name is left out). Nothing here
 * ever starts the real `codex`, and every path is a placeholder.
 */

export type FakeDoctorBehavior =
  /** Prints `stdout` and exits with `exitCode` (default 0). */
  | { readonly kind: "print"; readonly stdout: string; readonly exitCode?: number }
  | { readonly kind: "hang" }
  | { readonly kind: "crash" }
  /** Bytes without end until the client kills the process. */
  | { readonly kind: "endless" };

export interface FakeDoctorScenario {
  readonly behavior: FakeDoctorBehavior;
  /** Ignores the default termination signal; only the escalation ends it. */
  readonly ignoreTermination?: boolean;
  /** Writes a decoy-bearing line to stderr (the probe ignores stderr). */
  readonly stderrNoise?: boolean;
}

export interface FakeDoctor {
  /** Absolute path of the executable script. */
  readonly path: string;
  /** Absolute path of the log the script appends to. */
  readonly logPath: string;
}

export interface FakeDoctorStart {
  readonly t: "start";
  readonly argv: readonly string[];
  readonly envKeys: readonly string[];
  readonly cwd: string;
  readonly pid: number;
}

/** Obviously fake markers planted in every report: a path and an account fact. */
export const DOCTOR_DECOY_PATH = "/Users/USERNAME/decoy-doctor-path";
export const DOCTOR_DECOY_ACCOUNT = "acct-decoy-doctor-5d21";

export interface FakeDoctorReportOptions {
  readonly schemaVersion?: number;
  readonly overallStatus?: string;
  readonly codexVersion?: string;
  readonly checks?: readonly { id: string; category: string; status: string }[];
}

/** A doctor report whose every free-text member carries a decoy. */
export function doctorReport(options: FakeDoctorReportOptions = {}): string {
  const checks = options.checks ?? [
    { id: "install.version", category: "install", status: "ok" },
    { id: "auth.account", category: "auth", status: "warning" },
  ];
  return JSON.stringify({
    schemaVersion: options.schemaVersion ?? 1,
    overallStatus: options.overallStatus ?? "warning",
    codexVersion: options.codexVersion ?? "0.159.2",
    generatedAt: "2026-10-10T12:00:00Z",
    codexHome: DOCTOR_DECOY_PATH,
    account: DOCTOR_DECOY_ACCOUNT,
    checks: checks.map((check) => ({
      ...check,
      summary: `${DOCTOR_DECOY_ACCOUNT} summary`,
      details: [`${DOCTOR_DECOY_PATH}/config`, DOCTOR_DECOY_ACCOUNT],
      remediation: `run something in ${DOCTOR_DECOY_PATH}`,
      notes: DOCTOR_DECOY_ACCOUNT,
    })),
  });
}

/** The script body (no shebang). The scenario and log path are baked in as `JSON` literals. */
export function doctorScriptSource(scenario: FakeDoctorScenario, logPath: string): string {
  return `
const fs = require("node:fs");
const scenario = ${JSON.stringify(scenario)};
const logPath = ${JSON.stringify(logPath)};
const envKeys = Object.keys(process.env).filter((key) => key !== "__CF_USER_TEXT_ENCODING").sort();
fs.appendFileSync(logPath, JSON.stringify({ t: "start", argv: process.argv.slice(2), envKeys, cwd: process.cwd(), pid: process.pid }) + "\\n");
if (scenario.ignoreTermination) process.on("SIGTERM", () => {});
if (scenario.stderrNoise) process.stderr.write("${DOCTOR_DECOY_ACCOUNT} ${DOCTOR_DECOY_PATH}\\n");
const behavior = scenario.behavior;
if (behavior.kind === "print") {
  process.stdout.write(behavior.stdout, () => process.exit(behavior.exitCode ?? 0));
} else if (behavior.kind === "crash") {
  process.exit(3);
} else if (behavior.kind === "hang") {
  setInterval(() => {}, 1000);
} else {
  const chunk = "x".repeat(1024);
  const write = () => {
    while (process.stdout.write(chunk)) {}
    process.stdout.once("drain", write);
  };
  write();
}
`;
}

export function writeFakeDoctor(dir: string, scenario: FakeDoctorScenario): FakeDoctor {
  const path = join(dir, "codex");
  const logPath = join(dir, "doctor.log.ndjson");
  writeFileSync(path, `#!${process.execPath}${doctorScriptSource(scenario, logPath)}`);
  chmodSync(path, 0o755);
  return { path, logPath };
}

/** The `start` entries the fake wrote, oldest first. */
export function readFakeDoctorStarts(logPath: string): FakeDoctorStart[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as FakeDoctorStart);
}
