import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  type DiagnosticsHealthResponse,
  LAUNCHERS_SAVE_PATH,
  SNAPSHOT_PATH,
  VAULT_SETUP_PATH,
} from "@ccc/domain";
import { describe, expect, it } from "vitest";
import { authedRequest, handshake } from "./approval-int-support.js";
import {
  type DrillContext,
  findLeaks,
  logProblems,
  makeScratchDir,
  networkPreloadSource,
  pollHealth,
  readRecordedEvents,
  removeScratchDir,
  withDrillService,
} from "./diagnostics-drill-kit.js";

/**
 * Plan 08-12 Task 2 (SC2, D-05, D-09; DIAG-02, DIAG-03; T-08-30b): each deliberate break of one
 * subsystem produces its OWN specific, honest status in a REAL service process. Everything happens in
 * temporary folders: the run root (runtime folder, socket, scratch Claude config, Codex isolation
 * folders), a throwaway vault, a temporary executable. Nothing touches the owner's Keychain items,
 * Claude settings, Codex install or vault; the research key is a nonexistent `ccc-uat-` test account.
 *
 * The polls use the `reconnect` trigger wherever the research key does not matter, so those drills
 * never reach the Keychain at all. Where the 2 second result cache must expire the test polls until
 * the expected reason appears (never a long fixed sleep). Every drill ends by asserting that the
 * service made no non-loopback connection (W2): a test-only preload, written into the run root at
 * run time and passed through `NODE_OPTIONS=--require`, records them in a file in the run root.
 *
 * Plan 08-12 Task 3 (D-42, D-43; T-08-32) rides on the same drills: the drill kit scans every health
 * body and the service log at the end of EVERY drill for the run root, the vault path, the scratch
 * Claude config path, the home folder and any errno text, and fails the drill if it finds one.
 */

const DRILL_TIMEOUT_MS = 90_000;

type Row = DiagnosticsHealthResponse["rows"][number];
interface Part {
  readonly partId: string;
  readonly status: string;
  readonly reasonCode: string;
  readonly facts?: Record<string, unknown>;
}

function rowById(health: DiagnosticsHealthResponse, id: Row["id"]): Row {
  const row = health.rows.find((candidate) => candidate.id === id);
  if (row === undefined) throw new Error(`no ${id} row`);
  return row;
}

function partsOf(row: Row): readonly Part[] {
  return (row as unknown as { parts?: readonly Part[] }).parts ?? [];
}

function partOf(row: Row, partId: string): Part | undefined {
  return partsOf(row).find((part) => part.partId === partId);
}

/** A fake Codex in the run root: a script that records each run and prints a version. Never the machine's. */
function fakeCodexWorld(dir: string): void {
  const bin = join(dir, "fake-bin");
  mkdirSync(bin, { recursive: true });
  const log = join(dir, "fake-bin", "runs.log");
  writeFileSync(join(bin, "codex"), `#!/bin/sh\necho ran >> '${log}'\necho 'codex-cli 0.1.0'\n`);
  chmodSync(join(bin, "codex"), 0o755);
}

/** One dashboard snapshot, which starts the one-time Codex install detection. */
async function takeSnapshot(context: DrillContext): Promise<void> {
  const token = await handshake(context.socketPath);
  await authedRequest<unknown>(context.socketPath, token, { method: "GET", path: SNAPSHOT_PATH });
}

/** W2: nothing the service did left the machine. */
function expectOffline(context: DrillContext): void {
  expect(context.outbound()).toEqual([]);
}

