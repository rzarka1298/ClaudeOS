import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { type AutoOutcome, applyAutoResults } from "./apply-auto-results.js";
import { applyRatification } from "./apply-ratification.js";
import { buildHash } from "./build-hash.js";
import { realCacheFiles, verifyObsidianCache } from "./cache-verify.js";
import {
  LOOK_USAGE,
  parseLintArgs,
  parseLookArgs,
  parsePreflightArgs,
  parseRatifyArgs,
  parseReportArgs,
  parseRunArgs,
  RUN_USAGE,
  UsageError,
} from "./cli-args.js";
import { type GitFacts, readGitFacts } from "./git-facts.js";
import { assertInstallerVersionMatches, readInstalledInstallerVersion } from "./installed-app.js";
import { lintTagsCommand } from "./lint-command.js";
import { listPending, recordVerdict, writeLookHandoff } from "./look.js";
import { PLUGIN_STAGE_FILES, stagePlugin } from "./plugin-data.js";
import {
  createPreflightPorts,
  type PreflightOptions,
  type PreflightOutcome,
  type PreflightPorts,
  runPreflight,
} from "./preflight.js";
import { checkRunValidity, ratifyReport } from "./ratify.js";
import { HOOK_ENTRY, PLUGIN_BUILD_DIR, REPO_ROOT, SERVICE_ENTRY } from "./repo-paths.js";
import { parseReport } from "./report-io.js";
import type { ItemStatus } from "./results.js";
import { parseResultsFile } from "./results.js";
import {
  type LookPendingItem,
  parseLookPendingLines,
  type RunOptions,
  type RunOutcome,
  type RunPorts,
  runUat,
} from "./run-uat.js";
import { withSandbox } from "./sandbox.js";
import { sanitizeText } from "./sanitize.js";
import {
  createShotsDir,
  deleteShotsDir,
  purgeStaleShotDirs,
  SHOTS_PREFIX,
  shotPath,
} from "./screenshots.js";
import { SPIKE_DECISIONS } from "./spike-decisions.js";
import { extractSpecTitles } from "./tag-lint.js";
import { generateUatVault } from "./uat-vault.js";
import { isolatePluginData } from "./vault-plugin-data.js";
import { parseVersions } from "./versions.js";
import { OBSIDIAN_CACHE_DIR } from "./wdio-config.js";
import { keepWdioLogs } from "./wdio-logs.js";
import { spawnWdio } from "./wdio-spawn.js";

/**
 * The command line behind `pnpm run uat:auto` (05.2-09, D-03): `node dist/cli.js <command>`.
 * Handlers parse strictly, print counts and item numbers only, and return an exit code: 0 done,
 * 1 a failed run, 2 a usage error or refusal. The real ports below are wired once, here; the
 * pipeline in run-uat.ts is tested with fakes.
 */

/** The file, git and clock access of the report, ratify and look handlers; tests inject it. */
export interface CliIo {
  readText: (path: string) => string | null;
  writeText: (path: string, text: string) => void;
  readGitFacts: (since: string | undefined) => Promise<GitFacts>;
  now: () => Date;
  tmpDir: () => string;
  listFiles: (dir: string) => string[];
}

export interface CliDeps {
  io?: Partial<CliIo>;
  runPreflight?: (options: PreflightOptions, ports: PreflightPorts) => Promise<PreflightOutcome>;
  createPreflightPorts?: () => PreflightPorts;
  write?: (line: string) => void;
  runUat?: (options: RunOptions, ports: RunPorts) => Promise<RunOutcome>;
  createRunPorts?: () => RunPorts;
}

export type CommandHandler = (
  argv: readonly string[],
  deps: Required<Pick<CliDeps, "write">> & CliDeps,
) => Promise<number>;

const E2E_DIR = join(REPO_ROOT, "packages", "e2e");

