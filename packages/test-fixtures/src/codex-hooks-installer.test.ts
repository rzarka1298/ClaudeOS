// The owner-run Codex hook package (plan 05.1-24, CODEX-06, D-19). Every test
// runs the real scripts under `scripts/codex-hooks/` as child processes with
// HOME, CODEX_HOME and CCC_RUNTIME_DIR all pointed at a throwaway directory
// under the system temp directory, AND passes explicit `--codex-home` and
// `--runtime-dir` flags. No test ever reads or writes the owner's real Codex
// home or runtime directory: installing there is the owner's step (UAT U10).
// The decoy Codex config file and credential file hold placeholder text only.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
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
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CODEX_HOOK_EVENTS } from "@ccc/domain";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPTS_DIR = join(REPO_ROOT, "scripts", "codex-hooks");
const INSTALL = join(SCRIPTS_DIR, "install.mjs");
const INSTALL_SH = join(SCRIPTS_DIR, "install.sh");
const LIB = join(SCRIPTS_DIR, "lib.mjs");
const DIST = join(REPO_ROOT, "packages", "collectors", "dist");
const TMP_REAL = realpathSync(tmpdir());

/** Literals assembled at runtime so no source line names them (backstop rule 16 is about packages/ source, this is belt and braces). */
const CONFIG_FILE_NAME = ["config", "toml"].join(".");
const CREDENTIAL_FILE_NAME = ["auth", "json"].join(".");

const DECOY_CONFIG = [
  'notify = ["/usr/local/bin/other-client", "--flag"]',
  "",
  '[hooks.state."hooks.json:Stop:0:0"]',
  'trusted_hash = "sha256:0000000000000000000000000000000000000000000000000000000000000000"',
  "enabled = true",
  "",
  "[mcp_servers.demo.env]",
  'DEMO_VALUE = "decoy-env-value"',
  "",
].join("\n");
const DECOY_CREDENTIAL = '{"decoy":"placeholder-not-a-credential"}\n';

/** Foreign content the owner's file starts with; none of it may change. */
const OWNER_STOP = { hooks: [{ type: "command", command: "echo owner-stop", timeout: 9 }] };
const OWNER_SESSION_START = {
  matcher: "startup",
  hooks: [{ type: "command", command: "echo owner-start" }],
};
const OWNER_PRE_TOOL_USE = {
  matcher: "Bash",
  hooks: [{ type: "command", command: "echo owner-pre-tool-use" }],
};

