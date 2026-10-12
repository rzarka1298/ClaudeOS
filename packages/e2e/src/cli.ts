import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildHash } from "./build-hash.js";
import { parseRunArgs, RUN_USAGE, UsageError } from "./cli-args.js";
import { type GitFacts, readGitFacts } from "./git-facts.js";
import { assertInstallerVersionMatches, readInstalledInstallerVersion } from "./installed-app.js";
import { PLUGIN_STAGE_FILES, stagePlugin } from "./plugin-data.js";
import { HOOK_ENTRY, PLUGIN_BUILD_DIR, REPO_ROOT, SERVICE_ENTRY } from "./repo-paths.js";
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
import { createShotsDir, deleteShotsDir, purgeStaleShotDirs } from "./screenshots.js";
import { SPIKE_DECISIONS } from "./spike-decisions.js";
import { generateUatVault } from "./uat-vault.js";
import { isolatePluginData } from "./vault-plugin-data.js";
import { parseVersions } from "./versions.js";
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
}

export interface CliDeps {
  io?: Partial<CliIo>;
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
    // The download cache checksum is wired in by the cache-verify module (Task 3).
    verifyCache: () => ({ ok: true, note: "not checked" }),
    purgeShots: (base) => {
      purgeStaleShotDirs({ base: base ?? tmpdir(), keepRunIds: [] });
    },
    runSandbox: (body) => withSandbox({}, body),
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
    spawnWdio: ({ sandbox, wdioEnv, extraArgs }) =>
      spawnWdio({
        sandbox,
        configPath: join(E2E_DIR, "wdio.conf.ts"),
        cwd: E2E_DIR,
        wdioEnv,
        extraArgs,
      }),
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
    // Replaced by the look module's handoff writer (Task 2).
    handoffLooks: (input) => {
      if (input.items.length === 0) deleteShotsDir(input.shotsDir);
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

const notYet: CommandHandler = async (_argv, deps) => {
  deps.write("This command is not available yet.");
  return 2;
};

export const COMMANDS: Readonly<Record<string, CommandHandler>> = {
  run: runCommand,
  preflight: notYet,
  look: notYet,
  report: notYet,
  ratify: notYet,
  "lint-tags": notYet,
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