export const USAGE = [
  "Usage: node dist/cli.js <command> [options]",
  "",
  "  run        run the live UAT (pnpm run uat:auto)",
  "  preflight  check the sandbox end to end without a window",
  "  look       list pending looks or record a verdict",
  "  report     write the run's final auto-results into a UAT script",
  "  ratify     ratify a finished run (the orchestrator, with the owner's statement)",
  "  lint-tags  check the tags of a UAT script against the specs",
].join("\n");

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, path);
}

/** The real ports of the run pipeline. Building them starts nothing. */
export function createRunPorts(): RunPorts {
  const decisions = SPIKE_DECISIONS;
  return {
    env: process.env,
    platform: process.platform,
    decisions,
    homeDir: homedir(),
    now: () => new Date(),
    log: (line) => console.log(line),
    missingArtifacts: () =>
      [SERVICE_ENTRY, HOOK_ENTRY, ...PLUGIN_STAGE_FILES.map((name) => join(PLUGIN_BUILD_DIR, name))]
        .filter((file) => !existsSync(file))
        .map((file) => file),
    checkInstalledApp: () => {
      if (decisions.launch === "binaryPath") {
        assertInstallerVersionMatches(decisions.installerVersion, readInstalledInstallerVersion());
      }
    },
    verifyCache: () => verifyObsidianCache(decisions, realCacheFiles(OBSIDIAN_CACHE_DIR)),
    purgeShots: (base) => {
      // Seven days: a finished run waiting for its look verdict must outlive later runs.
      purgeStaleShotDirs({
        base: base ?? tmpdir(),
        keepRunIds: [],
        maxAgeMs: 7 * 24 * 60 * 60 * 1000,
      });
    },
    runSandbox: (body, hooks) =>
      withSandbox(
        { ...(hooks?.beforeRemove === undefined ? {} : { beforeRemove: hooks.beforeRemove }) },
        body,
      ),
    generateVault: async (sandbox, kind, profile) => {
      const vault = await generateUatVault({
        runRoot: sandbox.paths.root,
        kind,
        profile,
        socketPath: sandbox.paths.socketPath,
      });
      // The vault's plugin settings must point at the run-root socket before anything launches.
      isolatePluginData({
        vaultPath: vault.vaultPath,
        runRoot: sandbox.paths.root,
        socketPath: sandbox.paths.socketPath,
      });
    },
    stageGeneratedPlugin: (sandbox) => {
      stagePlugin({ buildDir: PLUGIN_BUILD_DIR, stageDir: sandbox.paths.pluginStageDir });
    },
    createShots: (runId, base) =>
      createShotsDir({ runId, repoRoot: REPO_ROOT, ...(base === undefined ? {} : { base }) }),
    deleteShots: (dir) => {
      deleteShotsDir(dir);
    },
    saveWdioLogs: ({ wdioDir, runId }) => keepWdioLogs({ wdioDir, destBase: tmpdir(), runId }),
    spawnWdio: ({ sandbox, wdioEnv, extraArgs }) =>
      spawnWdio({
        sandbox,
        configPath: join(E2E_DIR, "wdio.conf.ts"),
        cwd: E2E_DIR,
        wdioEnv,
        extraArgs,
      }),
    readSpecTitles: (prefix) => {
      const dir = join(E2E_DIR, "specs");
      const names = readdirSync(dir)
        .filter((name) => name.endsWith(".e2e.ts"))
        .sort();
      return names.flatMap((name) =>
        extractSpecTitles(`packages/e2e/specs/${name}`, readText(join(dir, name)) ?? "", prefix),
      );
    },
    readResults: (path) => {
      const text = readText(path);
      return text === null ? [] : parseResultsFile(text);
    },
    readLookPending: (path): LookPendingItem[] => {
      const text = readText(path);
      return text === null ? [] : parseLookPendingLines(text);
    },
    readVersions: (path) => {
      const text = readText(path);
      return text === null ? undefined : parseVersions(text);
    },
    readScript: (path) => readText(path),
    readGitFacts: () => readGitFacts({ cwd: REPO_ROOT }),
    buildHash: () => buildHash(PLUGIN_BUILD_DIR),
    writeReport: (path, text) => {
      if (path === null) console.log(text);
      else writeAtomic(path, text);
    },
    handoffLooks: (input) => {
      writeLookHandoff(input);
    },
  };
}

