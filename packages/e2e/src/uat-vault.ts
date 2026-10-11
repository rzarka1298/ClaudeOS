import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildPluginData, isStrictlyInside, seedPluginData } from "./plugin-data.js";
import type { UatProfile } from "./profile.js";
import { GENERATOR_SCRIPT } from "./repo-paths.js";

/**
 * Synthetic vault generation for the sandbox run (05.2-04, D-07, E2E-10, T-05.2-16).
 *
 * Vaults come only from `scripts/generate-task-fixture-vault.mjs`, run as the current node
 * binary with an argv array and no shell, with a fixed seed, a fixed clock and the UTC zone,
 * into `<runRoot>/vaults/<kind>`. The live vault holds 300 tasks plus the live-check notes;
 * the 10,000-task vault is refused unless the profile is full. Note contents are never logged.
 */

export const UAT_SEED = "20261008";
/** An instant on 2026-10-08, so every relative date in the notes is reproducible. */
export const UAT_CLOCK = "2026-10-08T09:00:00Z";
export const UAT_ZONE = "UTC";

export const LIVE_TASK_COUNT = 300;
export const BIG_TASK_COUNT = 10_000;

export type VaultKind = "live" | "big";

export interface GeneratorDeps {
  /** Runs the generator with the given argv (script path first) and returns its stdout. */
  runGenerator: (argv: readonly string[]) => Promise<{ stdout: string }>;
}

const execFileAsync = promisify(execFile);
const defaultDeps: GeneratorDeps = {
  runGenerator: async (argv) => {
    const { stdout } = await execFileAsync(process.execPath, [...argv], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return { stdout };
  },
};

export interface GenerateUatVaultInput {
  runRoot: string;
  kind: VaultKind;
  profile: UatProfile;
  /** The sandbox service socket, seeded into the plugin's data.json. */
  socketPath: string;
  /** Tests only: a small task count instead of 300 (live) or 10,000 (big). */
  countOverride?: number;
  /** Defaults to `<runRoot>/vaults/<kind>`; must stay strictly inside the run root. */
  outDir?: string;
  deps?: Partial<GeneratorDeps>;
}

export interface UatVault {
  kind: VaultKind;
  vaultPath: string;
  taskCount: number;
  seed: string;
  clock: string;
  zone: string;
  pluginDataPath: string;
}

/** Reads N from the generator's `generated N task notes ...` line. */
export function parseGeneratedCount(stdout: string): number {
  const match = /^generated (\d+) task notes/m.exec(stdout);
  if (match?.[1] === undefined) throw new Error("Vault generator output was not understood.");
  return Number(match[1]);
}

export async function generateUatVault(input: GenerateUatVaultInput): Promise<UatVault> {
  if (input.kind === "big" && input.profile !== "full") {
    throw new Error("The 10,000-task vault is only generated with --profile full.");
  }
  const outDir = input.outDir ?? join(input.runRoot, "vaults", input.kind);
  if (!isStrictlyInside(input.runRoot, outDir)) {
    throw new Error("The vault folder is not inside the run root.");
  }
  if (existsSync(outDir) && (!statSync(outDir).isDirectory() || readdirSync(outDir).length > 0)) {
    throw new Error("The vault folder is not empty.");
  }
  const count = input.countOverride ?? (input.kind === "live" ? LIVE_TASK_COUNT : BIG_TASK_COUNT);
  const argv = [
    GENERATOR_SCRIPT,
    "--out",
    outDir,
    "--count",
    String(count),
    "--seed",
    UAT_SEED,
    "--clock",
    UAT_CLOCK,
    "--zone",
    UAT_ZONE,
    ...(input.kind === "live" ? ["--live-check"] : []),
  ];
  const runGenerator = input.deps?.runGenerator ?? defaultDeps.runGenerator;
  const { stdout } = await runGenerator(argv);
  const taskCount = parseGeneratedCount(stdout);
  const pluginDataPath = seedPluginData({
    runRoot: input.runRoot,
    vaultDir: outDir,
    data: buildPluginData({ socketPath: input.socketPath }),
  });
  return {
    kind: input.kind,
    vaultPath: outDir,
    taskCount,
    seed: UAT_SEED,
    clock: UAT_CLOCK,
    zone: UAT_ZONE,
    pluginDataPath,
  };
}
