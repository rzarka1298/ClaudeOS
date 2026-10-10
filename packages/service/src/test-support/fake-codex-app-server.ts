import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A contract-test fake of `codex app-server` (plan 05.1-15, RESEARCH R2).
 *
 * `writeFakeAppServer(dir, scenario)` writes an executable Node script whose
 * scenario and log path are BAKED into the script text. They are never read
 * from the environment: the product starts the real child with a minimal
 * environment, so a fake that read its scenario from environment variables
 * would silently run its default branch and the tests would pass for the wrong
 * reason (RESEARCH Pitfall 5). The shebang is the absolute path of the running
 * Node binary, because the child's PATH holds no `node`.
 *
 * The fake speaks newline-delimited JSON-RPC on stdin and stdout and appends to
 * its log file: one `start` entry (argv, environment key NAMES only, working
 * directory, pid; macOS adds `__CF_USER_TEXT_ENCODING` to every exec'd process
 * itself, so that one name is left out of the record) and one `line` entry per received line. Tests assert on the
 * log, so a stray message is caught from the receiving side.
 *
 * Nothing here ever starts the real `codex`.
 */

/** What the fake answers to the `account/rateLimits/read` request. */
export type FakeReadBehavior =
  | { readonly kind: "result"; readonly result: unknown }
  | { readonly kind: "error" }
  | { readonly kind: "hang" }
  /** Exits non-zero straight after answering the initialize request. */
  | { readonly kind: "crash-after-initialize" }
  /** One complete line of this many bytes, then nothing. */
  | { readonly kind: "oversized-line"; readonly bytes: number }
  /** Bytes without a newline, until the client kills the process. */
  | { readonly kind: "endless" };

export interface FakeAppServerScenario {
  readonly read: FakeReadBehavior;
  /** Exits non-zero at once, with no output, before the initialize request. */
  readonly crashOnStart?: boolean;
  /** Answers the initialize request with an error. */
  readonly initializeError?: boolean;
  /** Writes a non-JSON banner line before anything else. */
  readonly banner?: boolean;
  /** Sends a rate-limits-updated notification (carrying the decoy) before the reply. */
  readonly notificationBeforeReply?: boolean;
  /** Sends replies for unrelated ids before and after the real one. */
  readonly outOfOrderIds?: boolean;
  /** Repeats the reply with a different result, which the client must ignore. */
  readonly duplicateReply?: boolean;
  /** Ignores the default termination signal and closed stdin; only the escalation ends it. */
  readonly ignoreTermination?: boolean;
  /** Writes a decoy-bearing line to stderr (the client ignores stderr). */
  readonly stderrNoise?: boolean;
}

/** One entry the fake wrote to its log. */
export type FakeLogEntry =
  | {
      readonly t: "start";
      readonly argv: readonly string[];
      readonly envKeys: readonly string[];
      readonly cwd: string;
      readonly pid: number;
    }
  | { readonly t: "line"; readonly line: string };

export interface FakeAppServer {
  /** Absolute path of the executable script. */
  readonly path: string;
  /** Absolute path of the log the script appends to. */
  readonly logPath: string;
}

/** An obviously fake account identifier planted in every reply (CODEX-09). */
export const FAKE_ACCOUNT_ID = "acct-decoy-7f3a9c41";

/** The reset time every weekly window in the fakes carries (epoch seconds). */
export const FAKE_RESETS_AT_S = 1_790_000_000;

/** A reply carrying one weekly window at `usedPercent` and the decoy account id. */
export function weeklyReply(
  usedPercent: unknown,
  over: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent, windowDurationMins: 10_080, resetsAt: FAKE_RESETS_AT_S },
      secondary: null,
      planType: "prolite",
      rateLimitReachedType: null,
    },
    ordinaryUsageAllowed: true,
    accountId: FAKE_ACCOUNT_ID,
    rateLimitsByLimitId: null,
    ...over,
  };
}

