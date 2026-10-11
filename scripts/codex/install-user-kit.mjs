#!/usr/bin/env node
// Installs the Codex wrapper user-level, so every project can use it as
// `codex-bridge`, plus the Antigravity IDE extension that opens a terminal tab
// per Codex run. This repository stays the tested source of truth; rerun this
// script after changing scripts/codex/. Idempotent: prints what it changed.
//
//   node scripts/codex/install-user-kit.mjs [--dry-run] [--claude-config]
//                                           [--no-extension] [--home <dir>]
//
// Installs (under HOME):
//   .local/share/codex-bridge/versions/<hash>/   copy of codex.mjs + schemas + extension core
//   .local/share/codex-bridge/current            symlink to the installed version
//   .local/bin/codex-bridge                      launcher (pins this node binary)
//   Antigravity extension local.codex-bridge     packed locally as a .vsix, no network
//   <bridge state>/{requests,claimed,windows}/   $XDG_STATE_HOME or .local/state/codex-bridge
//   <bridge state>/protocol.json                 { protocol, capabilities, kit }: what this kit speaks
// With --claude-config, also merges into ~/.claude/settings.json
// (allow Bash(codex-bridge:*), deny Bash(codex:*)) and writes
// ~/.claude/rules/codex.md. Without it, Claude's config is never touched.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = join(HERE, "antigravity-extension");
const bridge = createRequire(import.meta.url)("./antigravity-extension/bridge-core.js");

const EXT_FILES = ["package.json", "extension.js", "bridge-core.js"];
const KIT_FILES = [
  "codex.mjs",
  ...readdirSync(join(HERE, "schemas"))
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => `schemas/${f}`),
  ...EXT_FILES.map((f) => `antigravity-extension/${f}`),
];
const EXT_ID = "local.codex-bridge";

export const CLAUDE_ALLOW = "Bash(codex-bridge:*)";
export const CLAUDE_DENY = "Bash(codex:*)";
export const CLAUDE_RULE = `# Codex

- Talk to OpenAI Codex only through \`codex-bridge\` (usage, guard, review, task, resume, watch).
  Never run \`codex\` directly: the wrapper pins the sandbox and approval policy, refuses bypass
  flags, keeps the 20 % usage reserve and refuses dirty checkouts.
- Each run opens a terminal tab in the Antigravity IDE window of the project, following the live
  log and then opening the Codex session (\`codex resume\`), so the owner can watch and chat.
- Run \`codex-bridge review <worktree> <base>\` / \`task <linked-worktree> <brief>\` with an
  absolute or relative worktree path; run \`resume\` and \`watch\` from inside the project.
`;

function parse(argv) {
  const o = { dryRun: false, claudeConfig: false, extension: true, home: homedir() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") o.dryRun = true;
    else if (a === "--claude-config") o.claudeConfig = true;
    else if (a === "--no-extension") o.extension = false;
    else if (a === "--home" && argv[i + 1]) o.home = argv[++i];
    else {
      process.stderr.write(
        "usage: install-user-kit.mjs [--dry-run] [--claude-config] [--no-extension] [--home <dir>]\n",
      );
      process.exit(2);
    }
  }
  return o;
}

const opts = parse(process.argv.slice(2));
const HOME = opts.home;
const SHARE = join(HOME, ".local", "share", "codex-bridge");
const BIN = join(HOME, ".local", "bin");
const LAUNCHER = join(BIN, "codex-bridge");
const env = { ...process.env, HOME };
const STATE = bridge.bridgeStateDir(env, HOME);

const changes = [];
function changed(msg) {
  changes.push(msg);
  process.stdout.write(`${opts.dryRun ? "would change" : "changed"}: ${msg}\n`);
}
function unchanged(msg) {
  process.stdout.write(`unchanged: ${msg}\n`);
}
function note(msg) {
  process.stdout.write(`note: ${msg}\n`);
}

function hashOf(root, files) {
  const h = createHash("sha256");
  for (const f of files)
    h.update(`${f}\0`)
      .update(readFileSync(join(root, f)))
      .update("\0");
  return h.digest("hex").slice(0, 12);
}