const runCommand: CommandHandler = async (argv, deps) => {
  const args = parseRunArgs(argv);
  if (args.help) {
    deps.write(RUN_USAGE);
    return 0;
  }
  if (args.script !== undefined && !existsSync(args.script)) {
    throw new UsageError("--script must name a readable file.");
  }
  const ports = (deps.createRunPorts ?? createRunPorts)();
  const outcome = await (deps.runUat ?? runUat)(
    {
      profile: args.profile,
      script: args.script,
      phaseDir: args.phaseDir,
      out: args.out,
      shotsDir: args.shotsDir,
      specs: args.specs,
    },
    ports,
  );
  deps.write(outcome.message);
  if (outcome.lookPending.length > 0) {
    deps.write(
      `Looks pending for item(s) ${outcome.lookPending.map((entry) => entry.item).join(", ")}; ` +
        "run: node packages/e2e/dist/cli.js look list",
    );
  }
  return outcome.exitCode;
};

const REAL_IO: CliIo = {
  readText,
  writeText: writeAtomic,
  readGitFacts: (since) =>
    readGitFacts({ cwd: REPO_ROOT, ...(since === undefined ? {} : { since }) }),
  now: () => new Date(),
  tmpDir: () => tmpdir(),
  listFiles: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
};

function ioFor(deps: CliDeps): CliIo {
  return { ...REAL_IO, ...deps.io };
}

function dateOf(io: CliIo): string {
  return io.now().toISOString().slice(0, 10);
}

function mustRead(io: CliIo, path: string, what: string): string {
  const text = io.readText(path);
  if (text === null) throw new Error(`The ${what} could not be read.`);
  return text;
}

const lookCommand: CommandHandler = async (argv, deps) => {
  if (argv[0] === "--help") {
    deps.write(LOOK_USAGE);
    return 0;
  }
  const args = parseLookArgs(argv);
  const io = ioFor(deps);
  const shotsDir = join(args.shotsBase ?? io.tmpDir(), `${SHOTS_PREFIX}${args.run}`);
  if (args.kind === "list") {
    const state = listPending(shotsDir);
    deps.write(`Shots folder: ${shotsDir}`);
    for (const entry of state.items) {
      const files = entry.labels.map((label) => basename(shotPath(shotsDir, entry.item, label)));
      deps.write(`Item ${entry.item}: ${entry.count} image(s): ${files.join(", ")}`);
    }
    if (state.items.length === 0) deps.write("No looks are pending.");
    return 0;
  }
  const result = recordVerdict({
    shotsDir,
    item: args.item,
    verdict: args.verdict,
    images: args.images,
  });
  deps.write(
    `Item ${result.item}: verdict ${result.status} recorded; ${result.remaining} look(s) still pending.`,
  );
  if (result.remaining === 0) deps.write("All looks are done; the shots folder was deleted.");
  return 0;
};

const FINAL_STATUSES = ["pass", "fail", "inconclusive"];

const reportCommand: CommandHandler = async (argv, deps) => {
  const args = parseReportArgs(argv);
  const io = ioFor(deps);
  const parsed = parseReport(mustRead(io, args.report, "report"));
  if (parsed.frontMatter["run-id"] !== args.run) {
    throw new Error("The report is not for the requested run id.");
  }
  if (parsed.frontMatter["item-mapping"] === "unavailable") {
    throw new Error("The report has no item mapping to a UAT script.");
  }
  if (args.script === undefined) {
    deps.write("No script was given; nothing was written.");
    return 0;
  }
  // The same run-level checks as ratify: a dirty, stale, version-mismatched or problem run must
  // not leave auto-result lines behind (Wave 3 WR-07).
  const facts = await io.readGitFacts(parsed.frontMatter["git-head"]);
  const invalid = checkRunValidity({
    report: parsed,
    runId: args.run,
    currentHead: facts.head,
    changedFiles: facts.changedSince,
    currentClean: facts.clean,
  });
  if (invalid.length > 0) {
    for (const reason of invalid) deps.write(`Refused: ${reason}.`);
    return 1;
  }
  const outcomes: AutoOutcome[] = parsed.rows
    .filter((row) => row.runClass !== "owner" && FINAL_STATUSES.includes(row.status))
    .map((row) => ({ item: row.number, status: row.status as ItemStatus }));
  const text = applyAutoResults({
    text: mustRead(io, args.script, "script"),
    outcomes,
    runId: args.run,
    date: dateOf(io),
  });
  if (args.writeScript) {
    io.writeText(args.script, text);
    deps.write(`Wrote ${outcomes.length} auto-result line(s).`);
  } else {
    deps.write(`Would write ${outcomes.length} auto-result line(s); add --write-script to apply.`);
  }
  return 0;
};

