import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GENERATOR_SCRIPT,
  HOOK_ENTRY,
  INSTALLED_OBSIDIAN_BINARY,
  PLUGIN_BUILD_DIR,
  REPO_ROOT,
  SERVICE_ENTRY,
} from "./repo-paths.js";

describe("repo paths", () => {
  it("are all absolute", () => {
    for (const value of [
      REPO_ROOT,
      SERVICE_ENTRY,
      HOOK_ENTRY,
      PLUGIN_BUILD_DIR,
      GENERATOR_SCRIPT,
      INSTALLED_OBSIDIAN_BINARY,
    ]) {
      expect(isAbsolute(value), value).toBe(true);
    }
  });

  it("end with the documented tails", () => {
    expect(SERVICE_ENTRY.endsWith("packages/service/dist/main.js")).toBe(true);
    expect(HOOK_ENTRY.endsWith("packages/collectors/dist/hook/entry.js")).toBe(true);
    expect(PLUGIN_BUILD_DIR.endsWith("packages/plugin")).toBe(true);
    expect(GENERATOR_SCRIPT.endsWith("scripts/generate-task-fixture-vault.mjs")).toBe(true);
    expect(INSTALLED_OBSIDIAN_BINARY).toBe("/Applications/Obsidian.app/Contents/MacOS/Obsidian");
  });

  it("derive from the module location: the repo root holds the workspace file and the generator", () => {
    expect(existsSync(join(REPO_ROOT, "pnpm-workspace.yaml"))).toBe(true);
    expect(existsSync(GENERATOR_SCRIPT)).toBe(true);
    expect(SERVICE_ENTRY.startsWith(`${REPO_ROOT}/`)).toBe(true);
    expect(HOOK_ENTRY.startsWith(`${REPO_ROOT}/`)).toBe(true);
    expect(PLUGIN_BUILD_DIR.startsWith(`${REPO_ROOT}/`)).toBe(true);
  });

  it("keeps the one fixed absolute path outside any home directory", () => {
    expect(INSTALLED_OBSIDIAN_BINARY.startsWith(homedir())).toBe(false);
  });
});
