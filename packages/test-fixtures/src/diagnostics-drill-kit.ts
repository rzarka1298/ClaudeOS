import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DIAGNOSTICS_HEALTH_PATH,
  type DiagnosticsHealthResponse,
  DiagnosticsHealthResponseSchema,
} from "@ccc/domain";
import { createAuthenticatedClient } from "@ccc/service-api-client";
import { setUpServiceEnvironment, tearDownServiceEnvironment } from "./approval-int-support.js";
import { startServiceForTest, type TestServiceHandle } from "./service-harness.js";
import { withTempSocketDir } from "./socket-fixture.js";

/**
 * Shared support for the real-process diagnostics tests (plan 08-12; D-05, D-09, D-42, D-43;
 * T-08-30b, T-08-31, T-08-32): a service started in its own temporary folder with a scratch
 * Claude config folder, the Codex isolation variables the harness sets, a throwaway install-secret
 * account (the established harness convention), a research-key test account that does not exist
 * (never created, never deleted), and a test-only preload that records every non-loopback
 * connection and every child process the service starts. Test support only.
 */

/** The live-UAT account prefix the research override guard demands (see `test-fixture-guard.ts`). */
const RESEARCH_TEST_ACCOUNT_PREFIX = "ccc-uat-";

/** A research-key Keychain account that does not exist and is never created. */
export function nonexistentResearchAccount(): string {
  return `${RESEARCH_TEST_ACCOUNT_PREFIX}diag-${randomBytes(6).toString("hex")}`;
}

/** One line the preload recorded. */
export type RecordedEvent =
  | { readonly kind: "connect"; readonly host: string; readonly port: number | null }
  | { readonly kind: "lookup"; readonly host: string }
  | { readonly kind: "spawn"; readonly fn: string; readonly file: string; readonly args: string[] };

/**
 * The preload source. It runs inside the service under test (`NODE_OPTIONS=--require`), before any
 * of the service's own modules, and appends one JSON line per event to `logPath`:
 *
 * - every `net.Socket#connect` whose target is not loopback (this is what `net.connect`,
 *   `tls.connect`, `http(s).request` and `fetch` all reach); a unix-socket path is local and is not
 *   recorded;
 * - every non-loopback `dns.lookup`;
 * - every child process started through `child_process` (file and the first arguments), so a test
 *   can count `security` spawns.
 *
 * It only observes: every call goes on to the original function.
 */
export function networkPreloadSource(logPath: string): string {
  return `"use strict";
const fs = require("node:fs");
const net = require("node:net");
const dns = require("node:dns");
const cp = require("node:child_process");
const LOG = ${JSON.stringify(logPath)};
function isLoopback(host) {
  return host === "localhost" || host === "::1" || host === "[::1]" || /^127\\./.test(host);
}
function record(event) {
  try { fs.appendFileSync(LOG, JSON.stringify(event) + "\\n"); } catch (e) { /* the test reads the file */ }
}
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  let host;
  let port = null;
  if (first !== null && typeof first === "object") {
    if (typeof first.path === "string") host = null;
    else { host = typeof first.host === "string" ? first.host : "localhost"; port = typeof first.port === "number" ? first.port : null; }
  } else if (typeof first === "number" || (typeof first === "string" && /^[0-9]+$/.test(first))) {
    host = typeof args[1] === "string" ? args[1] : "localhost"; port = Number(first);
  } else { host = null; }
  if (host !== null && !isLoopback(host)) record({ kind: "connect", host, port });
  return originalConnect.apply(this, args);
};
const originalLookup = dns.lookup;
dns.lookup = function (hostname, ...rest) {
  if (typeof hostname === "string" && !isLoopback(hostname)) record({ kind: "lookup", host: hostname });
  return originalLookup.call(this, hostname, ...rest);
};
for (const fn of ["spawn", "execFile", "exec", "fork", "spawnSync", "execFileSync", "execSync"]) {
  const original = cp[fn];
  if (typeof original !== "function") continue;
  const wrapped = function (file, ...rest) {
    const args = Array.isArray(rest[0]) ? rest[0].map(String).slice(0, 12) : [];
    record({ kind: "spawn", fn, file: String(file), args });
    return original.call(this, file, ...rest);
  };
  for (const key of Reflect.ownKeys(original)) {
    try { Object.defineProperty(wrapped, key, Object.getOwnPropertyDescriptor(original, key)); } catch (e) { /* non-configurable */ }
  }
  cp[fn] = wrapped;
}
`;
}