let counter = 0;

/** The script body (no shebang). The two `JSON` literals are the baked scenario and log path. */
export function scriptSource(scenario: FakeAppServerScenario, logPath: string): string {
  return `
"use strict";
const fs = require("node:fs");
const S = ${JSON.stringify(scenario)};
const LOG = ${JSON.stringify(logPath)};
function log(entry) { fs.appendFileSync(LOG, JSON.stringify(entry) + "\\n"); }
log({ t: "start", argv: process.argv.slice(2), envKeys: Object.keys(process.env).filter((k) => k !== "__CF_USER_TEXT_ENCODING").sort(), cwd: process.cwd(), pid: process.pid });
if (S.crashOnStart) process.exit(3);
if (S.ignoreTermination) {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
}
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
if (S.banner) process.stdout.write("Codex app-server (fake) ready, not json\\n");
if (S.stderrNoise) process.stderr.write("stderr noise ${FAKE_ACCOUNT_ID}\\n");
function answerRead() {
  const r = S.read;
  if (S.notificationBeforeReply) {
    send({ method: "account/rateLimits/updated", params: { accountId: ${JSON.stringify(FAKE_ACCOUNT_ID)}, rateLimits: { primary: { usedPercent: 3 } } } });
  }
  if (S.outOfOrderIds) send({ id: 3, result: { unrelated: true } });
  if (r.kind === "result") {
    send({ id: 2, result: r.result });
    if (S.duplicateReply) send({ id: 2, result: { rateLimits: { primary: { usedPercent: 99, windowDurationMins: 10080, resetsAt: null } } } });
  } else if (r.kind === "error") {
    send({ id: 2, error: { code: -32000, message: "read failed for ${FAKE_ACCOUNT_ID}" } });
  } else if (r.kind === "crash-after-initialize") {
    process.exit(4);
  } else if (r.kind === "oversized-line") {
    process.stdout.write("x".repeat(r.bytes) + "\\n");
  } else if (r.kind === "endless") {
    const chunk = "y".repeat(8192);
    const pump = () => { if (process.stdout.write(chunk)) setImmediate(pump); else process.stdout.once("drain", pump); };
    pump();
  }
  // "hang": no reply at all.
}
function handle(msg) {
  if (msg.id === 1 && msg.method === "initialize") {
    if (S.outOfOrderIds) send({ id: 2, result: { early: true } });
    if (S.initializeError) { send({ id: 1, error: { code: -32600, message: "no" } }); return; }
    send({ id: 1, result: { userAgent: "fake-codex/0.0.0", codexHome: "/Users/USERNAME/.codex" } });
    if (S.read.kind === "crash-after-initialize") process.exit(4);
    return;
  }
  if (msg.id === 2 && msg.method === "account/rateLimits/read") { answerRead(); return; }
}
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  for (let nl = buf.indexOf("\\n"); nl >= 0; nl = buf.indexOf("\\n")) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.trim() === "") continue;
    log({ t: "line", line });
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg && typeof msg === "object") handle(msg);
  }
});
process.stdin.on("end", () => { if (!S.ignoreTermination) process.exit(0); });
`;
}

/** Writes one executable fake app-server into `dir` and returns its paths. */
export function writeFakeAppServer(dir: string, scenario: FakeAppServerScenario): FakeAppServer {
  mkdirSync(dir, { recursive: true });
  counter += 1;
  const path = join(dir, `fake-codex-${process.pid}-${counter}`);
  const logPath = `${path}.log`;
  writeFileSync(logPath, "", { mode: 0o600 });
  writeFileSync(path, `#!${process.execPath}\n${scriptSource(scenario, logPath)}`, {
    mode: 0o700,
  });
  chmodSync(path, 0o700);
  return { path, logPath };
}

/** Every entry the fake logged so far (empty when it never started). */
export function readFakeLog(logPath: string): FakeLogEntry[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as FakeLogEntry);
}
