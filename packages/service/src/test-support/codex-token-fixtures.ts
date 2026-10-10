import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CodexTokenSummary } from "@ccc/domain";
import {
  applyMigrations,
  CODEX_ANALYTICS_TABLES,
  type OperationalStore,
  openStore,
} from "@ccc/operational-store";
import type Database from "better-sqlite3";
import { type CodexHomePort, createCodexHomePort } from "../codex/codex-home.js";
import {
  createTokenScanner,
  type TokenScanner,
  type TokenScannerDeps,
  type TokenScannerTimers,
} from "../codex/token-scanner.js";
import { createFakeCodexHome, type FakeCodexHome } from "./fake-codex-home.js";

/**
 * Synthetic Codex rollouts and a scanner harness for the token scanner tests
 * (plan 05.1-23). Every id, path and text is synthetic: home paths are
 * `/Users/USERNAME/...`, and each content-bearing line carries a decoy marker
 * that must never reach a table, an event or a log line. No real rollout is
 * read or copied.
 */

export const THREAD_A = "thread-aaaa1111";
export const THREAD_B = "thread-bbbb2222";
export const CLI_VERSION = "0.159.2";
export const OLD_CLI_VERSION = "0.58.0-alpha.10";

/** The fixed "now" of the scanner tests (UTC noon). */
export const NOW_ISO = "2026-10-10T12:00:00.000Z";
export const TIME_ZONE = "UTC";

export const DECOY_PROMPT_TEXT = "DECOY-PROMPT-TEXT-FROM-OWNER";
export const DECOY_REPLY_TEXT = "DECOY-REPLY-TEXT-FROM-MODEL";
export const DECOY_TITLE_TEXT = "DECOY-THREAD-TITLE-TEXT";
export const DECOY_PATH_TEXT = "/Users/USERNAME/secret-project/DECOY-PATH-FILE.ts";
export const DECOY_ACCOUNT_TEXT = "DECOY-ACCOUNT-MARKER-0001";
export const ALL_DECOYS: readonly string[] = [
  DECOY_PROMPT_TEXT,
  DECOY_REPLY_TEXT,
  DECOY_TITLE_TEXT,
  DECOY_PATH_TEXT,
  DECOY_ACCOUNT_TEXT,
];

export interface RawCounters {
  readonly input_tokens: number;
  readonly cached_input_tokens: number;
  readonly cache_write_input_tokens: number;
  readonly output_tokens: number;
  readonly reasoning_output_tokens: number;
  readonly total_tokens: number;
}

/** A six-counter usage object; `total` defaults to input + output. */
export function raw(input: number, output: number, extra: Partial<RawCounters> = {}): RawCounters {
  return {
    input_tokens: input,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
    ...extra,
  };
}

/** An ISO time `seconds` after 2026-10-10T10:00:00Z. */
export function at(seconds: number): string {
  return new Date(Date.parse("2026-10-10T10:00:00.000Z") + seconds * 1000).toISOString();
}

export function turn(n: number): string {
  return `turn-${String(n).padStart(4, "0")}`;
}

/** `rollout-YYYY-MM-DDTHH-MM-SS-<thread id>.jsonl` for a start instant. */
export function rolloutName(startIso: string, threadId: string): string {
  const stamp = startIso.slice(0, 19).replaceAll(":", "-");
  return `rollout-${stamp}-${threadId}.jsonl`;
}

export function metaLine(
  options: { id?: string; cliVersion?: string; timestamp?: string } = {},
): string {
  const timestamp = options.timestamp ?? at(0);
  return JSON.stringify({
    timestamp,
    type: "session_meta",
    payload: {
      id: options.id ?? THREAD_A,
      timestamp,
      cwd: DECOY_PATH_TEXT,
      originator: "codex_cli_rs",
      cli_version: options.cliVersion ?? CLI_VERSION,
      source: "cli",
      creator_account_id: DECOY_ACCOUNT_TEXT,
      base_instructions: { text: DECOY_PROMPT_TEXT },
    },
  });
}