/** Parses the preload's log; a missing file is an empty log. */
export function readRecordedEvents(logPath: string): RecordedEvent[] {
  let text: string;
  try {
    text = readFileSync(logPath, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RecordedEvent);
}

/**
 * Errno names and their message phrases (plan 08-12 Task 3; D-43, T-08-32). A health body or a
 * diagnostics log line may carry a closed reason code; it must never carry what the operating
 * system said.
 */
const ERRNO_NAMES =
  /\bE(NOENT|ACCES|NOTDIR|ISDIR|PERM|XDEV|MFILE|NFILE|LOOP|NAMETOOLONG|NOTEMPTY|EXIST|IO|BUSY|ROFS|TIMEDOUT|CONNREFUSED|ADDRINUSE|PIPE|AGAIN|INVAL)\b/;
const ERRNO_PHRASES =
  /no such file or directory|permission denied|not a directory|is a directory|operation not permitted|too many open files/i;

/**
 * What in `text` must not be there: any forbidden string (a path, by label), an errno name or an
 * errno phrase. Answers LABELS, never the matched text, so a failing assertion cannot itself print
 * the value. Pure: the non-vacuity tests call it on synthetic text.
 */
export function findLeaks(text: string, forbidden: ReadonlyMap<string, string>): string[] {
  const hits: string[] = [];
  for (const [value, label] of forbidden) {
    if (value.length > 0 && text.includes(value)) hits.push(label);
  }
  if (ERRNO_NAMES.test(text)) hits.push("an errno name");
  if (ERRNO_PHRASES.test(text)) hits.push("an errno message");
  return hits;
}

/** The keys a diagnostics log line may carry (pino's own plus the closed probe fields). */
const DIAGNOSTICS_LOG_KEYS = new Set([
  "level",
  "time",
  "pid",
  "hostname",
  "msg",
  "subsystem",
  "code",
  "errorName",
]);
const DIAGNOSTICS_LOG_MESSAGE = "diagnostics probe did not answer";

/**
 * The problems in a service log: the forbidden strings and errno text anywhere in it except the one
 * Phase 1 startup line that names the socket (`"listening"`, which is outside the diagnostics
 * folder), and, for the diagnostics lines, any key beyond a code and an error class name.
 */
export function logProblems(logText: string, forbidden: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];
  for (const line of logText.split("\n")) {
    if (line.length === 0) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      problems.push("a log line that is not JSON");
      continue;
    }
    if (parsed.msg === "listening") continue;
    for (const hit of findLeaks(line, forbidden)) problems.push(`a log line holds ${hit}`);
    if (parsed.msg === DIAGNOSTICS_LOG_MESSAGE) {
      for (const key of Object.keys(parsed)) {
        if (!DIAGNOSTICS_LOG_KEYS.has(key)) problems.push(`a diagnostics log line carries ${key}`);
      }
    }
  }
  return problems;
}

export interface DrillContext {
  /** The temporary run root: the runtime folder, the socket, the scratch Claude config and the Codex folders live here. */
  readonly dir: string;
  readonly socketPath: string;
  /** The scratch `CLAUDE_CONFIG_DIR`. */
  readonly claudeDir: string;
  /** The runtime folder (equal to {@link dir}). */
  readonly runtimeDir: string;
  /** The service's log file. */
  readonly logPath: string;
  /** The preload's event log. */
  readonly recordPath: string;
  /** The nonexistent research-key test account the service was told to check. */
  readonly researchAccount: string;
  readonly service: TestServiceHandle;
  /** A fresh authenticated health call. */
  health(trigger?: "gesture" | "reconnect"): Promise<DiagnosticsHealthResponse>;
  /** The raw wire body of a health call, for leak scans. */
  rawHealth(trigger?: "gesture" | "reconnect"): Promise<string>;
  events(): RecordedEvent[];
  /** Non-loopback connections and lookups seen so far. */
  outbound(): RecordedEvent[];
  /** Child processes started with `security` as the binary and the research account in argv. */
  researchKeySpawns(): RecordedEvent[];
  /** Adds a string (a path the test created) that no health body or diagnostics log line may hold. */
  forbid(value: string, label: string): void;
  /** Every raw health body this context has seen. */
  bodies(): readonly string[];
  /** The leak problems so far in the bodies and the log (empty when clean). */
  leaks(): string[];
}

export interface DrillOptions {
  /** Extra environment for the service; a function receives the run root. */
  readonly env?: Record<string, string> | ((dir: string) => Record<string, string>);
  /** False turns off the automatic leak scan at the end of the run (default true). */
  readonly leakScan?: boolean;
  /** Prepares the run folder before the service starts (a fake world). */
  readonly prepare?: (dir: string) => void | Promise<void>;
}

/**
 * Runs `fn` against a real service process in its own temporary folder (removed afterwards, even on
 * failure). The service is killed at the end. Every Keychain item the service itself creates is the
 * throwaway install secret, deleted in the teardown.
 */
