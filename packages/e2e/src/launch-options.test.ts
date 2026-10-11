import { describe, expect, it } from "vitest";
import { buildLaunchCapabilities, type LaunchFs, type LaunchInput } from "./launch-options.js";
import { INSTALLED_OBSIDIAN_BINARY, PLUGIN_BUILD_DIR, REPO_ROOT } from "./repo-paths.js";
import { PROVISIONAL_SPIKE_DECISIONS, type SpikeDecisions } from "./spike-decisions.js";

const HOME = "/Users/USERNAME";
const RUN_ROOT = "/tmp/ccc-uat.AbC123";
const VAULT = `${RUN_ROOT}/vaults/live`;
const STAGE = `${RUN_ROOT}/plugin-stage`;
const CACHE = "/repo/.obsidian-cache";

const MSG_BINARY = "Refusing to launch any Obsidian binary other than the installed app.";
const MSG_OUTSIDE = "Refusing a vault outside the run root.";
const MSG_RUN_ROOT = "Refusing a run root that is or contains the home directory.";
const MSG_OWNER_VAULT = "Refusing a vault that overlaps an owner vault.";
const MSG_STAGE = "Refusing a plugin stage directory that is relative or is the plugin package.";
const MSG_CACHE =
  "Refusing a cache directory that is relative, inside the Obsidian profile, or inside the " +
  "repository without being .obsidian-cache.";

/**
 * The textual cases below use fictional paths, so realpath is the identity and the stage lists
 * as the three plugin files. Symlink and stage-content behaviour is covered with the real
 * filesystem in launch-options-canonical.test.ts.
 */
const FAKE_FS: LaunchFs = {
  realpathSync: (path) => path,
  readdirSync: () => ["main.js", "manifest.json", "styles.css"],
};

function input(
  overrides: Partial<LaunchInput> = {},
  decisions?: Partial<SpikeDecisions>,
): LaunchInput {
  return {
    decisions: { ...PROVISIONAL_SPIKE_DECISIONS, ...decisions },
    pluginStageDir: STAGE,
    vaultPath: VAULT,
    runRoot: RUN_ROOT,
    cacheDir: CACHE,
    homeDir: HOME,
    fs: FAKE_FS,
    ...overrides,
  };
}

describe("buildLaunchCapabilities, binaryPath mode (L-3)", () => {
  it("points only at the installed app, carries the decided app version, one plugin and one vault", () => {
    const caps = buildLaunchCapabilities(input());
    expect(caps).toHaveLength(1);
    const options = caps[0]?.["wdio:obsidianOptions"];
    expect(options?.binaryPath).toBe(INSTALLED_OBSIDIAN_BINARY);
    expect(options?.appVersion).toBe("1.14.4");
    expect(options?.plugins).toEqual([STAGE]);
    expect(options?.vault).toBe(VAULT);
    expect(caps[0]?.browserName).toBe("obsidian");
    expect(caps[0]?.browserVersion).toBe("1.14.4");
    // chromedriver is chosen from installerVersion, so binaryPath mode must pin it too.
    expect(options?.installerVersion).toBe("1.13.7");
  });

  it("accepts the installed binary path when passed explicitly", () => {
    const caps = buildLaunchCapabilities(input({ binaryPath: INSTALLED_OBSIDIAN_BINARY }));
    expect(caps[0]?.["wdio:obsidianOptions"].binaryPath).toBe(INSTALLED_OBSIDIAN_BINARY);
  });

  it("refuses any other binary path with a fixed message that does not echo it", () => {
    const other = "/Users/USERNAME/Downloads/Obsidian.app/Contents/MacOS/Obsidian";
    expect(() => buildLaunchCapabilities(input({ binaryPath: other }))).toThrowError(MSG_BINARY);
    try {
      buildLaunchCapabilities(input({ binaryPath: other }));
    } catch (error) {
      expect((error as Error).message).not.toContain("Downloads");
    }
  });
});

describe("buildLaunchCapabilities, installer mode", () => {
  it("carries installerVersion and appVersion and no binaryPath key at all", () => {
    const caps = buildLaunchCapabilities(input({}, { launch: "installer", appVersion: "1.13.7" }));
    const options = caps[0]?.["wdio:obsidianOptions"];
    expect(options?.installerVersion).toBe("1.13.7");
    expect(options?.appVersion).toBe("1.13.7");
    expect(options && "binaryPath" in options).toBe(false);
  });

  it("refuses a binary path in installer mode", () => {
    expect(() =>
      buildLaunchCapabilities(
        input({ binaryPath: INSTALLED_OBSIDIAN_BINARY }, { launch: "installer" }),
      ),
    ).toThrowError(MSG_BINARY);
  });
});