describe("W2 positive control: the recorder records what it claims to and nothing else", () => {
  it("records a non-loopback connect, a non-loopback lookup and a spawn, and ignores loopback and a unix socket", () => {
    const dir = makeScratchDir("w2-");
    try {
      // A separate Node process loads the same preload source over no-op originals, so the calls
      // are recorded and no packet, lookup or process ever happens.
      const probeLog = join(dir, "control-record.ndjson");
      const preload = join(dir, "control-preload.cjs");
      writeFileSync(preload, networkPreloadSource(probeLog), { mode: 0o600 });
      const script = `
        const net = require("node:net");
        net.Socket.prototype.connect = function () { return this; };
        const dns = require("node:dns");
        dns.lookup = function () {};
        const cp = require("node:child_process");
        cp.spawn = function () { return {}; };
        require(${JSON.stringify(preload)});
        new net.Socket().connect({ host: "198.51.100.7", port: 443 });
        new net.Socket().connect({ host: "127.0.0.1", port: 80 });
        new net.Socket().connect({ path: "/tmp/control.sock" });
        new net.Socket().connect(8080, "localhost");
        dns.lookup("control.test", () => {});
        dns.lookup("localhost", () => {});
        cp.spawn("/usr/bin/control-tool", ["one", "two"]);
      `;
      execFileSync(process.execPath, ["-e", script], { stdio: "ignore" });
      expect(readRecordedEvents(probeLog)).toEqual([
        { kind: "connect", host: "198.51.100.7", port: 443 },
        { kind: "lookup", host: "control.test" },
        { kind: "spawn", fn: "spawn", file: "/usr/bin/control-tool", args: ["one", "two"] },
      ]);
    } finally {
      removeScratchDir(dir);
    }
  });
});

describe("Test 1 (vault): removing the vault folder reads vault-root-missing, restoring it reads vault-ready", () => {
  it(
    "the specific reason follows the break and the repair",
    async () => {
      await withDrillService(async (context) => {
        const vaultRoot = makeScratchDir("dv-");
        const away = `${vaultRoot}-away`;
        context.forbid(vaultRoot, "the vault path");
        context.forbid(away, "the moved vault path");
        try {
          mkdirSync(join(vaultRoot, ".obsidian"), { recursive: true });
          const token = await handshake(context.socketPath);
          const setup = await authedRequest<unknown>(context.socketPath, token, {
            method: "POST",
            path: VAULT_SETUP_PATH,
            body: { vaultRoot },
          });
          expect(setup.status).toBe(200);

          const ready = await pollHealth(
            context,
            (health) => rowById(health, "vault").reasonCode === "vault-ready",
            { trigger: "reconnect" },
          );
          expect(rowById(ready, "vault")).toMatchObject({ status: "ok" });

          renameSync(vaultRoot, away);
          const missing = await pollHealth(
            context,
            (health) => rowById(health, "vault").reasonCode === "vault-root-missing",
            { trigger: "reconnect" },
          );
          expect(rowById(missing, "vault")).toMatchObject({
            status: "failing",
            reasonCode: "vault-root-missing",
          });
          // The other four rows are untouched by the vault break.
          expect(rowById(missing, "hooks").reasonCode).toBe("hooks-not-installed");

          renameSync(away, vaultRoot);
          const repaired = await pollHealth(
            context,
            (health) => rowById(health, "vault").reasonCode === "vault-ready",
            { trigger: "reconnect" },
          );
          expect(rowById(repaired, "vault")).toMatchObject({ status: "ok" });
        } finally {
          if (existsSync(away) && !existsSync(vaultRoot)) renameSync(away, vaultRoot);
          removeScratchDir(vaultRoot);
          removeScratchDir(away);
        }
        expectOffline(context);
      });
    },
    DRILL_TIMEOUT_MS,
  );
});