export async function withDrillService<T>(
  fn: (context: DrillContext) => Promise<T>,
  options: DrillOptions = {},
): Promise<T> {
  const researchAccount = nonexistentResearchAccount();
  const account = setUpServiceEnvironment();
  try {
    return await withTempSocketDir(async ({ dir, socketPath }) => {
      const claudeDir = join(dir, "claude");
      mkdirSync(join(claudeDir, "projects"), { recursive: true });
      process.env.CLAUDE_CONFIG_DIR = claudeDir;
      await options.prepare?.(dir);
      const preload = join(dir, "w2-preload.cjs");
      const recordPath = join(dir, "w2-record.ndjson");
      writeFileSync(preload, networkPreloadSource(recordPath), { mode: 0o600 });
      const service = await startServiceForTest({
        socketPath,
        dbPath: join(dir, "operational.db"),
        waitAttempts: 200,
        env: {
          // The hook spool and its dropped-records file live inside the run folder, whatever the
          // calling shell exported.
          CCC_SPOOL_PATH: join(dir, "spool", "hooks.ndjson"),
          CCC_ENABLE_TEST_OVERRIDES: "1",
          CCC_RESEARCH_KEY_ACCOUNT: researchAccount,
          NODE_OPTIONS: `--require=${preload}`,
          ...(typeof options.env === "function" ? options.env(dir) : options.env),
        },
      });
      const client = createAuthenticatedClient({ socketPath });
      const events = (): RecordedEvent[] => readRecordedEvents(recordPath);
      const bodies: string[] = [];
      // What must never appear in a health body or a diagnostics log line: the run root and
      // everything under it (the runtime folder, the socket, the scratch Claude config, the Codex
      // isolation folders), the owner's home folder, and anything the test adds.
      const forbidden = new Map<string, string>([
        [dir, "the run root"],
        [claudeDir, "the Claude config path"],
        [homedir(), "the home folder"],
      ]);
      const wire = async (trigger: "gesture" | "reconnect"): Promise<string> => {
        const raw = await client.request<unknown>({
          method: "GET",
          path: `${DIAGNOSTICS_HEALTH_PATH}?trigger=${trigger}`,
        });
        const body = JSON.stringify(raw.body);
        bodies.push(body);
        return body;
      };
      const readLog = (): string => {
        try {
          return readFileSync(join(dir, "logs", "service.log"), "utf8");
        } catch {
          return "";
        }
      };
      const context: DrillContext = {
        dir,
        socketPath,
        claudeDir,
        runtimeDir: dir,
        logPath: join(dir, "logs", "service.log"),
        recordPath,
        researchAccount,
        service,
        // The raw body is kept for the leak scan and parsed with the same strict schema the client uses.
        health: async (trigger = "gesture") =>
          DiagnosticsHealthResponseSchema.parse(JSON.parse(await wire(trigger))),
        rawHealth: (trigger = "gesture") => wire(trigger),
        events,
        outbound: () =>
          events().filter((event) => event.kind === "connect" || event.kind === "lookup"),
        researchKeySpawns: () =>
          events().filter(
            (event) =>
              event.kind === "spawn" &&
              event.file.endsWith("/security") &&
              event.args.includes(researchAccount),
          ),
        forbid: (value, label) => {
          forbidden.set(value, label);
        },
        bodies: () => bodies,
        leaks: () => [
          ...bodies.flatMap((body) =>
            findLeaks(body, forbidden).map((hit) => `a body holds ${hit}`),
          ),
          ...logProblems(readLog(), forbidden),
        ],
      };
      try {
        const result = await fn(context);
        if (options.leakScan !== false) {
          // A scan over nothing proves nothing: a drill that never asked for health is a mistake.
          if (bodies.length === 0) throw new Error("the leak scan saw no health body");
          const problems = context.leaks();
          if (problems.length > 0)
            throw new Error(`leaks found: ${[...new Set(problems)].join("; ")}`);
        }
        return result;
      } finally {
        await service.kill();
      }
    });
  } finally {
    tearDownServiceEnvironment(account);
  }
}

/** The health call repeated until `until` holds (the 2 s result cache expires between polls), or it throws. */
export async function pollHealth(
  context: DrillContext,
  until: (health: DiagnosticsHealthResponse) => boolean,
  options: { readonly trigger?: "gesture" | "reconnect"; readonly timeoutMs?: number } = {},
): Promise<DiagnosticsHealthResponse> {
  const deadline = Date.now() + (options.timeoutMs ?? 8000);
  let last = await context.health(options.trigger);
  while (!until(last)) {
    if (Date.now() > deadline) {
      throw new Error(
        `health never reached the expected state; last rows: ${JSON.stringify(
          last.rows.map((row) => [row.id, row.status, row.reasonCode]),
        )}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    last = await context.health(options.trigger);
  }
  return last;
}

/** A throwaway folder under the shared test base (removed by the caller). */
export function makeScratchDir(prefix: string): string {
  const base = join(homedir(), ".ccc-test");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}

export function removeScratchDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}
