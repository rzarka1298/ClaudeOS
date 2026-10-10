// Wave 4 test audit (plan 05.1-24): two truths the authoring tests leave open.
//   - A backup never overwrites an earlier backup, even when two backups would
//     get the same timestamp (the clock is frozen in the child to force it).
//   - No new dependency: every import in the installer scripts is a Node
//     builtin, a sibling of the Codex scripts, or the Claude installer's lib.
// Throwaway directories under the system temp dir only.
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPTS_DIR = join(REPO_ROOT, "scripts", "codex-hooks");
const TMP_REAL = realpathSync(tmpdir());

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Pins the ISO timestamp in the child so two backups in one run get the same stamp. */
const FREEZE_CLOCK =
  "data:text/javascript," +
  encodeURIComponent(
    "Date.prototype.toISOString = function () { return '2026-10-08T12:00:00.000Z'; };",
  );

function installInto(codexHome: string, runtimeDir: string) {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      FREEZE_CLOCK,
      join(SCRIPTS_DIR, "install.mjs"),
      "--codex-home",
      codexHome,
      "--runtime-dir",
      runtimeDir,
    ],
    {
      cwd: REPO_ROOT,
      env: {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: dirname(codexHome),
        CODEX_HOME: codexHome,
        CCC_RUNTIME_DIR: runtimeDir,
      },
      encoding: "utf8",
    },
  );
  expect(result.status, result.stderr).toBe(0);
}

describe("backups never overwrite an earlier backup (D-19)", () => {
  it("two writes that share one timestamp keep both backups, the first untouched", () => {
    const root = mkdtempSync(join(TMP_REAL, "cc4-"));
    roots.push(root);
    const codexHome = join(root, "h", "cx");
    const runtimeDir = join(root, "rt");
    mkdirSync(codexHome, { recursive: true });
    const hooksPath = join(codexHome, "hooks.json");

    const first = `${JSON.stringify({ description: "first owner file", hooks: {} }, null, 4)}\n`;
    writeFileSync(hooksPath, first);
    installInto(codexHome, runtimeDir);

    // The owner replaces the file with different content; the next install backs THAT up.
    const second = `${JSON.stringify({ description: "second owner file", hooks: {} }, null, 4)}\n`;
    writeFileSync(hooksPath, second);
    installInto(codexHome, runtimeDir);

    const backups = readdirSync(codexHome)
      .filter((name) => name.startsWith("hooks.json.ccc-backup-"))
      .sort();
    expect(backups).toHaveLength(2);
    const contents = backups.map((name) => readFileSync(join(codexHome, name), "utf8"));
    expect(contents).toContain(first);
    expect(contents).toContain(second);
    expect(new Set(backups).size).toBe(2);
  });
});

describe("no new dependency (plan 05.1-24)", () => {
  const ALLOWED_RELATIVE = new Set(["./lib.mjs", "../claude-hooks/lib.mjs"]);
  const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

  it.each(["install.mjs", "uninstall.mjs", "status.mjs", "lib.mjs"])(
    "%s imports only Node builtins, its sibling lib and the Claude installer's lib",
    (file) => {
      const source = readFileSync(join(SCRIPTS_DIR, file), "utf8");
      const specifiers = [...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map(
        (match) => match[1] as string,
      );
      expect(specifiers.length).toBeGreaterThan(0);
      for (const specifier of specifiers) {
        const ok = builtins.has(specifier) || ALLOWED_RELATIVE.has(specifier);
        expect(ok, `${file} imports ${specifier}`).toBe(true);
      }
    },
  );
});