describe("Test 2 (hooks): the scratch Claude settings drive the hooks row without waiting for the 60 second refresh", () => {
  it(
    "installed with no events, then disableAllHooks, then a missing hook runtime, each its own reason",
    async () => {
      await withDrillService(async (context) => {
        const settingsPath = join(context.claudeDir, "settings.json");
        const hooksDir = join(context.runtimeDir, "hooks");
        mkdirSync(hooksDir, { recursive: true });
        const settings = (extra: Record<string, unknown> = {}): string =>
          JSON.stringify({
            hooks: {
              SessionStart: [
                {
                  hooks: [
                    {
                      type: "command",
                      command: process.execPath,
                      args: [join(hooksDir, "handler.js"), "SessionStart"],
                    },
                  ],
                },
              ],
            },
            ...extra,
          });
        const record = (nodePath: string): string => JSON.stringify({ nodePath });

        // A scratch install record and a settings file that names our handler.
        writeFileSync(join(hooksDir, "install.json"), record(process.execPath));
        writeFileSync(settingsPath, settings());
        const installed = await pollHealth(
          context,
          (health) => rowById(health, "hooks").reasonCode === "no-events-yet",
          { trigger: "reconnect" },
        );
        expect(rowById(installed, "hooks")).toMatchObject({ status: "unknown" });

        writeFileSync(settingsPath, settings({ disableAllHooks: true }));
        const disabled = await pollHealth(
          context,
          (health) => rowById(health, "hooks").reasonCode === "hooks-disabled-in-claude",
          { trigger: "reconnect" },
        );
        expect(rowById(disabled, "hooks")).toMatchObject({ status: "degraded" });

        writeFileSync(settingsPath, settings());
        writeFileSync(join(hooksDir, "install.json"), record(join(context.dir, "missing-node")));
        const missing = await pollHealth(
          context,
          (health) => rowById(health, "hooks").reasonCode === "hook-runtime-missing",
          { trigger: "reconnect" },
        );
        expect(rowById(missing, "hooks")).toMatchObject({ status: "failing" });

        // Removing our entries returns the honest setup state, with the copy action.
        writeFileSync(settingsPath, JSON.stringify({}));
        const gone = await pollHealth(
          context,
          (health) => rowById(health, "hooks").reasonCode === "hooks-not-installed",
          { trigger: "reconnect" },
        );
        expect(rowById(gone, "hooks")).toMatchObject({
          status: "setup-needed",
          setupAction: { kind: "copy-command", command: "claude-hooks-install" },
        });
        expectOffline(context);
      });
    },
    DRILL_TIMEOUT_MS,
  );
});

describe("Test 3 (collectors): bytes in the dropped-records file read spool-dropped-records with a count", () => {
  it(
    "degraded with a positive count while the file is fresh, spool-clean with the same count once it is old",
    async () => {
      await withDrillService(async (context) => {
        const spoolDir = join(context.runtimeDir, "spool");
        const dropPath = join(spoolDir, "hooks.dropped");
        mkdirSync(spoolDir, { recursive: true });

        const clean = await context.health("reconnect");
        expect(partOf(rowById(clean, "collectors"), "spool")).toMatchObject({
          status: "ok",
          reasonCode: "spool-clean",
        });

        // One byte per dropped record (the hook writes it); three records dropped.
        appendFileSync(dropPath, "xxx");
        const dropped = await pollHealth(
          context,
          (health) =>
            partOf(rowById(health, "collectors"), "spool")?.reasonCode === "spool-dropped-records",
          { trigger: "reconnect" },
        );
        const spool = partOf(rowById(dropped, "collectors"), "spool");
        expect(spool).toMatchObject({ status: "degraded", reasonCode: "spool-dropped-records" });
        expect(spool?.facts?.dropCount).toBe(3);
        expect(rowById(dropped, "collectors")).toMatchObject({ status: "degraded" });

        // The drop is stateless (D-37a): a later check, whatever its trigger, still reads it.
        await new Promise((resolve) => setTimeout(resolve, 2200));
        const again = await context.health("reconnect");
        expect(partOf(rowById(again, "collectors"), "spool")).toMatchObject({
          reasonCode: "spool-dropped-records",
        });

        // A day-old file stops being news; the count stays a fact.
        const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
        utimesSync(dropPath, old, old);
        const aged = await pollHealth(
          context,
          (health) => partOf(rowById(health, "collectors"), "spool")?.reasonCode === "spool-clean",
          { trigger: "reconnect" },
        );
        const agedSpool = partOf(rowById(aged, "collectors"), "spool");
        expect(agedSpool).toMatchObject({ status: "ok", reasonCode: "spool-clean" });
        expect(agedSpool?.facts?.dropCount).toBe(3);
        expectOffline(context);
      });
    },
    DRILL_TIMEOUT_MS,
  );
});

