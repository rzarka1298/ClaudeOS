// Plan 05.1-24 audits (CODEX-06, CODEX-09, D-19, T-05.1-09): the Codex hook
// installer touches the hooks file, its backups, its own temp file and the
// installed runtime subtree, and nothing else. Codex's config file, its notify
// setting and its hook trust state stay out of reach: a decoy copy must be
// byte-identical across a full cycle, a recorder lists every path the scripts
// write, and the script sources are scanned for any instruction that writes
// them. Everything runs in throwaway directories under the system temp dir.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupRecorderDirs, runRecorded } from "./codex-hooks-fs-recorder.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPTS_DIR = join(REPO_ROOT, "scripts", "codex-hooks");
const INSTALL = join(SCRIPTS_DIR, "install.mjs");
const UNINSTALL = join(SCRIPTS_DIR, "uninstall.mjs");
const STATUS = join(SCRIPTS_DIR, "status.mjs");
const TMP_REAL = realpathSync(tmpdir());

/** Literals assembled at runtime: no line of this file (or of the scripts) names them. */
const CONFIG_FILE_NAME = ["config", "toml"].join(".");
const CREDENTIAL_FILE_NAME = ["auth", "json"].join(".");
const TRUST_KEY = ["trusted", "hash"].join("_");
const TRUST_TABLE = ["hooks", "state"].join(".");
const NOTIFY_KEY = ["noti", "fy"].join("");

const DECOY_CONFIG = [
  `${NOTIFY_KEY} = ["/usr/local/bin/other-client"]`,
  "",
  `[${TRUST_TABLE}."hooks.json:Stop:0:0"]`,
  `${TRUST_KEY} = "sha256:0000000000000000000000000000000000000000000000000000000000000000"`,
  "",
  "[mcp_servers.demo.env]",
  'DEMO_VALUE = "decoy-env-value"',
  "",
].join("\n");
const DECOY_CREDENTIAL = '{"decoy":"placeholder-not-a-credential"}\n';

const OWNER_HOOKS = {
  description: "owner hooks",
  hooks: { Stop: [{ hooks: [{ type: "command", command: "echo owner-stop" }] }] },
};

interface Fixture {
  root: string;
  codexHome: string;
  hooksPath: string;
  runtimeDir: string;
  configPath: string;
  credentialPath: string;
  env: NodeJS.ProcessEnv;
  args: string[];
  originalBytes: string;
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  cleanupRecorderDirs();
});

function makeFixture(): Fixture {
  const root = mkdtempSync(join(TMP_REAL, "cca-"));
  roots.push(root);
  const home = join(root, "h");
  const codexHome = join(home, "cx");
  const runtimeDir = join(root, "rt");
  mkdirSync(codexHome, { recursive: true });
  expect(root.startsWith(`${TMP_REAL}/`)).toBe(true);
  const hooksPath = join(codexHome, "hooks.json");
  const configPath = join(codexHome, CONFIG_FILE_NAME);
  const credentialPath = join(codexHome, CREDENTIAL_FILE_NAME);
  writeFileSync(configPath, DECOY_CONFIG);
  writeFileSync(credentialPath, DECOY_CREDENTIAL);
  const originalBytes = `${JSON.stringify(OWNER_HOOKS, null, 4)}\n`;
  writeFileSync(hooksPath, originalBytes);
  return {
    root,
    codexHome,
    hooksPath,
    runtimeDir,
    configPath,
    credentialPath,
    originalBytes,
    env: {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: home,
      CODEX_HOME: codexHome,
      CCC_RUNTIME_DIR: runtimeDir,
    },
    args: ["--codex-home", codexHome, "--runtime-dir", runtimeDir],
  };
}