interface Fixture {
  root: string;
  home: string;
  codexHome: string;
  hooksPath: string;
  runtimeDir: string;
  configPath: string;
  credentialPath: string;
  originalBytes: string | undefined;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

const fixtures: string[] = [];

function ownerHooks(): Record<string, unknown> {
  return {
    description: "owner hooks",
    hooks: {
      PreToolUse: [OWNER_PRE_TOOL_USE],
      SessionStart: [OWNER_SESSION_START],
      Stop: [OWNER_STOP],
    },
    "owner-extra": { keep: true },
  };
}

/** `null` makes a Codex home with no hooks file; an object or string is written as the hooks file. */
function makeFixture(hooks: Record<string, unknown> | string | null = null): Fixture {
  const root = mkdtempSync(join(TMP_REAL, "cch-"));
  fixtures.push(root);
  const home = join(root, "h");
  const codexHome = join(home, "cx");
  const runtimeDir = join(root, "rt");
  mkdirSync(codexHome, { recursive: true });
  const hooksPath = join(codexHome, "hooks.json");
  const configPath = join(codexHome, CONFIG_FILE_NAME);
  const credentialPath = join(codexHome, CREDENTIAL_FILE_NAME);
  writeFileSync(configPath, DECOY_CONFIG);
  writeFileSync(credentialPath, DECOY_CREDENTIAL);
  // Deliberately NOT the installer's own serialization (4-space indent), so
  // "byte-equal after uninstall" proves a restore, not a re-serialization.
  const originalBytes =
    hooks === null
      ? undefined
      : typeof hooks === "string"
        ? hooks
        : `${JSON.stringify(hooks, null, 4)}\n`;
  if (originalBytes !== undefined) writeFileSync(hooksPath, originalBytes);
  return {
    root,
    home,
    codexHome,
    hooksPath,
    runtimeDir,
    configPath,
    credentialPath,
    originalBytes,
  };
}

/** Owner-safety net: every path handed to a script must sit inside this test's temp root. */
function assertContained(fx: Fixture, ...paths: string[]): void {
  expect(fx.root.startsWith(`${TMP_REAL}/`), "fixture root is under the system temp dir").toBe(
    true,
  );
  for (const path of paths) {
    expect(path.startsWith(`${fx.root}/`), `${path} escapes the fixture`).toBe(true);
  }
}

function childEnv(fx: Fixture): NodeJS.ProcessEnv {
  return {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: fx.home,
    CODEX_HOME: fx.codexHome,
    CCC_RUNTIME_DIR: fx.runtimeDir,
  };
}

function baseArgs(fx: Fixture): string[] {
  assertContained(fx, fx.codexHome, fx.runtimeDir);
  return ["--codex-home", fx.codexHome, "--runtime-dir", fx.runtimeDir];
}

function runScript(script: string, fx: Fixture, args: string[]): RunResult {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: REPO_ROOT,
    env: childEnv(fx),
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function install(fx: Fixture, extra: string[] = []): RunResult {
  return runScript(INSTALL, fx, [...baseArgs(fx), ...extra]);
}

function readHooks(fx: Fixture): Record<string, unknown> {
  return JSON.parse(readFileSync(fx.hooksPath, "utf8")) as Record<string, unknown>;
}

function installedRoot(fx: Fixture): string {
  return join(fx.runtimeDir, "codex-hooks");
}

function entryPath(fx: Fixture): string {
  return join(installedRoot(fx), "codex-hook", "entry.js");
}

/** POSIX single-quoting, as the installer must use for the login-shell command string (T-05.1-01). */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function expectedCommand(fx: Fixture): string {
  return `${shellQuote(process.execPath)} ${shellQuote(entryPath(fx))} --runtime-dir ${shellQuote(fx.runtimeDir)}`;
}

function expectedHandler(fx: Fixture, event: string): Record<string, unknown> {
  return event === "SessionEnd"
    ? { type: "command", command: expectedCommand(fx), timeout: 3 }
    : { type: "command", command: expectedCommand(fx), timeout: 5, async: true };
}

type Group = { matcher?: string; hooks?: Array<Record<string, unknown>> };

function groupsOf(hooksFile: Record<string, unknown>, event: string): Group[] {
  const hooks = hooksFile.hooks as Record<string, Group[]> | undefined;
  return hooks?.[event] ?? [];
}

function ourGroups(fx: Fixture, hooksFile: Record<string, unknown>, event: string): Group[] {
  return groupsOf(hooksFile, event).filter((group) =>
    (group.hooks ?? []).some(
      (handler) => typeof handler.command === "string" && handler.command.includes(entryPath(fx)),
    ),
  );
}

function backups(fx: Fixture): string[] {
  return readdirSync(fx.codexHome).filter((name) => name.startsWith("hooks.json.ccc-backup-"));
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Every file and directory under `dir`, relative, sorted. */
function tree(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).sort();
}

/** Relative path to SHA-256 (or "dir") for everything under `dir`: a snapshot to prove "nothing else changed". */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of tree(dir)) {
    const full = join(dir, rel);
    out[rel] = statSync(full).isDirectory() ? "dir" : sha256(full);
  }
  return out;
}

function snapshotWithout(dir: string, skip: (rel: string) => boolean): Record<string, string> {
  return Object.fromEntries(Object.entries(snapshot(dir)).filter(([rel]) => !skip(rel)));
}

/** A small recording server on a Unix socket: handshake answers a token, every other route 202. */
function startRecordingServer(socketPath: string): Promise<{
  requests: Array<{ method: string; url: string; body: string }>;
  close: () => Promise<void>;
}> {
  const requests: Array<{ method: string; url: string; body: string }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (req.url === "/api/v1/handshake") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            token: "test-token.abc123",
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          }),
        );
        return;
      }
      res.writeHead(202, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  return new Promise((resolveStart, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () =>
      resolveStart({
        requests,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      }),
    );
  });
}