describe("Test 4 (scheduler): a fresh service reads never-run and research-key-missing", () => {
  it(
    "the row is setup-needed, the key was checked on the gesture only and reads absent",
    async () => {
      await withDrillService(async (context) => {
        const before = await context.health("reconnect");
        expect(partOf(rowById(before, "scheduler"), "research-key")).toMatchObject({
          status: "unknown",
          reasonCode: "research-key-not-checked",
        });
        expect(context.researchKeySpawns()).toEqual([]);

        const fresh = await context.health("gesture");
        const scheduler = rowById(fresh, "scheduler");
        expect(scheduler).toMatchObject({ status: "setup-needed" });
        expect(partOf(scheduler, "last-run")).toMatchObject({
          status: "setup-needed",
          reasonCode: "never-run",
        });
        expect(partOf(scheduler, "research-key")).toMatchObject({
          status: "setup-needed",
          reasonCode: "research-key-missing",
          setupAction: { kind: "copy-command", command: "research-key-setup" },
        });
        expect(fresh.keychain.researchKey).toBe("absent");
        // Only the nonexistent test account was ever asked about.
        const asked = context.researchKeySpawns();
        expect(asked.length).toBeGreaterThanOrEqual(1);
        for (const event of asked) {
          if (event.kind !== "spawn") throw new Error("unexpected event");
          expect(event.args).toContain(context.researchAccount);
          expect(event.args).not.toContain("anthropic-api-key");
        }
        expectOffline(context);
      });
    },
    DRILL_TIMEOUT_MS,
  );
});

describe("Test 5 (launchers): a saved executable, then a missing one, and nothing is launched", () => {
  it(
    "launcher-untested after the save, executable-not-found after the executable is deleted",
    async () => {
      await withDrillService(async (context) => {
        const binDir = join(context.dir, "bin");
        const executable = join(binDir, "claude");
        mkdirSync(binDir, { recursive: true });
        writeFileSync(executable, "#!/bin/sh\nexit 0\n");
        chmodSync(executable, 0o755);
        try {
          const token = await handshake(context.socketPath);
          const saved = await authedRequest<unknown>(context.socketPath, token, {
            method: "POST",
            path: LAUNCHERS_SAVE_PATH,
            body: {
              launcherId: "claude-code",
              executable: { kind: "path", path: executable },
              args: [],
              terminal: { kind: "terminal-app" },
            },
          });
          expect(saved.status).toBe(200);

          const untested = await pollHealth(
            context,
            (health) =>
              partOf(rowById(health, "launchers"), "claude-code")?.reasonCode ===
              "launcher-untested",
            { trigger: "reconnect" },
          );
          expect(partOf(rowById(untested, "launchers"), "claude-code")).toMatchObject({
            status: "setup-needed",
            reasonCode: "launcher-untested",
          });
          expect(rowById(untested, "launchers")).toMatchObject({ status: "setup-needed" });

          rmSync(executable);
          const missing = await pollHealth(
            context,
            (health) =>
              partOf(rowById(health, "launchers"), "claude-code")?.reasonCode ===
              "executable-not-found",
            { trigger: "reconnect" },
          );
          expect(partOf(rowById(missing, "launchers"), "claude-code")).toMatchObject({
            status: "failing",
            reasonCode: "executable-not-found",
          });
          expect(rowById(missing, "launchers")).toMatchObject({ status: "failing" });
        } finally {
          rmSync(binDir, { recursive: true, force: true });
        }

        // Nothing was launched: no process was ever started with the saved executable.
        const launched = context
          .events()
          .filter(
            (event) =>
              event.kind === "spawn" &&
              (event.file === executable || event.args.includes(executable)),
          );
        expect(launched).toEqual([]);
        expectOffline(context);
      });
    },
    DRILL_TIMEOUT_MS,
  );
});

