import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore } from "@ccc/operational-store";

/**
 * Support for the real-process Codex tests (plan 05.1-29): a fake Codex home on disk, the
 * simulated bridge state, the owner-run hook installer run into temporary directories and the
 * installed hook entry run as Codex runs it. Test support only; every path is a temporary
 * directory chosen by the caller, and nothing here names the owner's Codex home.
 *
 * The thread store is built through `@ccc/operational-store`'s `openStore` (the one package
 * allowed to hold the SQLite binding besides the service) and holds only the floor shape: the
 * migrations table and the eight required thread columns, synthetic rows.
 */

/** The PRD budget for a session change to reach a subscriber (and the default poll cadence's ceiling). */
export const ROLLOUT_BUDGET_MS = 10_000;
/** The budget for a hook-delivered event to reach a subscriber (UI-SPEC realtime). */
export const HOOK_BUDGET_MS = 2_000;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const INSTALL = join(REPO_ROOT, "scripts", "codex-hooks", "install.mjs");

const FLOOR_DDL = `
CREATE TABLE _sqlx_migrations (
  version BIGINT PRIMARY KEY, description TEXT, installed_on TEXT, success BOOLEAN,
  checksum BLOB, execution_time BIGINT
);
CREATE TABLE threads (
  id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, source TEXT, cli_version TEXT,
  archived INTEGER, updated_at_ms INTEGER, created_at_ms INTEGER
);`;

export interface CodexHomeOnDisk {
  /** The temporary Codex home (what `CCC_CODEX_HOME` points at). */
  readonly root: string;
  readonly threadId: string;
  readonly rolloutFile: string;
  readonly dbPath: string;
}

const HOUR = 3_600_000;

function metaLine(id: string, atMs: number): string {
  return JSON.stringify({
    type: "session_meta",
    timestamp: new Date(atMs).toISOString(),
    payload: {
      id,
      cwd: "/Users/USERNAME/repo",
      cli_version: "0.159.2",
      originator: "synthetic",
      source: "cli",
      timestamp: new Date(atMs).toISOString(),
    },
  });
}

function lifecycleLine(event: "task_started" | "task_complete", atMs: number): string {
  return JSON.stringify({
    type: "event_msg",
    timestamp: new Date(atMs).toISOString(),
    payload: { type: event, turn_id: "turn-1" },
  });
}

/** A Codex home with ONE completed thread (two hours old) and its rollout. */
export function createCodexHomeOnDisk(parent: string, nowMs: number): CodexHomeOnDisk {
  const root = join(parent, "codex-home");
  const threadId = "thread-realtime-aaaa";
  const day = new Date(nowMs - 2 * HOUR).toISOString().slice(0, 10).split("-");
  const folder = join(root, "sessions", ...day);
  mkdirSync(folder, { recursive: true });
  const rolloutFile = join(folder, `rollout-${threadId}.jsonl`);
  const endedAt = nowMs - 2 * HOUR;
  writeFileSync(
    rolloutFile,
    `${[
      metaLine(threadId, endedAt - 60_000),
      lifecycleLine("task_started", endedAt - 5000),
      lifecycleLine("task_complete", endedAt),
    ].join("\n")}\n`,
  );
  utimesSync(rolloutFile, endedAt / 1000, endedAt / 1000);
  const dbPath = join(root, "state_5.sqlite");
  const store = openStore(dbPath);
  try {
    store.db.exec(FLOOR_DDL);
    store.db
      .prepare(
        "INSERT INTO _sqlx_migrations (version, description, success) VALUES (1, 'synthetic', 1)",
      )
      .run();
    store.db
      .prepare(
        "INSERT INTO threads (id, rollout_path, cwd, source, cli_version, archived, updated_at_ms, created_at_ms) VALUES (?, ?, ?, 'cli', '0.159.2', 0, ?, ?)",
      )
      .run(threadId, rolloutFile, "/Users/USERNAME/repo", endedAt, endedAt - 60_000);
  } finally {
    store.close();
  }
  return { root, threadId, rolloutFile, dbPath };
}

/** Appends a started turn to the thread's rollout and moves its store row, as Codex does for a new turn. */
export function markThreadRunning(home: CodexHomeOnDisk, atMs: number): void {
  appendFileSync(home.rolloutFile, `${lifecycleLine("task_started", atMs)}\n`);
  const store = openStore(home.dbPath);
  try {
    store.db.prepare("UPDATE threads SET updated_at_ms = ? WHERE id = ?").run(atMs, home.threadId);
  } finally {
    store.close();
  }
}

/**
 * The simulated bridge state the service finds first: the three queue folders and the protocol
 * marker under `<xdgStateHome>/codex-bridge`, so the first state-directory candidate answers.
 */
export function writeBridgeState(xdgStateHome: string): void {
  const bridge = join(xdgStateHome, "codex-bridge");
  for (const name of ["requests", "claimed", "windows"]) {
    mkdirSync(join(bridge, name), { recursive: true });
  }
  writeFileSync(
    join(bridge, "protocol.json"),
    `${JSON.stringify({ protocol: 2, capabilities: ["follow", "tui", "agent"], kit: "test-kit" })}\n`,
  );
}

const CHILD_PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;

/** Runs the owner-run installer into a temporary Codex home and runtime directory; returns its exit status. */
export function installCodexHook(codexHome: string, runtimeDir: string): number | null {
  return spawnSync(
    process.execPath,
    [INSTALL, "--codex-home", codexHome, "--runtime-dir", runtimeDir],
    {
      cwd: REPO_ROOT,
      env: {
        PATH: CHILD_PATH,
        HOME: dirname(codexHome),
        CODEX_HOME: codexHome,
        CCC_RUNTIME_DIR: runtimeDir,
      },
      encoding: "utf8",
    },
  ).status;
}

/** Runs the INSTALLED hook entry as Codex runs it: the payload on stdin, the runtime directory as an argument. */
export async function runInstalledCodexHook(
  runtimeDir: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const entry = join(runtimeDir, "codex-hooks", "codex-hook", "entry.js");
  const child = spawn(process.execPath, [entry, "--runtime-dir", runtimeDir], {
    env: { PATH: CHILD_PATH, HOME: dirname(runtimeDir) },
    stdio: ["pipe", "ignore", "ignore"],
  });
  const closed = new Promise<void>((done) => child.once("close", () => done()));
  child.stdin.end(JSON.stringify(payload));
  await closed;
}

/** Names directly under `root` (files and folders), sorted. */
export function entryNames(root: string): string[] {
  return readdirSync(root).sort();
}

/** The last access time of a file, in milliseconds. */
export function accessTimeMs(path: string): number {
  return statSync(path).atimeMs;
}