function writeIfDifferent(path, content, mode) {
  const current = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (current === content) return false;
  if (!opts.dryRun) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, content, { mode: mode ?? 0o644 });
    if (mode) chmodSync(tmp, mode);
    renameSync(tmp, path);
  }
  return true;
}

// 1. Versioned copy of the kit.
const version = hashOf(HERE, KIT_FILES);
const target = join(SHARE, "versions", version);
if (existsSync(join(target, "codex.mjs"))) unchanged(`kit version ${version}`);
else {
  if (!opts.dryRun) {
    mkdirSync(join(SHARE, "versions"), { recursive: true });
    const staging = mkdtempSync(join(SHARE, "versions", ".staging-"));
    for (const f of KIT_FILES) {
      mkdirSync(dirname(join(staging, f)), { recursive: true });
      cpSync(join(HERE, f), join(staging, f));
    }
    rmSync(target, { recursive: true, force: true });
    renameSync(staging, target);
  }
  changed(`installed kit version ${version} in ${target}`);
}

// 2. current -> versions/<hash>
const currentLink = join(SHARE, "current");
let currentTarget = null;
try {
  currentTarget = readlinkSync(currentLink);
} catch {}
if (currentTarget === join("versions", version)) unchanged(`${currentLink} -> versions/${version}`);
else {
  if (!opts.dryRun) {
    mkdirSync(SHARE, { recursive: true });
    const tmp = join(SHARE, `.current.${process.pid}.tmp`);
    try {
      unlinkSync(tmp);
    } catch {}
    symlinkSync(join("versions", version), tmp);
    renameSync(tmp, currentLink);
  }
  changed(`${currentLink} -> versions/${version}`);
}

// 3. Launcher on PATH. It pins the node binary running this installer (>= 24),
// since IDE terminals and other projects may resolve a different `node`.
const q = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
const launcher = `#!/bin/sh
# codex-bridge: user-level launcher for the Codex wrapper.
# Installed by scripts/codex/install-user-kit.mjs; rerun that script to update.
CODEX_BRIDGE_CMD=codex-bridge
export CODEX_BRIDGE_CMD
exec ${q(process.execPath)} ${q(join(SHARE, "current", "codex.mjs"))} "$@"
`;
if (writeIfDifferent(LAUNCHER, launcher, 0o755)) changed(`launcher ${LAUNCHER}`);
else unchanged(`launcher ${LAUNCHER}`);
if (!(process.env.PATH ?? "").split(delimiter).includes(BIN)) {
  note(`${BIN} is not on PATH; add it to use \`codex-bridge\` by name`);
}

// 4. Bridge state dirs.
const missing = Object.values(bridge.dirs(STATE)).filter((d) => !existsSync(d));
if (missing.length) {
  if (!opts.dryRun) bridge.ensureDirs(STATE);
  changed(`bridge state dirs under ${STATE}`);
} else unchanged(`bridge state dirs under ${STATE}`);

// 5. Antigravity extension, packed locally and installed from the .vsix.
function run(cmd, args) {
  return spawnSync(cmd, args, { encoding: "utf8", env: process.env, timeout: 120_000 });
}

