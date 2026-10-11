import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Absolute paths the live-UAT runner needs, all derived from this module's own
 * location so no home directory is ever written as a literal. This file sits at
 * packages/e2e/src (and packages/e2e/dist once built), both two levels below the
 * package root and four below the repository root.
 */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = resolve(MODULE_DIR, "..", "..", "..");

/** The built companion-service entry point the throwaway service starts from. */
export const SERVICE_ENTRY = join(REPO_ROOT, "packages", "service", "dist", "main.js");

/** The built Claude hook entry, used to feed synthetic hook events (D-13). */
export const HOOK_ENTRY = join(REPO_ROOT, "packages", "collectors", "dist", "hook", "entry.js");

/** The plugin package directory; main.js, manifest.json and styles.css are staged from it. */
export const PLUGIN_BUILD_DIR = join(REPO_ROOT, "packages", "plugin");

/** The synthetic-vault generator (D-07). */
export const GENERATOR_SCRIPT = join(REPO_ROOT, "scripts", "generate-task-fixture-vault.mjs");

/**
 * The owner's installed Obsidian executable (L-3). It is the one fixed absolute
 * path: the sandbox launches this binary with a private user-data directory so the
 * owner's real Obsidian profile is never touched.
 */
export const INSTALLED_OBSIDIAN_BINARY = "/Applications/Obsidian.app/Contents/MacOS/Obsidian";
