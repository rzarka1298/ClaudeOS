// Test support for the Codex hooks installer tests (plan 05.1-24): runs a
// script under a preload that records every path the script opens for writing
// or reading through the public `node:fs` functions. The audits use it to
// prove the installer writes only the hooks file, its backups, its temp file
// and the installed runtime subtree, and that status reads nothing else.
// Public-API recording only: it is an audit aid, not a sandbox.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const RECORDER_SOURCE = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";
const logPath = process.env.CCC_FS_LOG;
const append = fs.appendFileSync.bind(fs);
const abs = (p) => {
  if (typeof p === "string") return resolve(p);
  if (p instanceof URL) return p.pathname;
  if (Buffer.isBuffer(p)) return resolve(p.toString());
  return undefined;
};
let busy = false;
const log = (kind, op, ...paths) => {
  if (busy) return;
  busy = true;
  try {
    for (const p of paths) {
      const path = abs(p);
      if (path !== undefined) append(logPath, JSON.stringify({ kind, op, path }) + "\\n");
    }
  } finally {
    busy = false;
  }
};
const C = fs.constants;
const originalWrite = fs.writeFileSync;
const raceTarget = process.env.CCC_FS_RACE_TARGET;
const failOp = process.env.CCC_FS_FAIL_OP;
const failMatch = process.env.CCC_FS_FAIL_MATCH ?? "";
let failed = false;
let raced = false;
const isWriteFlag = (flags) => {
  if (flags === undefined) return false;
  if (typeof flags === "string") return !/^rs?$/.test(flags);
  return (flags & (C.O_WRONLY | C.O_RDWR | C.O_CREAT | C.O_TRUNC | C.O_APPEND)) !== 0;
};
const wrap = (name, pick) => {
  const original = fs[name];
  if (typeof original !== "function") return;
  fs[name] = function (...args) {
    if (failOp === name && !failed && !busy) {
      const first = abs(args[0]) ?? "";
      if (failMatch === "" || first.includes(failMatch)) {
        failed = true;
        throw Object.assign(new Error("EIO: injected fault for the audit"), { code: "EIO" });
      }
    }
    for (const [kind, ...paths] of pick(args)) log(kind, name, ...paths);
    return original.apply(this, args);
  };
};
wrap("fsyncSync", () => []);
wrap("writeFileSync", (a) => [["write", a[0]]]);
wrap("appendFileSync", (a) => [["write", a[0]]]);
wrap("copyFileSync", (a) => {
  if (raceTarget !== undefined && !raced) {
    raced = true;
    originalWrite(raceTarget, process.env.CCC_FS_RACE_TEXT ?? "");
  }
  return [["read", a[0]], ["write", a[1]]];
});
wrap("renameSync", (a) => [["write", a[0]], ["write", a[1]]]);
wrap("rmSync", (a) => [["write", a[0]]]);
wrap("rmdirSync", (a) => [["write", a[0]]]);
wrap("unlinkSync", (a) => [["write", a[0]]]);
wrap("mkdirSync", (a) => [["write", a[0]]]);
wrap("chmodSync", (a) => [["write", a[0]]]);
wrap("chownSync", (a) => [["write", a[0]]]);
wrap("truncateSync", (a) => [["write", a[0]]]);
wrap("utimesSync", (a) => [["write", a[0]]]);
wrap("symlinkSync", (a) => [["write", a[1]]]);
wrap("linkSync", (a) => [["write", a[1]]]);
wrap("mkdtempSync", (a) => [["write", a[0]]]);
wrap("openSync", (a) => [[isWriteFlag(a[1]) ? "write" : "read", a[0]]]);
wrap("readFileSync", (a) => [["read", a[0]]]);
wrap("readdirSync", (a) => [["read", a[0]]]);
wrap("statSync", (a) => [["read", a[0]]]);
wrap("lstatSync", (a) => [["read", a[0]]]);
wrap("existsSync", (a) => [["read", a[0]]]);
wrap("accessSync", (a) => [["read", a[0]]]);
wrap("realpathSync", (a) => [["read", a[0]]]);
wrap("readlinkSync", (a) => [["read", a[0]]]);
wrap("opendirSync", (a) => [["read", a[0]]]);
syncBuiltinESMExports();
`;

export interface RecordedRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Every distinct path opened for writing, renamed to or from, created or removed. */
  readonly writes: string[];
  /** Every distinct path read, listed, statted or checked. */
  readonly reads: string[];
}

export interface RecordOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly repoRoot: string;
  /** Throw an EIO error once, from the first call to `op` whose first path contains `match` (every call when empty). */
  readonly fail?: { readonly op: string; readonly match?: string };
  /** Before the first file copy, replace this file's bytes with `raceText` (a concurrent-edit simulation). */
  readonly race?: { readonly target: string; readonly text: string };
}

const recorderDirs: string[] = [];

/** Removes every recorder directory created so far; call from afterEach. */
export function cleanupRecorderDirs(): void {
  for (const dir of recorderDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/**
 * Runs `node --import <recorder> <script> <args>` and returns the result with
 * the recorded paths. Paths inside the repository, the Node install and the
 * recorder's own files are noise and are dropped.
 */
export function runRecorded(
  script: string,
  args: readonly string[],
  options: RecordOptions,
): RecordedRun {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "cchr-"));
  recorderDirs.push(dir);
  const recorder = join(dir, "recorder.mjs");
  const logPath = join(dir, "fs.log");
  writeFileSync(recorder, RECORDER_SOURCE);
  writeFileSync(logPath, "");
  const env: NodeJS.ProcessEnv = { ...options.env, CCC_FS_LOG: logPath };
  if (options.race !== undefined) {
    env.CCC_FS_RACE_TARGET = options.race.target;
    env.CCC_FS_RACE_TEXT = options.race.text;
  }
  if (options.fail !== undefined) {
    env.CCC_FS_FAIL_OP = options.fail.op;
    env.CCC_FS_FAIL_MATCH = options.fail.match ?? "";
  }
  const spawned = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(recorder).href, script, ...args],
    { cwd: options.repoRoot, env, encoding: "utf8" },
  );
  const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
  const noise = (path: string) =>
    path.startsWith(`${options.repoRoot}/`) ||
    path.startsWith(`${nodeRoot}/`) ||
    path === logPath ||
    path === recorder;
  const entries = readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { kind: string; op: string; path: string })
    .filter((entry) => !noise(entry.path));
  const unique = (kind: string) => [
    ...new Set(entries.filter((entry) => entry.kind === kind).map((entry) => entry.path)),
  ];
  return {
    status: spawned.status,
    stdout: spawned.stdout,
    stderr: spawned.stderr,
    writes: unique("write"),
    reads: unique("read"),
  };
}