describe("Task 3 Test 1/2: the leak scanner is not vacuous", () => {
  const forbidden = new Map<string, string>([
    ["/run/root-example", "the run root"],
    ["/vault/example", "the vault path"],
    ["/claude/example", "the Claude config path"],
    ["/home/example", "the home folder"],
  ]);

  it("flags each forbidden path, each errno name and each errno phrase in a body, by label", () => {
    expect(findLeaks('{"a":"ok"}', forbidden)).toEqual([]);
    expect(findLeaks('{"p":"/run/root-example/x"}', forbidden)).toEqual(["the run root"]);
    expect(findLeaks('{"p":"/vault/example"}', forbidden)).toEqual(["the vault path"]);
    expect(findLeaks('{"p":"/claude/example/settings.json"}', forbidden)).toEqual([
      "the Claude config path",
    ]);
    expect(findLeaks('{"p":"/home/example"}', forbidden)).toEqual(["the home folder"]);
    for (const name of ["ENOENT", "EACCES", "ENOTDIR", "EPERM", "EISDIR"]) {
      expect(findLeaks(`{"reason":"${name}"}`, forbidden), name).toEqual(["an errno name"]);
    }
    for (const phrase of [
      "No such file or directory",
      "permission denied",
      "Not a directory",
      "Operation not permitted",
    ]) {
      expect(findLeaks(`{"reason":"${phrase}"}`, forbidden), phrase).toEqual(["an errno message"]);
    }
    // A closed reason code is not an errno.
    expect(findLeaks('{"reasonCode":"vault-root-unreadable"}', forbidden)).toEqual([]);
  });

  it("flags a leak in a log line, tolerates the Phase 1 listening line, and limits a diagnostics line to a code and an error class name", () => {
    const line = (fields: Record<string, unknown>): string =>
      `${JSON.stringify({ level: 40, time: 1, pid: 2, hostname: "h", ...fields })}\n`;
    expect(
      logProblems(line({ msg: "listening", socketPath: "/run/root-example/svc.sock" }), forbidden),
    ).toEqual([]);
    expect(logProblems(line({ msg: "x", path: "/run/root-example/x" }), forbidden)).toEqual([
      "a log line holds the run root",
    ]);
    expect(logProblems(line({ msg: "x", reason: "ENOENT" }), forbidden)).toEqual([
      "a log line holds an errno name",
    ]);
    const ok = line({
      msg: "diagnostics probe did not answer",
      subsystem: "launchers",
      code: "probe-error",
      errorName: "SyntaxError",
    });
    expect(logProblems(ok, forbidden)).toEqual([]);
    const extra = line({
      msg: "diagnostics probe did not answer",
      subsystem: "launchers",
      code: "probe-error",
      message: "harmless words",
    });
    expect(logProblems(extra, forbidden)).toEqual(["a diagnostics log line carries message"]);
    expect(logProblems("not json\n", forbidden)).toEqual(["a log line that is not JSON"]);
  });
});

