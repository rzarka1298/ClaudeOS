import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildLaunchCapabilities, type LaunchFs, type LaunchInput } from "./launch-options.js";
import { PLUGIN_BUILD_DIR, REPO_ROOT } from "./repo-paths.js";
import { PROVISIONAL_SPIKE_DECISIONS } from "./spike-decisions.js";

// Codex finding 2: every comparison runs on realpath'd paths, so a symlink cannot smuggle the
// plugin package, an owner vault, the home directory or the repository past a textual check.

const MSG_STAGE = "Refusing a plugin stage directory that is relative or is the plugin package.";
const MSG_STAGE_CONTENTS =
  "Refusing a plugin stage directory that holds anything but main.js, manifest.json and styles.css.";
const MSG_OUTSIDE = "Refusing a vault outside the run root.";
const MSG_RUN_ROOT = "Refusing a run root that is or contains the home directory.";
const MSG_OWNER_VAULT = "Refusing a vault that overlaps an owner vault.";
const MSG_CACHE =
  "Refusing a cache directory that is relative, inside the Obsidian profile, or inside the " +
  "repository without being .obsidian-cache.";

const created: string[] = [];
function makeDir(parent: string, prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(parent, prefix)));
  created.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

interface World {
  runRoot: string;
  vault: string;
  stage: string;
  cache: string;
  home: string;
}

function world(): World {
  const runRoot = makeDir("/tmp", "ccc-uat.");
  const vault = join(runRoot, "vaults", "live");
  const stage = join(runRoot, "plugin-stage");
  const cache = join(runRoot, "cache");
  mkdirSync(vault, { recursive: true });
  mkdirSync(stage);
  for (const file of ["main.js", "manifest.json", "styles.css"]) {
    writeFileSync(join(stage, file), "x");
  }
  return { runRoot, vault, stage, cache, home: makeDir(tmpdir(), "ccc-home-") };
}

function input(w: World, overrides: Partial<LaunchInput> = {}): LaunchInput {
  return {
    decisions: PROVISIONAL_SPIKE_DECISIONS,
    pluginStageDir: w.stage,
    vaultPath: w.vault,
    runRoot: w.runRoot,
    cacheDir: w.cache,
    homeDir: w.home,
    ...overrides,
  };
}

describe("a stage reached through a symlink (the reported bypass)", () => {
  it("accepts a real stage of the three files, reporting the canonical paths it validated", () => {
    const w = world();
    const options = buildLaunchCapabilities(input(w))[0]?.["wdio:obsidianOptions"];
    expect(options?.plugins).toEqual([w.stage]);
    expect(options?.vault).toBe(w.vault);
  });

  it("refuses a stage link that resolves to the plugin package", () => {
    const w = world();
    const link = join(w.runRoot, "plugin-link");
    symlinkSync(PLUGIN_BUILD_DIR, link);
    expect(() => buildLaunchCapabilities(input(w, { pluginStageDir: link }))).toThrowError(
      MSG_STAGE,
    );
  });

  it("refuses a not-yet-existing path below a link into the plugin package", () => {
    const w = world();
    const link = join(w.runRoot, "plugin-link");
    symlinkSync(PLUGIN_BUILD_DIR, link);
    expect(() =>
      buildLaunchCapabilities(input(w, { pluginStageDir: join(link, "not-yet-staged") })),
    ).toThrowError(MSG_STAGE);
  });

  const workspaceLink = join(
    REPO_ROOT,
    "packages",
    "test-fixtures",
    "node_modules",
    "@ccc",
    "plugin",
  );
  it.skipIf(!existsSync(workspaceLink))(
    "refuses the real pnpm workspace link that points at the plugin package",
    () => {
      const w = world();
      expect(() =>
        buildLaunchCapabilities(input(w, { pluginStageDir: workspaceLink })),
      ).toThrowError(MSG_STAGE);
    },
  );

  it("refuses a stage reached through a link to the packages directory", () => {
    const w = world();
    const link = join(w.runRoot, "pkg-link");
    symlinkSync(join(PLUGIN_BUILD_DIR, ".."), link);
    expect(() =>
      buildLaunchCapabilities(input(w, { pluginStageDir: join(link, "plugin") })),
    ).toThrowError(MSG_STAGE);
  });
});

