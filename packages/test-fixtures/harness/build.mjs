import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

// The visual-regression harness build (UI-08, D-21 as amended — esbuild, never
// Vite). Mirrors packages/plugin/esbuild.config.mjs's two-entry shape so one
// rebuild produces both `harness/dist/main.js` and `harness/dist/styles.css`.
//
// Three choices here are load-bearing:
//
// - NO externals. The plugin bundle marks `obsidian` external because Obsidian
//   supplies it at runtime; a `file://` page has no such runtime. Leaving the
//   list out means any transitive `obsidian` import reachable from
//   `@ccc/plugin`'s public entry FAILS this build loudly instead of shipping a
//   bundle that throws at load — the build is half of the PRIV-04 purity gate
//   (`src/harness-purity.test.ts` scans for an `external` option).
//
// - `format: "iife"`, `platform: "browser"`. Chromium refuses module scripts
//   on `file://` origins, and Playwright loads this page from `file://` so no
//   server — and no port — is ever involved.
//
// - The CSS entry is the PRODUCTION stylesheet, `../plugin/src/styles.css`, not
//   a copy: a baseline must regress when the shipped CSS does.
//
// Paths resolve against this package (not the caller's cwd), so the build
// behaves the same from `pnpm --filter`, turbo or a direct `node` call.

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const context = await esbuild.context({
  absWorkingDir: PACKAGE_DIR,
  entryPoints: ["harness/main.tsx", "../plugin/src/styles.css"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  jsxImportSource: "preact",
  logLevel: "info",
  sourcemap: process.argv.includes("--watch") ? "inline" : false,
  treeShaking: true,
  outdir: "harness/dist",
  entryNames: "[name]",
});

if (process.argv.includes("--watch")) {
  await context.watch();
} else {
  await context.rebuild();
  await context.dispose();
}