describe("Task 3 Test 1/2: errno-bearing breaks read their own reasons and leak nothing", () => {
  it(
    "an unreadable, a read-only and a not-a-folder vault root; the modes are restored before the folder is removed",
    async () => {
      await withDrillService(async (context) => {
        const vaultRoot = makeScratchDir("dv-");
        context.forbid(vaultRoot, "the vault path");
        try {
          mkdirSync(join(vaultRoot, ".obsidian"), { recursive: true });
          const token = await handshake(context.socketPath);
          const setup = await authedRequest<unknown>(context.socketPath, token, {
            method: "POST",
            path: VAULT_SETUP_PATH,
            body: { vaultRoot },
          });
          expect(setup.status).toBe(200);
          await pollHealth(
            context,
            (health) => rowById(health, "vault").reasonCode === "vault-ready",
            { trigger: "reconnect" },
          );

          // Read-only: the owner can read and enter it but not write.
          chmodSync(vaultRoot, 0o500);
          const readOnly = await pollHealth(
            context,
            (health) => rowById(health, "vault").reasonCode === "vault-root-not-writable",
            { trigger: "reconnect" },
          );
          expect(rowById(readOnly, "vault")).toMatchObject({ status: "failing" });

          // Unreadable: no permission bits at all.
          chmodSync(vaultRoot, 0o000);
          const unreadable = await pollHealth(
            context,
            (health) => rowById(health, "vault").reasonCode === "vault-root-unreadable",
            { trigger: "reconnect" },
          );
          expect(rowById(unreadable, "vault")).toMatchObject({ status: "failing" });
        } finally {
          // Pitfall 7: a folder left at mode 000 cannot be cleaned up.
          chmodSync(vaultRoot, 0o755);
        }

        // Not a folder: the vault root replaced by a plain file.
        const moved = `${vaultRoot}-folder`;
        try {
          renameSync(vaultRoot, moved);
          writeFileSync(vaultRoot, "not a folder");
          const notFolder = await pollHealth(
            context,
            (health) => rowById(health, "vault").reasonCode === "vault-root-not-directory",
            { trigger: "reconnect" },
          );
          expect(rowById(notFolder, "vault")).toMatchObject({ status: "failing" });
        } finally {
          rmSync(vaultRoot, { force: true });
          removeScratchDir(moved);
          removeScratchDir(vaultRoot);
        }
        expectOffline(context);
        // The kit scans every body and the log for the paths and errno text when this callback returns.
      });
    },
    DRILL_TIMEOUT_MS,
  );
});

describe("Task 3 Test 3: the Codex isolation variables decide the Codex parts, not the machine", () => {
  const codexParts = (health: DiagnosticsHealthResponse): Record<string, string | undefined> => ({
    install: partOf(rowById(health, "collectors"), "codex-install")?.reasonCode,
    hooks: partOf(rowById(health, "collectors"), "codex-hooks")?.reasonCode,
    bridge: partOf(rowById(health, "collectors"), "codex-bridge")?.reasonCode,
  });

  it(
    "with the harness isolation (candidates disabled, empty Codex and bridge folders in the run root) a Codex that IS on a candidate path is not seen",
    async () => {
      await withDrillService(
        async (context) => {
          await takeSnapshot(context);
          await new Promise((resolve) => setTimeout(resolve, 1200));
          const health = await context.health("reconnect");
          expect(codexParts(health)).toEqual({
            install: "codex-not-installed",
            hooks: "codex-hooks-not-installed",
            bridge: "codex-bridge-not-installed",
          });
          // The candidate directory the service was NOT allowed to use holds a runnable fake Codex,
          // and it never ran: the variable, not the machine, decided.
          expect(existsSync(join(context.dir, "fake-bin", "runs.log"))).toBe(false);
          // The isolation folders the harness points the service at are inside the run root and empty.
          for (const name of ["codex-home-empty", "state-home-empty"]) {
            expect(existsSync(join(context.dir, name))).toBe(true);
          }
          expectOffline(context);
        },
        {
          prepare: fakeCodexWorld,
          env: (dir) => ({ CCC_CODEX_CANDIDATES_DIR: join(dir, "fake-bin") }),
        },
      );
    },
    DRILL_TIMEOUT_MS,
  );

  it(
    "pointing the same variables at the fake Codex makes the install part read codex-installed (the control)",
    async () => {
      await withDrillService(
        async (context) => {
          await takeSnapshot(context);
          const health = await pollHealth(
            context,
            (candidate) =>
              partOf(rowById(candidate, "collectors"), "codex-install")?.reasonCode ===
              "codex-installed",
            { trigger: "reconnect" },
          );
          expect(codexParts(health).install).toBe("codex-installed");
          // The fake ran: it is a script of ours in the run root that appends one line and prints a version.
          expect(existsSync(join(context.dir, "fake-bin", "runs.log"))).toBe(true);
          expectOffline(context);
        },
        {
          prepare: fakeCodexWorld,
          env: (dir) => ({
            CCC_CODEX_CANDIDATES_DISABLED: "0",
            CCC_CODEX_CANDIDATES_DIR: join(dir, "fake-bin"),
          }),
        },
      );
    },
    DRILL_TIMEOUT_MS,
  );
});
