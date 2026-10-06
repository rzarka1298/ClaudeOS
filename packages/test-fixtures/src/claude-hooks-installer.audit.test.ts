// Wave-3 audit (05-09): the installer refuses a Node older than 24 before any
// write. Runs the real install.mjs under an older Node binary with HOME,
// CLAUDE_CONFIG_DIR and CCC_RUNTIME_DIR all pointed at a temp dir. Skipped
// when no Node < 24 is available (set CCC_AUDIT_OLD_NODE to point at one).
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const INSTALL = join(REPO_ROOT, "scripts", "claude-hooks", "install.mjs");
const TEST_BASE = join(homedir(), ".ccc-test");

function findOldNode(): string | null {
  const explicit = process.env.CCC_AUDIT_OLD_NODE;
  if (explicit !== undefined && existsSync(explicit)) return explicit;
  const nvm = join(homedir(), ".nvm", "versions", "node");
  if (!existsSync(nvm)) return null;
  for (const name of readdirSync(nvm)) {
    const major = Number(/^v(\d+)\./.exec(name)?.[1] ?? "NaN");
    const bin = join(nvm, name, "bin", "node");
    if (major >= 20 && major < 24 && existsSync(bin)) return bin;
  }
  return null;
}

const OLD_NODE = findOldNode();
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("05-09 audit: Node version floor (PR-09)", () => {
  it.skipIf(OLD_NODE === null)("refuses Node < 24 with a non-zero exit and writes nothing", () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const root = mkdtempSync(join(TEST_BASE, "hooks-audit-"));
    roots.push(root);
    const home = join(root, "home");
    const configDir = join(home, "claude");
    const runtimeDir = join(home, "runtime");
    mkdirSync(configDir, { recursive: true });
    const settingsPath = join(configDir, "settings.json");
    const original = `${JSON.stringify({ model: "opus" }, null, 4)}\n`;
    writeFileSync(settingsPath, original);
    const claudeBin = join(root, "claude");
    writeFileSync(claudeBin, '#!/bin/sh\necho "2.1.283 (Claude Code)"\n');
    chmodSync(claudeBin, 0o755);

    const result = spawnSync(
      OLD_NODE as string,
      [
        INSTALL,
        "--claude-config-dir",
        configDir,
        "--runtime-dir",
        runtimeDir,
        "--claude-bin",
        claudeBin,
      ],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          HOME: home,
          CLAUDE_CONFIG_DIR: configDir,
          CCC_RUNTIME_DIR: runtimeDir,
        },
        encoding: "utf8",
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/older than Node 24/);
    expect(readFileSync(settingsPath, "utf8")).toBe(original);
    expect(readdirSync(configDir)).toEqual(["settings.json"]);
    expect(existsSync(join(runtimeDir, "hooks"))).toBe(false);
  });
});