/** A top-level per-turn usage record (cumulative within the turn). */
export function turnRecordLine(options: {
  turnId: string;
  timestamp: string;
  usage: RawCounters;
  threadId?: string;
  /** Drops a member the parser needs, so the record cannot be read. */
  malformed?: boolean;
}): string {
  return JSON.stringify({
    timestamp: options.timestamp,
    type: "token_usage_record",
    thread_id: options.threadId ?? THREAD_A,
    turn_id: options.turnId,
    turn_token_usage: options.malformed === true ? { input_tokens: "x" } : options.usage,
    thread_token_usage: options.usage,
  });
}

/** A cumulative `token_count` event; `total: null` writes `info: null`. */
export function tokenCountLine(options: { timestamp: string; total: RawCounters | null }): string {
  return JSON.stringify({
    timestamp: options.timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: options.total === null ? null : { total_token_usage: options.total },
      rate_limits: { plan_type: DECOY_ACCOUNT_TEXT, primary: null, secondary: null },
    },
  });
}

/** Prompt, reply, title, path and account decoys in lines the parser must not copy. */
export function contentLines(timestamp: string): string[] {
  return [
    JSON.stringify({
      timestamp,
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: DECOY_PROMPT_TEXT }],
      },
    }),
    JSON.stringify({
      timestamp,
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: DECOY_REPLY_TEXT }],
      },
    }),
    JSON.stringify({
      timestamp,
      type: "event_msg",
      payload: { type: "thread_name_updated", thread_name: DECOY_TITLE_TEXT },
    }),
    JSON.stringify({
      timestamp,
      type: "response_item",
      payload: {
        type: "function_call",
        name: "shell",
        arguments: JSON.stringify({
          command: ["cat", DECOY_PATH_TEXT],
          account: DECOY_ACCOUNT_TEXT,
        }),
      },
    }),
  ];
}

/** Lines to rollout text, each newline-terminated. */
export function jsonl(lines: readonly string[]): string {
  return `${lines.join("\n")}\n`;
}

/** The usual per-turn rollout of the tracer: two turns, with cumulative events beside them. */
export function perTurnRollout(): string {
  return jsonl([
    metaLine(),
    ...contentLines(at(1)),
    turnRecordLine({ turnId: turn(1), timestamp: at(21), usage: raw(100, 20) }),
    tokenCountLine({ timestamp: at(21), total: raw(100, 20) }),
    turnRecordLine({ turnId: turn(1), timestamp: at(40), usage: raw(250, 60) }),
    tokenCountLine({ timestamp: at(40), total: raw(250, 60) }),
    turnRecordLine({ turnId: turn(1), timestamp: at(65), usage: raw(400, 90) }),
    tokenCountLine({ timestamp: at(65), total: raw(400, 90) }),
    turnRecordLine({ turnId: turn(2), timestamp: at(1200), usage: raw(50, 10) }),
    tokenCountLine({ timestamp: at(1200), total: raw(450, 100) }),
  ]);
}

// --- The cumulative-only rollout (no per-turn records) ---------------------------

/** The folder day and name of the cumulative-only rollout of the dedup tests. */
export const CUMULATIVE_DAY = "2026-10-09";
export const CUMULATIVE_NAME = rolloutName("2026-10-09T23:45:00.000Z", THREAD_A);

/** Cumulative totals as (input, cached, cache write, output, reasoning, total). */
function six(
  input: number,
  cached: number,
  write: number,
  output: number,
  reasoning: number,
  total: number,
): RawCounters {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: write,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: total,
  };
}

/**
 * Six token_count steps across a quarter-hour and a day boundary: a growing
 * total, an identical repeat, `info: null`, then independent decreases of
 * four counters while two others still grow.
 */
