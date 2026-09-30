// scripts/codex/install-user-kit.mjs — installs the Codex wrapper user-level
// as `codex-bridge` plus the Antigravity extension. Every case installs into a
// throwaway HOME with a FAKE `antigravity-ide` (records --install-extension /
// --list-extensions) and a fake `codex`; the owner's real HOME is never touched.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REPO_ROOT } from "./gate-repo.js";

const INSTALLER = join(REPO_ROOT, "scripts", "codex", "install-user-kit.mjs");

// Fake antigravity-ide: remembers installed extensions in a file next to it.
const FAKE_AG = String.raw`
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const dir = __dirname;
const args = process.argv.slice(2);
fs.appendFileSync(dir + "/ag-calls.jsonl", JSON.stringify(args) + "\n");
const db = dir + "/installed.txt";
if (args[0] === "--list-extensions") {
  process.stdout.write(fs.existsSync(db) ? fs.readFileSync(db, "utf8") : "");
} else if (args[0] === "--install-extension") {
  const list = spawnSync("unzip", ["-l", args[1]], { encoding: "utf8" }).stdout;
  fs.writeFileSync(dir + "/vsix-listing.txt", list);
  fs.writeFileSync(db, "local.codex-bridge\n");
  process.stdout.write("Extension installed.\n");
}
`;

// Fake codex: answers just enough app-server JSON-RPC for `usage`.
const FAKE_CODEX = String.raw`
if (process.argv[2] !== "app-server") process.exit(1);
let b = "";
process.stdin.on("data", (d) => {
  b += d;
  let n;
  while ((n = b.indexOf("\n")) >= 0) {
    const m = JSON.parse(b.slice(0, n));
    b = b.slice(n + 1);
    if (m.id === 1) console.log(JSON.stringify({ id: 1, result: {} }));
    if (m.id === 2)
      console.log(JSON.stringify({ id: 2, result: { ordinaryUsageAllowed: true,
        rateLimits: { planType: "prolite", primary: { usedPercent: 7, resetsAt: 1790000000 } } } }));
  }
});
process.stdin.on("end", () => process.exit(0));
`;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

interface Kit {
  home: string;
  bin: string;
  install(args?: string[]): { status: number | null; out: string };
  agCalls(): string[][];
  env(): NodeJS.ProcessEnv;
}

function kit(): Kit {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ccc-kit-home-")));
  const bin = realpathSync(mkdtempSync(join(tmpdir(), "ccc-kit-bin-")));
  cleanups.push(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  });
  for (const [name, src] of [
    ["antigravity-ide", FAKE_AG],
    ["codex", FAKE_CODEX],
  ] as const) {
    writeFileSync(join(bin, name), `#!${process.execPath}\n${src}`);
    chmodSync(join(bin, name), 0o755);
  }
  const env = (): NodeJS.ProcessEnv => {
    const e: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(e)) if (k.startsWith("CODEX_BRIDGE_")) delete e[k];
    delete e.XDG_STATE_HOME;
    return {
      ...e,
      HOME: home,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      CODEX_BRIDGE_ANTIGRAVITY_APP: "/nonexistent/Antigravity IDE.app",
      CODEX_BRIDGE_TAB: "0",
    };
  };
  return {
    home,
    bin,
    env,
    install(args = []) {
      const r = spawnSync(process.execPath, [INSTALLER, "--home", home, ...args], {
        encoding: "utf8",
        env: env(),
        timeout: 60_000,
      });
      return { status: r.status, out: `${r.stdout}${r.stderr}` };
    },
    agCalls() {
      const f = join(bin, "ag-calls.jsonl");
      return existsSync(f)
        ? readFileSync(f, "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l))
        : [];
    },
  };
}

describe("install-user-kit", () => {
  it("installs a versioned copy, the launcher, state dirs and the extension, then is idempotent", () => {
    const k = kit();
    const first = k.install();
    expect(first.status).toBe(0);
    expect(first.out).toMatch(/changed: installed kit version [0-9a-f]{12}/);
    expect(first.out).toMatch(/changed: launcher .*\/\.local\/bin\/codex-bridge/);
    expect(first.out).toMatch(/changed: Antigravity extension local\.codex-bridge/);

    const share = join(k.home, ".local", "share", "codex-bridge");
    expect(readlinkSync(join(share, "current"))).toMatch(/^versions\/[0-9a-f]{12}$/);
    expect(existsSync(join(share, "current", "codex.mjs"))).toBe(true);
    expect(existsSync(join(share, "current", "antigravity-extension", "bridge-core.js"))).toBe(
      true,
    );
    for (const d of ["requests", "claimed", "windows"]) {
      expect(existsSync(join(k.home, ".local", "state", "codex-bridge", d))).toBe(true);
    }
    const listing = readFileSync(join(k.bin, "vsix-listing.txt"), "utf8");
    expect(listing).toContain("extension/package.json");
    expect(listing).toContain("extension/extension.js");
    expect(listing).toContain("extension/bridge-core.js");
    expect(listing).toContain("extension.vsixmanifest");

    const second = k.install();
    expect(second.status).toBe(0);
    expect(second.out).not.toMatch(/^changed:/m);
    expect(second.out).toMatch(/^0 changes$/m);
    expect(k.agCalls().filter((c) => c[0] === "--install-extension")).toHaveLength(1);
  });

  it("the launcher runs the wrapper from any directory", () => {
    const k = kit();
    expect(k.install().status).toBe(0);
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "ccc-kit-cwd-")));
    cleanups.push(() => rmSync(elsewhere, { recursive: true, force: true }));
    const r = spawnSync(join(k.home, ".local", "bin", "codex-bridge"), ["usage"], {
      cwd: elsewhere,
      encoding: "utf8",
      env: k.env(),
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ status: "ok", usedPercent: 7 });
  });

  it("skips the extension, without failing, when Antigravity is not installed", () => {
    const k = kit();
    rmSync(join(k.bin, "antigravity-ide"));
    const r = k.install();
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/Antigravity IDE not found; extension skipped/);
  });

  it("--dry-run changes nothing", () => {
    const k = kit();
    const r = k.install(["--dry-run"]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/would change: launcher/);
    expect(existsSync(join(k.home, ".local"))).toBe(false);
    expect(k.agCalls().filter((c) => c[0] === "--install-extension")).toHaveLength(0);
  });

  it("never touches Claude config without --claude-config", () => {
    const k = kit();
    k.install();
    expect(existsSync(join(k.home, ".claude"))).toBe(false);
  });

  it("--claude-config merges the permission entries and writes the rule, once", () => {
    const k = kit();
    mkdirSync(join(k.home, ".claude"), { recursive: true });
    writeFileSync(
      join(k.home, ".claude", "settings.json"),
      JSON.stringify({ model: "opus", permissions: { allow: ["Read(x)"], defaultMode: "auto" } }),
    );
    const r = k.install(["--claude-config"]);
    expect(r.status).toBe(0);
    const settings = JSON.parse(readFileSync(join(k.home, ".claude", "settings.json"), "utf8"));
    expect(settings).toMatchObject({
      model: "opus",
      permissions: {
        allow: ["Read(x)", "Bash(codex-bridge:*)"],
        deny: ["Bash(codex:*)"],
        defaultMode: "auto",
      },
    });
    expect(existsSync(join(k.home, ".claude", "settings.json.codex-bridge.bak"))).toBe(true);
    expect(readFileSync(join(k.home, ".claude", "rules", "codex.md"), "utf8")).toMatch(
      /only through `codex-bridge`/,
    );
    const again = k.install(["--claude-config"]);
    expect(again.out).toMatch(/^0 changes$/m);
  });
});
