// FIX2A m7 (plan 08-09, D-14, T-08-24): the hostile diagnostic corpus is test data, left out of the
// browser barrel on purpose, but the plugin imports the full `@ccc/domain` for values, so whether
// the corpus reaches `main.js` depends on tree-shaking. This gate bundles the plugin exactly the
// way `packages/plugin/esbuild.config.mjs` does, into a temporary folder, and asserts that the output
// holds neither the corpus's exported names nor its canary and sample names. A positive control (a
// synthetic entry that does use the corpus) proves the check can see it, and a check of the plugin's
// own config keeps the externals used here equal to the shipped build's.

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CORPUS_CANARY,
  CORPUS_DENYLIST_INPUT,
  HOSTILE_NAME_SAMPLES,
  HOSTILE_SHAPE_SAMPLES,
  SYNTHETIC_USER,
} from "@ccc/domain";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { REPO_ROOT } from "./gate-repo.js";

const PLUGIN_DIR = join(REPO_ROOT, "packages", "plugin");
const CONFIG_TEXT = readFileSync(join(PLUGIN_DIR, "esbuild.config.mjs"), "utf8");

/** The externals of the shipped build (copied; the config file runs a build when imported, so it cannot be). */
const EXTERNALS = [
  "obsidian",
  "electron",
  "@codemirror/autocomplete",
  "@codemirror/collab",
  "@codemirror/commands",
  "@codemirror/language",
  "@codemirror/lint",
  "@codemirror/search",
  "@codemirror/state",
  "@codemirror/view",
  "@lezer/common",
  "@lezer/highlight",
  "@lezer/lr",
];

/** The corpus's exported names (diagnostic-corpus.ts) and the sample text it holds. */
const CORPUS_NAMES = [
  "HOSTILE_SHAPE_SAMPLES",
  "HOSTILE_NAME_SAMPLES",
  "PASS_THROUGH_SAMPLES",
  "CORPUS_CANARY",
  "CORPUS_DENYLIST_INPUT",
  "SYNTHETIC_USER",
  "cleanBundleInput",
  "richHealth",
  "freshInstallHealth",
];
const CORPUS_TEXT = [
  // The canary and the sample paths are assembled from pieces at run time, so the whole value is not
  // in the file as a literal; the unique piece of the canary is.
  "9f2c1e",
  CORPUS_CANARY,
  SYNTHETIC_USER,
  ...CORPUS_DENYLIST_INPUT.projectNames,
  ...CORPUS_DENYLIST_INPUT.folderBasenames,
  ...CORPUS_DENYLIST_INPUT.github.flatMap((target) => [target.owner, target.repo]),
  ...HOSTILE_NAME_SAMPLES.map((sample) => sample.value).filter((value) => value.length >= 8),
  ...HOSTILE_SHAPE_SAMPLES.map((sample) => sample.value).filter((value) => value.length >= 12),
];

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** Bundles into a fresh temporary folder with the shipped build's options and returns what it wrote. */
async function bundle(
  entry: { entryPoints: string[] } | { stdin: { contents: string } },
): Promise<string> {
  const outdir = mkdtempSync(join(tmpdir(), "ccc-plugin-bundle-"));
  folders.push(outdir);
  await build({
    ...("stdin" in entry
      ? { stdin: { ...entry.stdin, resolveDir: PLUGIN_DIR, loader: "ts" as const } }
      : { entryPoints: entry.entryPoints.map((path) => join(PLUGIN_DIR, path)) }),
    bundle: true,
    external: EXTERNALS,
    format: "cjs",
    target: "es2022",
    treeShaking: true,
    platform: "node",
    logLevel: "silent",
    outdir,
    entryNames: "[name]",
  });
  return readdirSync(outdir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => readFileSync(join(outdir, name), "utf8"))
    .join("\n");
}

describe("the plugin bundle carries none of the hostile diagnostic corpus", () => {
  it("builds with the externals of the shipped esbuild config", () => {
    for (const external of EXTERNALS) expect(CONFIG_TEXT, external).toContain(`"${external}"`);
    expect(CONFIG_TEXT).toContain('format: "cjs"');
    expect(CONFIG_TEXT).toContain('platform: "node"');
  });

  it("main.js holds no corpus export name and none of its canary or sample text", async () => {
    const output = await bundle({ entryPoints: ["src/main.ts"] });
    expect(output.length).toBeGreaterThan(100_000);
    for (const name of CORPUS_NAMES) expect(output, name).not.toContain(name);
    for (const text of CORPUS_TEXT) expect(output, text).not.toContain(text);
  }, 120_000);

  it("positive control: a bundle whose entry does use the corpus is seen to hold it", async () => {
    const output = await bundle({
      stdin: {
        contents:
          'import { HOSTILE_SHAPE_SAMPLES, CORPUS_CANARY } from "@ccc/domain";\n' +
          "globalThis.keep = [HOSTILE_SHAPE_SAMPLES, CORPUS_CANARY];\n",
      },
    });
    expect(output).toContain("HOSTILE_SHAPE_SAMPLES");
    expect(output).toContain("9f2c1e");
    expect(output).toContain("Orchard Ledger");
  }, 120_000);
});