describe("the stage directory holds only the three plugin files", () => {
  const withFiles = (files: string[]): LaunchFs => ({
    realpathSync: (path) => path,
    readdirSync: () => files,
  });
  const base = (fs: LaunchFs): LaunchInput => ({
    decisions: PROVISIONAL_SPIKE_DECISIONS,
    pluginStageDir: "/tmp/ccc-uat.AbC123/plugin-stage",
    vaultPath: "/tmp/ccc-uat.AbC123/vaults/live",
    runRoot: "/tmp/ccc-uat.AbC123",
    cacheDir: "/tmp/ccc-uat.AbC123/cache",
    homeDir: "/Users/USERNAME",
    fs,
  });

  it("accepts main.js and manifest.json with or without styles.css", () => {
    for (const files of [
      ["main.js", "manifest.json", "styles.css"],
      ["main.js", "manifest.json"],
    ]) {
      expect(() => buildLaunchCapabilities(base(withFiles(files)))).not.toThrow();
    }
  });

  it("refuses data.json, hidden files, subdirectories, node_modules and a missing main.js or manifest", () => {
    for (const files of [
      ["main.js", "manifest.json", "styles.css", "data.json"],
      ["main.js", "manifest.json", ".hotreload"],
      ["main.js", "manifest.json", "dist"],
      ["main.js", "manifest.json", "node_modules"],
      ["manifest.json", "styles.css"],
      ["main.js", "styles.css"],
      [],
    ]) {
      expect(() => buildLaunchCapabilities(base(withFiles(files))), files.join(",")).toThrowError(
        MSG_STAGE_CONTENTS,
      );
    }
  });

  it("refuses a stage that cannot be listed, with a fixed message", () => {
    const fs: LaunchFs = {
      realpathSync: (path) => path,
      readdirSync: () => {
        throw new Error("ENOENT: /secret/path");
      },
    };
    try {
      buildLaunchCapabilities(base(fs));
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toBe(MSG_STAGE_CONTENTS);
    }
  });
});

describe("vault, run root and cache reached through symlinks", () => {
  it("refuses a vault link that points outside the run root", () => {
    const w = world();
    const outside = makeDir(tmpdir(), "ccc-outside-");
    const link = join(w.runRoot, "vault-link");
    symlinkSync(outside, link);
    expect(() => buildLaunchCapabilities(input(w, { vaultPath: link }))).toThrowError(MSG_OUTSIDE);
  });

  it("refuses a vault that overlaps a listed owner vault only through a link", () => {
    const w = world();
    // the vault is a link to the real directory the owner path names
    const alias = join(w.runRoot, "vault-alias");
    symlinkSync(w.vault, alias);
    expect(() =>
      buildLaunchCapabilities(input(w, { vaultPath: alias, ownerVaultPaths: [w.vault] })),
    ).toThrowError(MSG_OWNER_VAULT);
    // the owner path is a link to the vault
    expect(() =>
      buildLaunchCapabilities(input(w, { vaultPath: w.vault, ownerVaultPaths: [alias] })),
    ).toThrowError(MSG_OWNER_VAULT);
  });

  it("refuses a run root that is a link into the home directory", () => {
    const w = world();
    const inHome = join(w.home, "work");
    mkdirSync(join(inHome, "vault"), { recursive: true });
    const link = join(makeDir("/tmp", "ccc-uat."), "..", `ccc-uat.link${process.pid}`);
    symlinkSync(inHome, link);
    created.push(link);
    expect(() =>
      buildLaunchCapabilities(input(w, { runRoot: link, vaultPath: join(link, "vault") })),
    ).toThrowError(MSG_RUN_ROOT);
  });

  it("refuses a cache link that resolves inside the repository outside .obsidian-cache", () => {
    const w = world();
    const link = join(w.runRoot, "cache-link");
    symlinkSync(join(REPO_ROOT, "packages"), link);
    expect(() => buildLaunchCapabilities(input(w, { cacheDir: link }))).toThrowError(MSG_CACHE);
  });
});
