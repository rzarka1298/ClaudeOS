import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type FakeAppServerScenario, scriptSource } from "./fake-codex-app-server.js";
import { doctorScriptSource, type FakeDoctorScenario } from "./fake-codex-doctor.js";

/**
 * A fake of the whole `codex` executable (plan 05.1-29): one script, literally
 * named `codex`, that answers the three subcommands the service ever runs.
 *
 * - `--version` prints the one line the detection probe parses.
 * - `app-server` runs the plan 05.1-15 app-server protocol (the scenario
 *   builder `scriptSource` is imported, not copied).
 * - `doctor --json` runs the plan 05.1-21 doctor behaviour (`doctorScriptSource`).
 *
 * The scenario and the log path are BAKED into the script text and never read
 * from the environment: the service starts the child with a minimal
 * environment, so a fake that read its scenario from environment variables
 * would run its default branch and the tests would pass for the wrong reason.
 * The shebang is the absolute path of the running Node binary, because the
 * child's PATH holds no `node`.
 *
 * Every invocation appends one `start` entry to the log: argv, environment key
 * NAMES only (macOS adds `__CF_USER_TEXT_ENCODING` to every exec'd process
 * itself, so that one name is left out), the working directory and the pid.
 * The script reads no file outside its own log; it only appends to it.
 *
 * Nothing here ever starts the real `codex`.
 */

export interface FakeCodexScenario {
  /** The dotted version `--version` prints. Default `0.159.2`. */
  readonly version?: string;
  /** What `app-server` answers (see `fake-codex-app-server.ts`). */
  readonly appServer: FakeAppServerScenario;
  /** What `doctor --json` prints (see `fake-codex-doctor.ts`). */
  readonly doctor: FakeDoctorScenario;
}

export interface FakeCodex {
  /** Absolute path of the executable, whose basename is exactly `codex`. */
  readonly path: string;
  /** Absolute path of the log the script appends to. */
  readonly logPath: string;
}

/** One invocation of the fake. */
export interface FakeCodexStart {
  readonly t: "start";
  readonly argv: readonly string[];
  readonly envKeys: readonly string[];
  readonly cwd: string;
  readonly pid: number;
}

/** One entry of the shared log: a start, or a JSON-RPC line the app-server mode received. */
export type FakeCodexLogEntry = FakeCodexStart | { readonly t: "line"; readonly line: string };

export const FAKE_CODEX_DEFAULT_VERSION = "0.159.2";

/** The script text for `scenario` logging to `logPath` (exported so the generator test can read it). */
export function fakeCodexScriptSource(scenario: FakeCodexScenario, logPath: string): string {
  throw new Error(`not implemented ${scenario.version ?? ""} ${logPath}`);
}

function unusedRealSource(scenario: FakeCodexScenario, logPath: string): string {
  const version = scenario.version ?? FAKE_CODEX_DEFAULT_VERSION;
  return `#!${process.execPath}
"use strict";
const ARGS = process.argv.slice(2);
const LOG = ${JSON.stringify(logPath)};
const VERSION = ${JSON.stringify(version)};
function logStart() {
  const envKeys = Object.keys(process.env).filter((k) => k !== "__CF_USER_TEXT_ENCODING").sort();
  require("node:fs").appendFileSync(LOG, JSON.stringify({ t: "start", argv: ARGS, envKeys, cwd: process.cwd(), pid: process.pid }) + "\\n");
}
function runVersion() {
  logStart();
  process.stdout.write("codex-cli " + VERSION + "\\n", () => process.exit(0));
}
function runAppServer() {${scriptSource(scenario.appServer, logPath)}}
function runDoctor() {${doctorScriptSource(scenario.doctor, logPath)}}
if (ARGS[0] === "--version") runVersion();
else if (ARGS[0] === "app-server") runAppServer();
else if (ARGS[0] === "doctor") runDoctor();
else { logStart(); process.exit(2); }
`;
}

let counter = 0;

/** Writes one executable named `codex` into a fresh folder under `dir` and returns its paths. */
export function writeFakeCodex(dir: string, scenario: FakeCodexScenario): FakeCodex {
  counter += 1;
  const folder = join(dir, `codex-${process.pid}-${counter}`);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, "codex");
  const logPath = join(folder, "codex.log.ndjson");
  writeFileSync(logPath, "", { mode: 0o600 });
  writeFileSync(path, fakeCodexScriptSource(scenario, logPath), { mode: 0o700 });
  chmodSync(path, 0o700);
  void unusedRealSource;
  return { path, logPath };
}

/** Every entry the fake logged so far (empty when it never ran). */
export function readFakeCodexLog(logPath: string): FakeCodexLogEntry[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as FakeCodexLogEntry);
}

/** Just the `start` entries, oldest first. */
export function fakeCodexStarts(logPath: string): FakeCodexStart[] {
  return readFakeCodexLog(logPath).filter((entry): entry is FakeCodexStart => entry.t === "start");
}