export const CUMULATIVE_STEPS: ReadonlyArray<{ at: string; total: RawCounters | null }> = [
  { at: "2026-10-09T23:50:00.000Z", total: six(100, 10, 5, 20, 4, 120) },
  { at: "2026-10-09T23:55:00.000Z", total: six(150, 12, 5, 50, 4, 200) },
  { at: "2026-10-09T23:58:00.000Z", total: six(150, 12, 5, 50, 4, 200) },
  { at: "2026-10-10T00:01:00.000Z", total: null },
  { at: "2026-10-10T00:05:00.000Z", total: six(120, 20, 3, 40, 6, 160) },
  { at: "2026-10-10T00:20:00.000Z", total: six(180, 20, 5, 60, 6, 240) },
];

/** What every route to the cumulative-only rollout must total. */
export const CUMULATIVE_TOTALS = {
  input: 180,
  cachedInput: 20,
  cacheWrite: 5,
  output: 60,
  reasoningOutput: 6,
  total: 240,
} as const;

/** The part of the day-10-10 buckets: 00:00 and 00:15. */
export const CUMULATIVE_TODAY_TOTALS = {
  input: 30,
  cachedInput: 8,
  cacheWrite: 0,
  output: 10,
  reasoningOutput: 2,
  total: 40,
} as const;

/** The rollout's lines: meta, content decoys, then `steps` token_count lines. */
export function cumulativeLines(steps = CUMULATIVE_STEPS.length): string[] {
  return [
    metaLine({ cliVersion: OLD_CLI_VERSION, timestamp: "2026-10-09T23:45:00.000Z" }),
    ...contentLines("2026-10-09T23:46:00.000Z"),
    ...CUMULATIVE_STEPS.slice(0, steps).map((step) =>
      tokenCountLine({ timestamp: step.at, total: step.total }),
    ),
  ];
}

// --- Temporary operational store -----------------------------------------------

export interface TempStore {
  readonly dir: string;
  readonly store: OperationalStore;
  readonly db: Database.Database;
  /** Closes and reopens the same database file (a service restart). */
  reopen(): TempStore;
  cleanup(): void;
}