const ratifyCommand: CommandHandler = async (argv, deps) => {
  const args = parseRatifyArgs(argv);
  const io = ioFor(deps);
  const reportText = mustRead(io, args.report, "report");
  const recordedHead = parseReport(reportText).frontMatter["git-head"];
  const facts = await io.readGitFacts(recordedHead);
  const date = dateOf(io);
  const result = ratifyReport(reportText, {
    runId: args.run,
    statement: args.statement,
    date,
    currentHead: facts.head,
    changedFiles: facts.changedSince,
    currentClean: facts.clean,
  });
  if (!result.ok) {
    for (const reason of result.reasons) deps.write(`Refused: ${reason}.`);
    return 1;
  }
  let results: { text: string; items: number[] } | undefined;
  if (args.writeResults && args.script !== undefined) {
    results = applyRatification(mustRead(io, args.script, "script"), args.run);
  }
  // Script first: if it fails, the report is still unratified and ratify can simply be re-run
  // (applyRatification is idempotent). The reverse order left a ratified report and no results
  // (Wave 3 WR-02).
  if (results !== undefined && args.script !== undefined && results.items.length > 0) {
    io.writeText(args.script, results.text);
  }
  io.writeText(args.report, result.text);
  deps.write(`Ratified run ${args.run} on ${date}.`);
  if (results !== undefined) deps.write(`Wrote ${results.items.length} result line(s).`);
  return 0;
};

const preflightCommand: CommandHandler = async (argv, deps) => {
  const args = parsePreflightArgs(argv);
  const ports = (deps.createPreflightPorts ?? createPreflightPorts)();
  const outcome = await (deps.runPreflight ?? runPreflight)(
    { requireRealService: args.requireRealService },
    ports,
  );
  for (const line of outcome.lines) deps.write(line);
  deps.write(outcome.ok ? "Preflight passed." : "Preflight failed.");
  return outcome.ok ? 0 : 1;
};

const lintTagsHandler: CommandHandler = async (argv, deps) => {
  const args = parseLintArgs(argv);
  const io = ioFor(deps);
  const result = lintTagsCommand({
    scriptPath: args.script,
    specsDir: args.specsDir,
    readFile: io.readText,
    listFiles: io.listFiles,
  });
  for (const line of result.lines) deps.write(line);
  return result.exitCode;
};

export const COMMANDS: Readonly<Record<string, CommandHandler>> = {
  run: runCommand,
  preflight: preflightCommand,
  look: lookCommand,
  report: reportCommand,
  ratify: ratifyCommand,
  "lint-tags": lintTagsHandler,
};

export async function main(argv: readonly string[], deps: CliDeps = {}): Promise<number> {
  const write = deps.write ?? ((line: string) => console.log(line));
  const [command, ...rest] = argv;
  const handler =
    command !== undefined && Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (handler === undefined) {
    write(USAGE);
    return 2;
  }
  try {
    return await handler(rest, { ...deps, write });
  } catch (error) {
    if (error instanceof UsageError) {
      write(error.message);
      return 2;
    }
    write(
      sanitizeText(error instanceof Error ? error.message : "unknown error", {
        homeDir: homedir(),
      }),
    );
    return 1;
  }
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