function run(fx: Fixture, script: string, extra: string[] = []) {
  const result = spawnSync(process.execPath, [script, ...fx.args, ...extra], {
    cwd: REPO_ROOT,
    env: fx.env,
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return result;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Relative path to SHA-256 of every file under `dir`, skipping the hooks file and its backups. */
function codexHomeSnapshot(fx: Fixture): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of readdirSync(fx.codexHome, { recursive: true, encoding: "utf8" }).sort()) {
    if (rel === "hooks.json" || rel.startsWith("hooks.json.ccc-")) continue;
    out[rel] = sha256(join(fx.codexHome, rel));
  }
  return out;
}

describe("the never-touch audit: config file, notify setting and trust state (T-05.1-09)", () => {
  it("the decoy config and credential files are byte-identical, same mtime, across install, re-install, dry runs and uninstall", () => {
    const fx = makeFixture();
    const configHash = sha256(fx.configPath);
    const credentialHash = sha256(fx.credentialPath);
    const configMtime = statSync(fx.configPath).mtimeMs;
    const snapshot = codexHomeSnapshot(fx);

    run(fx, INSTALL, ["--dry-run"]);
    run(fx, INSTALL);
    run(fx, INSTALL);
    run(fx, STATUS);
    run(fx, UNINSTALL, ["--dry-run"]);
    run(fx, UNINSTALL);

    expect(sha256(fx.configPath)).toBe(configHash);
    expect(sha256(fx.credentialPath)).toBe(credentialHash);
    expect(statSync(fx.configPath).mtimeMs).toBe(configMtime);
    expect(codexHomeSnapshot(fx)).toEqual(snapshot);
    expect(readFileSync(fx.hooksPath, "utf8")).toBe(fx.originalBytes);
  });

  it("the recorded write set over a full cycle is the hooks file, its backups, its temp file and the runtime subtree", () => {
    const fx = makeFixture();
    const allowed = (path: string): boolean =>
      path === fx.hooksPath ||
      (dirname(path) === fx.codexHome &&
        (/^hooks\.json\.ccc-backup-[0-9TZ-]+(-\d+)?$/.test(path.slice(fx.codexHome.length + 1)) ||
          /^\.hooks\.json\.ccc-tmp-\d+-[0-9a-f]+$/.test(path.slice(fx.codexHome.length + 1)))) ||
      path === fx.runtimeDir ||
      path.startsWith(`${fx.runtimeDir}/codex-hooks`);

    const cycle: Array<[string, string[]]> = [
      [INSTALL, ["--dry-run"]],
      [INSTALL, []],
      [INSTALL, []],
      [STATUS, []],
      [UNINSTALL, ["--dry-run"]],
      [UNINSTALL, []],
    ];
    const allWrites = new Set<string>();
    const allReads = new Set<string>();
    for (const [script, extra] of cycle) {
      const recorded = runRecorded(script, [...fx.args, ...extra], {
        env: fx.env,
        repoRoot: REPO_ROOT,
      });
      expect(recorded.status, recorded.stderr).toBe(0);
      if (extra.includes("--dry-run") || script === STATUS) {
        expect(recorded.writes, `${script} ${extra.join(" ")}`).toEqual([]);
      }
      for (const path of recorded.writes) {
        expect(allowed(path), `${script} wrote ${path}`).toBe(true);
        allWrites.add(path);
      }
      for (const path of recorded.reads) allReads.add(path);
    }

    // Positive controls: the recorder saw the writes it is supposed to catch.
    expect(allWrites.has(fx.hooksPath)).toBe(true);
    expect([...allWrites].some((path) => path.includes("hooks.json.ccc-backup-"))).toBe(true);
    expect([...allWrites].some((path) => path.includes(".hooks.json.ccc-tmp-"))).toBe(true);
    expect([...allWrites].some((path) => path.startsWith(`${fx.runtimeDir}/codex-hooks`))).toBe(
      true,
    );
    // Never written, never read: the config file, the credential file, the trust state.
    for (const path of [...allWrites, ...allReads]) {
      expect(path.endsWith(CONFIG_FILE_NAME), path).toBe(false);
      expect(path.endsWith(CREDENTIAL_FILE_NAME), path).toBe(false);
    }
  });

  it("no script source names the config file, the credential file, the trust state or a notify write", () => {
    const sources = readdirSync(SCRIPTS_DIR).filter((name) => /\.(mjs|sh)$/.test(name));
    expect(sources.sort()).toEqual([
      "install.mjs",
      "install.sh",
      "lib.mjs",
      "status.mjs",
      "status.sh",
      "uninstall.mjs",
      "uninstall.sh",
    ]);
    for (const name of sources) {
      const violations = scanForbidden(readFileSync(join(SCRIPTS_DIR, name), "utf8"));
      expect(violations, name).toEqual([]);
    }
  });

  it("the scanner has teeth: each forbidden form is caught in a planted line", () => {
    const planted = [
      `writeFileSync(join(home, "${CONFIG_FILE_NAME}"), text);`,
      `const p = "~/.codex/${CREDENTIAL_FILE_NAME}";`,
      `text += '${TRUST_KEY} = "x"';`,
      `const header = "[${TRUST_TABLE}]";`,
      `${NOTIFY_KEY} = ["a"]`,
      `args.push("-c", "${NOTIFY_KEY}=x");`,
      `import { execFileSync } from "node:child_process";`,
      `spawnSync("codex", ["--version"]);`,
    ];
    for (const line of planted) {
      expect(scanForbidden(`${line}\n`).length, line).toBeGreaterThan(0);
    }
    expect(scanForbidden("// the notify setting is never touched\nconst ok = 1;\n")).toEqual([]);
  });
});

/** Lines of `source` that name a forbidden file, key or write, or that could run a program. */
function scanForbidden(source: string): string[] {
  const hits: string[] = [];
  const patterns: RegExp[] = [
    new RegExp(`(^|[^A-Za-z0-9_])${CONFIG_FILE_NAME.replace(".", "[.]")}`),
    new RegExp(`(^|[^A-Za-z0-9_])${CREDENTIAL_FILE_NAME.replace(".", "[.]")}`),
    new RegExp(TRUST_KEY),
    new RegExp(TRUST_TABLE.replace(".", "[.]")),
    // A TOML-style assignment or the command-line override form (the backstop rule 16 family).
    new RegExp(`(^|[^A-Za-z0-9_])${NOTIFY_KEY}[ \\t]*=[ \\t]*([\\[]|["'\`])`),
    new RegExp(`(^|[^A-Za-z0-9_])${NOTIFY_KEY}=([^=>]|$)`),
    /node:child_process|from "child_process"|require\("child_process"\)/,
    /(spawn|exec)(File)?(Sync)?\(\s*["'`]codex/,
  ];
  for (const line of source.split("\n")) {
    if (/^\s*(\/\/|#|\*|\/\*)/.test(line)) continue;
    if (patterns.some((pattern) => pattern.test(line))) hits.push(line.trim());
  }
  return hits;
}

describe("the installed copy is pure and runs as an ES module", () => {
  it("every installed .js file imports only node builtins and files inside the installed layout, never the child-process module", () => {
    const fx = makeFixture();
    run(fx, INSTALL);
    const root = join(fx.runtimeDir, "codex-hooks");
    const files = readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((rel) => rel.endsWith(".js"))
      .sort();
    expect(files).toEqual([
      "codex-hook/entry.js",
      "codex-hook/limits.js",
      "codex-hook/minimize.js",
      "hook/deliver.js",
      "hook/limits.js",
    ]);
    const importPattern =
      /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g;
    for (const rel of files) {
      const source = readFileSync(join(root, rel), "utf8");
      for (const match of source.matchAll(importPattern)) {
        const specifier = match[1] ?? match[2] ?? match[3] ?? "";
        if (specifier.startsWith("node:")) {
          expect(specifier, `${rel} imports a process-spawning module`).not.toBe(
            "node:child_process",
          );
          continue;
        }
        expect(specifier.startsWith("."), `${rel} imports ${specifier}`).toBe(true);
        const resolved = resolve(dirname(join(root, rel)), specifier);
        expect(resolved.startsWith(`${root}/`), `${rel} escapes via ${specifier}`).toBe(true);
        expect(existsSync(resolved), `${rel} imports a missing ${specifier}`).toBe(true);
      }
    }
  });

  it("the ES module marker is what lets the copy load: without module-syntax detection the copy fails if the marker is removed", () => {
    const fx = makeFixture();
    run(fx, INSTALL);
    const entry = join(fx.runtimeDir, "codex-hooks", "codex-hook", "entry.js");
    const marker = join(fx.runtimeDir, "codex-hooks", "package.json");
    const launch = () =>
      spawnSync(
        process.execPath,
        ["--no-experimental-detect-module", entry, "--runtime-dir", fx.runtimeDir],
        { env: fx.env, input: "{}", encoding: "utf8" },
      );
    expect(launch().status).toBe(0);
    const markerText = readFileSync(marker, "utf8");
    rmSync(marker);
    expect(launch().status).not.toBe(0);
    writeFileSync(marker, markerText);
    expect(launch().status).toBe(0);
  });
});