export function openTempStore(existingDir?: string): TempStore {
  const dir = existingDir ?? mkdtempSync(join(tmpdir(), "ccc-codex-tokens-"));
  const store = openStore(join(dir, "operational.db"));
  applyMigrations(store.db);
  return {
    dir,
    store,
    db: store.db,
    reopen() {
      store.close();
      return openTempStore(dir);
    },
    cleanup() {
      try {
        store.close();
      } catch {
        // already closed
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Every row of every Codex analytics table as one JSON text, for database-wide scans. */
export function dumpCodexTables(db: Database.Database): string {
  const parts: string[] = [];
  for (const table of CODEX_ANALYTICS_TABLES) {
    parts.push(table, JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()));
  }
  parts.push(JSON.stringify(db.prepare("SELECT * FROM collector_settings").all()));
  return parts.join("\n");
}

// --- A recording view over the real port ----------------------------------------

export type PortMethods = "listRolloutFiles" | "statRollout" | "readRolloutRange";

export interface SpyPort {
  readonly port: Pick<CodexHomePort, PortMethods>;
  readonly calls: Record<PortMethods, number>;
  readonly bytesRead: () => number;
  reset(): void;
}

export function spyOnPort(real: Pick<CodexHomePort, PortMethods>): SpyPort {
  const calls: Record<PortMethods, number> = {
    listRolloutFiles: 0,
    statRollout: 0,
    readRolloutRange: 0,
  };
  let bytes = 0;
  return {
    calls,
    bytesRead: () => bytes,
    reset() {
      calls.listRolloutFiles = 0;
      calls.statRollout = 0;
      calls.readRolloutRange = 0;
      bytes = 0;
    },
    port: {
      listRolloutFiles(range) {
        calls.listRolloutFiles += 1;
        return real.listRolloutFiles(range);
      },
      statRollout(ref) {
        calls.statRollout += 1;
        return real.statRollout(ref);
      },
      readRolloutRange(ref, offset, maxBytes) {
        calls.readRolloutRange += 1;
        const result = real.readRolloutRange(ref, offset, maxBytes);
        bytes += result.bytes.length;
        return result;
      },
    },
  };
}

// --- A fake Codex home with writable rollouts ------------------------------------

export interface RolloutHome {
  readonly home: FakeCodexHome;
  readonly port: CodexHomePort;
  /** Writes (or replaces) a rollout under its dated folder; returns its absolute path. */
  write(day: string, name: string, content: string): string;
  append(day: string, name: string, content: string): void;
  cleanup(): void;
}

export function createRolloutHome(): RolloutHome {
  const home = createFakeCodexHome();
  const port = createCodexHomePort({ root: home.root });
  return {
    home,
    port,
    write(day, name, content) {
      const path = home.rolloutPath(day, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      return path;
    },
    append(day, name, content) {
      appendFileSync(home.rolloutPath(day, name), content);
    },
    cleanup: () => home.cleanup(),
  };
}

// --- The scanner harness ----------------------------------------------------------

export interface FakeTimers extends TokenScannerTimers {
  /** Intervals currently armed. */
  armed(): number;
  /** Fires every armed interval once. */
  tick(): void;
}

export function fakeTimers(): FakeTimers {
  const handles = new Map<number, () => void>();
  let next = 1;
  return {
    setInterval(fn) {
      const id = next++;
      handles.set(id, fn);
      return id;
    },
    clearInterval(handle) {
      handles.delete(handle as number);
    },
    armed: () => handles.size,
    tick() {
      for (const fn of [...handles.values()]) fn();
    },
  };
}

export interface LogEntry {
  readonly level: "info" | "warn";
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

export interface TokenHarness {
  readonly rollouts: RolloutHome;
  temp: TempStore;
  readonly spy: SpyPort;
  readonly timers: FakeTimers;
  readonly state: { on: boolean; subscribers: number; nowMs: number };
  readonly published: CodexTokenSummary[];
  readonly logs: LogEntry[];
  scanner: TokenScanner;
  /** Builds another scanner over the same store, port and clock. */
  makeScanner(over?: Partial<TokenScannerDeps>): TokenScanner;
  /** Closes and reopens the database, then builds a fresh scanner (a service restart). */
  restart(over?: Partial<TokenScannerDeps>): void;
  cleanup(): void;
}

export function createTokenHarness(
  options: { on?: boolean; nowIso?: string; over?: Partial<TokenScannerDeps> } = {},
): TokenHarness {
  const rollouts = createRolloutHome();
  const spy = spyOnPort(rollouts.port);
  const timers = fakeTimers();
  const state = {
    on: options.on ?? true,
    subscribers: 1,
    nowMs: Date.parse(options.nowIso ?? NOW_ISO),
  };
  const published: CodexTokenSummary[] = [];
  const logs: LogEntry[] = [];
  const logger = {
    info: (fields: Record<string, unknown>, message: string) =>
      logs.push({ level: "info", fields, message }),
    warn: (fields: Record<string, unknown>, message: string) =>
      logs.push({ level: "warn", fields, message }),
  };
  const harness: TokenHarness = {
    rollouts,
    temp: openTempStore(),
    spy,
    timers,
    state,
    published,
    logs,
    scanner: undefined as unknown as TokenScanner,
    makeScanner(over = {}) {
      return createTokenScanner({
        db: harness.temp.db,
        port: spy.port,
        logger,
        now: () => new Date(state.nowMs),
        timeZone: TIME_ZONE,
        isAnalysisOn: () => state.on,
        subscribers: () => state.subscribers,
        publish: (_type, payload) => published.push(payload),
        timers,
        yieldNow: async () => undefined,
        ...options.over,
        ...over,
      });
    },
    restart(over = {}) {
      harness.scanner.stop();
      harness.temp = harness.temp.reopen();
      harness.scanner = harness.makeScanner(over);
    },
    cleanup() {
      harness.scanner.stop();
      harness.temp.cleanup();
      rollouts.cleanup();
    },
  };
  harness.scanner = harness.makeScanner();
  return harness;
}