function packVsix() {
  const pkg = JSON.parse(readFileSync(join(EXT_DIR, "package.json"), "utf8"));
  const dir = mkdtempSync(join(tmpdir(), "codex-bridge-vsix-"));
  mkdirSync(join(dir, "extension"));
  for (const f of EXT_FILES) cpSync(join(EXT_DIR, f), join(dir, "extension", f));
  writeFileSync(
    join(dir, "extension.vsixmanifest"),
    `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${pkg.name}" Version="${pkg.version}" Publisher="${pkg.publisher}" />
    <DisplayName>${pkg.displayName}</DisplayName>
    <Description xml:space="preserve">${pkg.description}</Description>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${pkg.engines.vscode}" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>
`,
  );
  writeFileSync(
    join(dir, "[Content_Types].xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".json" ContentType="application/json" /><Default Extension=".js" ContentType="application/javascript" /><Default Extension=".vsixmanifest" ContentType="text/xml" /></Types>
`,
  );
  const vsix = join(dir, "codex-bridge.vsix");
  const z = spawnSync(
    "zip",
    ["-q", "-X", "-r", vsix, "[Content_Types].xml", "extension.vsixmanifest", "extension"],
    { cwd: dir, encoding: "utf8" },
  );
  if (z.status !== 0) throw new Error(`zip failed: ${z.stderr}`);
  return { dir, vsix };
}

if (opts.extension) {
  const cli = bridge.antigravityCli(process.env);
  if (!cli) note("Antigravity IDE not found; extension skipped (the wrapper works without it)");
  else {
    const extHash = hashOf(EXT_DIR, EXT_FILES);
    const stamp = join(SHARE, "extension.sha256");
    const stamped = existsSync(stamp) ? readFileSync(stamp, "utf8").trim() : null;
    const listed = run(cli, ["--list-extensions"]);
    const installed = listed.status === 0 && listed.stdout.split("\n").includes(EXT_ID);
    if (installed && stamped === extHash) unchanged(`Antigravity extension ${EXT_ID} (${extHash})`);
    else {
      if (!opts.dryRun) {
        const { dir, vsix } = packVsix();
        const r = run(cli, ["--install-extension", vsix, "--force"]);
        rmSync(dir, { recursive: true, force: true });
        if (r.status !== 0) {
          process.stderr.write(
            `install-user-kit: extension install failed:\n${r.stdout}${r.stderr}`,
          );
          process.exit(1);
        }
        writeIfDifferent(stamp, `${extHash}\n`);
      }
      changed(`Antigravity extension ${EXT_ID} (${extHash}); reload open Antigravity windows once`);
    }
  }
}

// 6. Protocol marker: tells the product what the installed kit speaks before any IDE window
// (and so any heartbeat) exists. An absent marker means no kit; an old one means re-run this.
const markerFile = join(STATE, bridge.PROTOCOL_MARKER_FILE);
const marker = bridge.readProtocolMarker(STATE);
if (
  marker &&
  marker.protocol === bridge.PROTOCOL_VERSION &&
  marker.kit === version &&
  JSON.stringify(marker.capabilities) === JSON.stringify(bridge.CAPABILITIES)
)
  unchanged(`protocol marker ${markerFile}`);
else {
  if (!opts.dryRun) bridge.writeProtocolMarker(STATE, version);
  changed(`protocol marker ${markerFile} (protocol ${bridge.PROTOCOL_VERSION}, kit ${version})`);
}

// 7. Opt-in: user-level Claude Code config.
if (opts.claudeConfig) {
  const settingsPath = join(HOME, ".claude", "settings.json");
  const raw = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : "{}\n";
  const settings = JSON.parse(raw);
  settings.permissions ??= {};
  settings.permissions.allow ??= [];
  settings.permissions.deny ??= [];
  let dirty = false;
  if (!settings.permissions.allow.includes(CLAUDE_ALLOW)) {
    settings.permissions.allow.push(CLAUDE_ALLOW);
    dirty = true;
  }
  if (!settings.permissions.deny.includes(CLAUDE_DENY)) {
    settings.permissions.deny.push(CLAUDE_DENY);
    dirty = true;
  }
  if (dirty) {
    if (!opts.dryRun) {
      if (existsSync(settingsPath)) writeFileSync(`${settingsPath}.codex-bridge.bak`, raw);
      writeIfDifferent(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    }
    changed(`${settingsPath}: allow ${CLAUDE_ALLOW}, deny ${CLAUDE_DENY}`);
  } else unchanged(`${settingsPath} permissions`);
  const rule = join(HOME, ".claude", "rules", "codex.md");
  if (writeIfDifferent(rule, CLAUDE_RULE)) changed(`rule ${rule}`);
  else unchanged(`rule ${rule}`);
}

process.stdout.write(
  `${changes.length} change${changes.length === 1 ? "" : "s"}${opts.dryRun ? " (dry run)" : ""}\n`,
);