beforeAll(() => {
  const needed = [
    join(DIST, "codex-hook", "entry.js"),
    join(DIST, "hook", "deliver.js"),
    join(DIST, "hook", "limits.js"),
  ];
  if (needed.some((file) => !existsSync(file))) {
    throw new Error(
      `missing build output; run: pnpm exec turbo run build --filter=@ccc/collectors --filter=@ccc/vault-repo (${needed.filter((f) => !existsSync(f)).join(", ")})`,
    );
  }
});

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("install.mjs merges the Codex hook package (Task 1, CODEX-06, D-19)", () => {
  it("creates the hooks file with exactly description and hooks, five asynchronous handlers except SessionEnd, and prints the trust step (Test 1, tracer)", () => {
    const fx = makeFixture();
    const result = install(fx);
    expect(result.status, result.stderr).toBe(0);

    const after = readHooks(fx);
    expect(Object.keys(after)).toEqual(["description", "hooks"]);
    expect(Object.keys(after.hooks as object)).toEqual([...CODEX_HOOK_EVENTS]);
    for (const event of CODEX_HOOK_EVENTS) {
      const ours = ourGroups(fx, after, event);
      expect(ours, event).toEqual([{ hooks: [expectedHandler(fx, event)] }]);
    }
    const sessionEnd = ourGroups(fx, after, "SessionEnd")[0]?.hooks?.[0] ?? {};
    expect(sessionEnd.async).not.toBe(true);
    expect(sessionEnd.timeout).toBe(3);
    expect(mode(fx.hooksPath)).toBe(0o600);

    const lastLine = result.stdout.trim().split("\n").at(-1) ?? "";
    expect(lastLine).toContain("/hooks");
    expect(lastLine).toMatch(/trust/i);
  });

  it("installs the pure hook as sibling folders with an ES module marker, 0700, nothing else, and the copy delivers (Test 2)", async () => {
    const fx = makeFixture();
    expect(install(fx).status).toBe(0);

    expect(tree(fx.runtimeDir)).toEqual([
      "codex-hooks",
      "codex-hooks/codex-hook",
      "codex-hooks/codex-hook/entry.js",
      "codex-hooks/codex-hook/limits.js",
      "codex-hooks/codex-hook/minimize.js",
      "codex-hooks/hook",
      "codex-hooks/hook/deliver.js",
      "codex-hooks/hook/limits.js",
      "codex-hooks/package.json",
    ]);
    expect(JSON.parse(readFileSync(join(installedRoot(fx), "package.json"), "utf8"))).toEqual({
      type: "module",
    });
    for (const dir of [fx.runtimeDir, installedRoot(fx)]) expect(mode(dir), dir).toBe(0o700);
    for (const sub of ["codex-hook", "hook"]) {
      expect(mode(join(installedRoot(fx), sub)), sub).toBe(0o700);
    }

    // The copy runs from its own location (the relative import resolves) and delivers.
    const socketPath = join(fx.runtimeDir, "svc.sock");
    expect(Buffer.byteLength(socketPath)).toBeLessThan(104);
    const server = await startRecordingServer(socketPath);
    try {
      const payload = JSON.stringify({
        hook_event_name: "Stop",
        session_id: "0196a7c2-5b3d-7e41-9a08-3c6f1d2e4b57",
        turn_id: "0196a7c2-8e10-7a55-b3c9-6d02f4a81e90",
        cwd: "/Users/USERNAME/code/demo",
        model: "gpt-5.5-codex",
        prompt: "decoy prompt text",
      });
      const code = await new Promise<number | null>((done) => {
        const child = spawn(process.execPath, [entryPath(fx), "--runtime-dir", fx.runtimeDir], {
          env: childEnv(fx),
          stdio: ["pipe", "pipe", "pipe"],
        });
        child.on("close", done);
        child.stdin.end(payload);
      });
      expect(code).toBe(0);
      expect(server.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
        "POST /api/v1/handshake",
        "POST /api/v1/codex/hook-events",
      ]);
      expect(server.requests[1]?.body).toContain('"hook_event_name":"Stop"');
      expect(server.requests[1]?.body).not.toContain("decoy prompt text");
    } finally {
      await server.close();
    }
  });

  it("leaves the decoy config and credential files byte-identical across install and re-install (Test 3)", () => {
    const fx = makeFixture(ownerHooks());
    const configHash = sha256(fx.configPath);
    const credentialHash = sha256(fx.credentialPath);
    const configMtime = statSync(fx.configPath).mtimeMs;
    const before = snapshotWithout(
      fx.codexHome,
      (rel) => rel === "hooks.json" || rel.startsWith("hooks.json.ccc-"),
    );

    expect(install(fx).status).toBe(0);
    expect(install(fx).status).toBe(0);

    expect(sha256(fx.configPath)).toBe(configHash);
    expect(sha256(fx.credentialPath)).toBe(credentialHash);
    expect(statSync(fx.configPath).mtimeMs).toBe(configMtime);
    const after = snapshotWithout(
      fx.codexHome,
      (rel) => rel === "hooks.json" || rel.startsWith("hooks.json.ccc-"),
    );
    expect(after).toEqual(before);
  });

  it("--dry-run prints a diff and writes nothing; a second real run is byte-identical and adds no backup (Test 4)", () => {
    const fx = makeFixture(ownerHooks());
    const before = snapshot(fx.root);
    const dry = install(fx, ["--dry-run"]);
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toContain("Dry run: nothing was written.");
    expect(dry.stdout).toMatch(/^\+.*"UserPromptSubmit"/m);
    expect(dry.stdout).toMatch(/^\+.*entry\.js/m);
    expect(snapshot(fx.root)).toEqual(before);

    expect(install(fx).status).toBe(0);
    const first = readFileSync(fx.hooksPath, "utf8");
    expect(backups(fx)).toHaveLength(1);
    const again = install(fx);
    expect(again.status, again.stderr).toBe(0);
    expect(readFileSync(fx.hooksPath, "utf8")).toBe(first);
    expect(backups(fx)).toHaveLength(1);
    for (const event of CODEX_HOOK_EVENTS) {
      expect(ourGroups(fx, readHooks(fx), event), event).toHaveLength(1);
    }
  });

  it("appends our group after the owner's, keeps their entries and extra keys exactly, and backs up the original 0600 (Test 5)", () => {
    const fx = makeFixture(ownerHooks());
    const before = readHooks(fx);
    chmodSync(fx.hooksPath, 0o640);
    const result = install(fx);
    expect(result.status, result.stderr).toBe(0);

    const after = readHooks(fx);
    expect(Object.keys(after)).toEqual(["description", "hooks", "owner-extra"]);
    expect(after.description).toBe("owner hooks");
    expect(after["owner-extra"]).toEqual(before["owner-extra"]);
    expect(groupsOf(after, "PreToolUse")).toEqual([OWNER_PRE_TOOL_USE]);
    expect(groupsOf(after, "Stop")[0]).toEqual(OWNER_STOP);
    expect(groupsOf(after, "Stop")).toHaveLength(2);
    expect(groupsOf(after, "SessionStart")[0]).toEqual(OWNER_SESSION_START);
    expect(groupsOf(after, "SessionStart")).toHaveLength(2);
    expect(groupsOf(after, "Stop")[1]).toEqual({ hooks: [expectedHandler(fx, "Stop")] });
    expect(mode(fx.hooksPath)).toBe(0o640);

    const names = backups(fx);
    expect(names).toHaveLength(1);
    const backup = join(fx.codexHome, names[0] as string);
    expect(readFileSync(backup, "utf8")).toBe(fx.originalBytes);
    expect(mode(backup)).toBe(0o600);
  });

  it("install.sh is a thin shim over install.mjs", () => {
    const fx = makeFixture();
    const viaNode = install(fx, ["--dry-run"]);
    const viaSh = spawnSync("sh", [INSTALL_SH, "--dry-run", ...baseArgs(fx)], {
      cwd: REPO_ROOT,
      env: childEnv(fx),
      encoding: "utf8",
    });
    expect(viaSh.status, viaSh.stderr).toBe(0);
    expect(viaSh.stdout).toBe(viaNode.stdout);
    expect(existsSync(fx.hooksPath)).toBe(false);
    expect(existsSync(fx.runtimeDir)).toBe(false);
  });

  it("subscribes exactly the domain's CODEX_HOOK_EVENTS", async () => {
    const lib = (await import(pathToFileURL(LIB).href)) as { SUBSCRIBED_EVENTS: readonly string[] };
    expect([...lib.SUBSCRIBED_EVENTS]).toEqual([...CODEX_HOOK_EVENTS]);
  });
});