describe("buildLaunchCapabilities, vault safety (D-07, D-08)", () => {
  it("refuses a vault outside the run root, including a sibling that only shares the prefix", () => {
    expect(() => buildLaunchCapabilities(input({ vaultPath: "/tmp/other/vault" }))).toThrowError(
      MSG_OUTSIDE,
    );
    expect(() =>
      buildLaunchCapabilities(input({ vaultPath: `${RUN_ROOT}-sibling/vault` })),
    ).toThrowError(MSG_OUTSIDE);
    expect(() => buildLaunchCapabilities(input({ vaultPath: RUN_ROOT }))).toThrowError(MSG_OUTSIDE);
    expect(() => buildLaunchCapabilities(input({ vaultPath: "vaults/live" }))).toThrowError(
      MSG_OUTSIDE,
    );
  });

  it("refuses the home directory as the vault, and a run root that is or contains the home directory", () => {
    expect(() => buildLaunchCapabilities(input({ vaultPath: HOME }))).toThrowError(MSG_OUTSIDE);
    expect(() =>
      buildLaunchCapabilities(input({ runRoot: HOME, vaultPath: `${HOME}/vault` })),
    ).toThrowError(MSG_RUN_ROOT);
    expect(() =>
      buildLaunchCapabilities(
        input({ runRoot: "/home", vaultPath: "/home/vault", homeDir: "/home/tester" }),
      ),
    ).toThrowError(MSG_RUN_ROOT);
  });

  it("refuses a vault that is, contains or sits inside a listed owner vault", () => {
    for (const owner of [VAULT, `${VAULT}/nested`, RUN_ROOT, `${RUN_ROOT}/vaults`]) {
      expect(() => buildLaunchCapabilities(input({ ownerVaultPaths: [owner] }))).toThrowError(
        MSG_OWNER_VAULT,
      );
    }
    expect(() =>
      buildLaunchCapabilities(input({ ownerVaultPaths: [`${HOME}/Vaults/real`] })),
    ).not.toThrow();
  });

  it("copies the vault by default and uses it in place only for a stated big vault", () => {
    expect(buildLaunchCapabilities(input())[0]?.["wdio:obsidianOptions"].copy).toBe(true);
    expect(
      buildLaunchCapabilities(input({ bigVault: false }))[0]?.["wdio:obsidianOptions"].copy,
    ).toBe(true);
    expect(
      buildLaunchCapabilities(input({ bigVault: true }))[0]?.["wdio:obsidianOptions"].copy,
    ).toBe(false);
  });

  it("refuses a relative stage directory and the plugin package directory (it holds owner data.json)", () => {
    expect(() => buildLaunchCapabilities(input({ pluginStageDir: "stage" }))).toThrowError(
      MSG_STAGE,
    );
    expect(() => buildLaunchCapabilities(input({ pluginStageDir: PLUGIN_BUILD_DIR }))).toThrowError(
      MSG_STAGE,
    );
  });

  it("refuses a relative cache directory and one inside the Obsidian profile", () => {
    expect(() => buildLaunchCapabilities(input({ cacheDir: ".obsidian-cache" }))).toThrowError(
      MSG_CACHE,
    );
    expect(() =>
      buildLaunchCapabilities(
        input({ cacheDir: `${HOME}/Library/Application Support/obsidian/c` }),
      ),
    ).toThrowError(MSG_CACHE);
  });
});

describe("run-root placement (MEDIUM-1, D-05, D-07)", () => {
  it("refuses a run root below the home directory that is not under /tmp", () => {
    expect(() =>
      buildLaunchCapabilities(
        input({ runRoot: `${HOME}/Documents`, vaultPath: `${HOME}/Documents/OwnerVault` }),
      ),
    ).toThrow(MSG_RUN_ROOT);
  });

  it("refuses a /tmp child without the ccc-uat. prefix, or a nested one", () => {
    for (const root of ["/tmp/other", "/tmp/ccc-uat.x/nested", "/tmp"]) {
      expect(() =>
        buildLaunchCapabilities(input({ runRoot: root, vaultPath: `${root}/v` })),
      ).toThrow(MSG_RUN_ROOT);
    }
  });

  it("refuses a big-vault run opened in place under the home directory", () => {
    expect(() =>
      buildLaunchCapabilities(
        input({ bigVault: true, runRoot: `${HOME}/x`, vaultPath: `${HOME}/x/v` }),
      ),
    ).toThrow(MSG_RUN_ROOT);
  });

  it("refuses a cache directory inside the repository unless it is .obsidian-cache", () => {
    expect(() => buildLaunchCapabilities(input({ cacheDir: `${REPO_ROOT}/cache` }))).toThrow(
      MSG_CACHE,
    );
    expect(() =>
      buildLaunchCapabilities(input({ cacheDir: `${REPO_ROOT}/.obsidian-cache` })),
    ).not.toThrow();
  });
});

describe("buildLaunchCapabilities, one window (maxInstances and vault list)", () => {
  it("never returns more than one capability and opens exactly the one vault", () => {
    for (const bigVault of [false, true]) {
      const caps = buildLaunchCapabilities(input({ bigVault }));
      expect(caps).toHaveLength(1);
      expect(caps[0]?.maxInstances).toBe(1);
      const options = caps[0]?.["wdio:obsidianOptions"];
      expect(typeof options?.vault).toBe("string");
      expect(options && "vaults" in options).toBe(false);
      expect(options?.plugins).toHaveLength(1);
    }
  });
});
