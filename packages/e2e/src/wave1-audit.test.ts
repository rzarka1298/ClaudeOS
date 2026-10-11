import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildLaunchCapabilities } from "./launch-options.js";
import { HOOK_ENTRY, PLUGIN_BUILD_DIR, REPO_ROOT, SERVICE_ENTRY } from "./repo-paths.js";
import { PROVISIONAL_SPIKE_DECISIONS } from "./spike-decisions.js";

// Wave 1 Nyquist audit additions: must-haves the original tests left unproven.

const RUN_ROOT = "/tmp/ccc-uat.AbC123";
const base = {
  decisions: PROVISIONAL_SPIKE_DECISIONS,
  vaultPath: `${RUN_ROOT}/vaults/live`,
  runRoot: RUN_ROOT,
  cacheDir: "/repo/.obsidian-cache",
  homeDir: "/Users/USERNAME",
};
const MSG_STAGE = "Refusing a plugin stage directory that is relative or is the plugin package.";

describe("plugin stage safety (D-07)", () => {
  it("refuses any directory below the plugin package, where the owner's data.json lives", () => {
    for (const sub of ["stage", "dist/stage", ".hotreload"]) {
      expect(() =>
        buildLaunchCapabilities({ ...base, pluginStageDir: join(PLUGIN_BUILD_DIR, sub) }),
      ).toThrowError(MSG_STAGE);
    }
  });

  it("accepts a sibling that merely shares the plugin package name as a prefix", () => {
    const caps = buildLaunchCapabilities({
      ...base,
      pluginStageDir: `${PLUGIN_BUILD_DIR}-stage`,
    });
    expect(caps[0]?.["wdio:obsidianOptions"].plugins).toEqual([`${PLUGIN_BUILD_DIR}-stage`]);
  });
});

describe("repo paths point at real build outputs", () => {
  it("maps the service and hook entries to packages whose sources exist", () => {
    expect(existsSync(join(REPO_ROOT, "packages", "service", "src", "main.ts"))).toBe(true);
    expect(existsSync(join(REPO_ROOT, "packages", "collectors", "src", "hook", "entry.ts"))).toBe(
      true,
    );
    expect(existsSync(join(PLUGIN_BUILD_DIR, "manifest.json"))).toBe(true);
    expect(SERVICE_ENTRY).toBe(join(REPO_ROOT, "packages/service/dist/main.js"));
    expect(HOOK_ENTRY).toBe(join(REPO_ROOT, "packages/collectors/dist/hook/entry.js"));
  });
});

describe("no build-script allowance was widened for the wdio set (T-05.2-01)", () => {
  it("keeps the wdio browser-driver packages out of allowBuilds", () => {
    const text = readFileSync(join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8");
    const block = /^allowBuilds:\n((?: {2}.*\n)+)/m.exec(text)?.[1] ?? "";
    expect(block).toContain("better-sqlite3");
    for (const name of ["classic-level", "edgedriver", "geckodriver", "wdio", "webdriverio"]) {
      expect(block, name).not.toContain(name);
    }
  });
});

describe("STACK.md records the real pins (D-14)", () => {
  const stack = join(REPO_ROOT, ".planning", "research", "STACK.md");
  it.skipIf(!existsSync(stack))("lists the pinned wdio set and the 9.x-not-10.x reason", () => {
    const text = readFileSync(stack, "utf8");
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, "packages/e2e/package.json"), "utf8"),
    ) as {
      devDependencies: Record<string, string>;
    };
    const dev = manifest.devDependencies;
    expect(text).toContain(`wdio-obsidian-service ${dev["wdio-obsidian-service"]}`);
    expect(text).toContain(`wdio-obsidian-reporter ${dev["wdio-obsidian-reporter"]}`);
    expect(text).toContain(`${dev.webdriverio}`);
    expect(text).toMatch(/never 10\.x/);
  });
});
