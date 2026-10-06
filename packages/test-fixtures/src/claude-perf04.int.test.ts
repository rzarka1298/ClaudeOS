import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import http from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AUTH_HEADER,
  EVENTS_PATH,
  HANDSHAKE_PATH,
  type HandshakeResponse,
  LAST_EVENT_ID_HEADER,
  type ServiceEvent,
  ServiceEventSchema,
  SessionUpsertedPayloadSchema,
  type SessionView,
  SNAPSHOT_PATH,
  type SnapshotResponse,
} from "@ccc/domain";
import {
  resolveSocketPath,
  resolveSpoolDropPath,
  resolveSpoolPath,
  resolveStatusLineSpoolPath,
} from "@ccc/service/paths";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requestOverSocket, startServiceForTest } from "./service-harness.js";
import { withTempSocketDir } from "./socket-fixture.js";

/**
 * PERF-04 (D-54, D-56): the COMPILED hook, spawned exactly as Claude Code
 * spawns it, talks to the real built service over its Unix socket, and the
 * session.upserted event it causes is timed on the authenticated event
 * stream. Every path lives under a short `~/.ccc-test/` temp dir; nothing
 * touches the real runtime dir or the real Claude config dir.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPILED_HOOK = resolve(HERE, "../../collectors/dist/hook/entry.js");
const COMPILED_LIMITS = resolve(HERE, "../../collectors/dist/hook/limits.js");

const SPAWNS = 20;
const P95_BUDGET_MS = 2000;
const MAX_BUDGET_MS = 10_000;
const HOOK_WALL_P95_BUDGET_MS = 300;

const KEYCHAIN_SERVICE_NAME = "com.claude-command-center";
const ITEM_NOT_FOUND_EXIT_CODE = 44;

// Copied verbatim from replay-and-resync.test.ts: the real service persists
// its install secret to the real Keychain, under a throwaway account here.
let throwawayAccount: string;

beforeEach(() => {
  throwawayAccount = `install-secret-test-${randomBytes(6).toString("hex")}`;
  process.env.CCC_INSTALL_SECRET_ACCOUNT = throwawayAccount;
  process.env.CCC_HEARTBEAT_INTERVAL_MS = "150";
});

afterEach(() => {
  delete process.env.CCC_INSTALL_SECRET_ACCOUNT;
  delete process.env.CCC_HEARTBEAT_INTERVAL_MS;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    execFileSync(
      "security",
      ["delete-generic-password", "-a", throwawayAccount, "-s", KEYCHAIN_SERVICE_NAME],
      { stdio: "ignore" },
    );
  } catch (err: unknown) {
    const status = (err as { status?: number }).status;
    if (status !== ITEM_NOT_FOUND_EXIT_CODE) throw err;
  }
});

interface Arrival {
  readonly event: ServiceEvent;
  readonly at: number;
}

interface EventCollector {
  waitFor(predicate: (event: ServiceEvent) => boolean, timeoutMs: number): Promise<Arrival>;
  close(): void;
}

/**
 * One long-lived subscription to the raw event stream, timestamping every
 * record with `performance.now()` as it arrives (the replay-and-resync
 * parser, kept open so each measurement does not pay a reconnect).
 */
function collectEvents(socketPath: string, token: string, lastEventId?: number): EventCollector {
  const arrivals: Arrival[] = [];
  const waiters = new Set<() => void>();
  const headers: Record<string, string> = { [AUTH_HEADER]: `Bearer ${token}` };
  if (lastEventId !== undefined) headers[LAST_EVENT_ID_HEADER] = String(lastEventId);
  const req = http.request({ socketPath, path: EVENTS_PATH, method: "GET", headers }, (res) => {
    let buffer = "";
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      const at = performance.now();
      buffer += chunk;
      let idx = buffer.indexOf("\n\n");
      while (idx !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLine = raw.match(/^data: (.+)$/m);
        if (dataLine) {
          const parsed = ServiceEventSchema.safeParse(JSON.parse(dataLine[1] as string));
          if (parsed.success) arrivals.push({ event: parsed.data, at });
        }
        idx = buffer.indexOf("\n\n");
      }
      for (const wake of waiters) wake();
    });
  });
  req.on("error", () => {});
  req.end();

  return {
    waitFor(predicate, timeoutMs) {
      return new Promise((resolveWait, reject) => {
        const check = (): boolean => {
          const hit = arrivals.find((arrival) => predicate(arrival.event));
          if (hit === undefined) return false;
          waiters.delete(wake);
          clearTimeout(timer);
          resolveWait(hit);
          return true;
        };
        const wake = (): void => {
          check();
        };
        const timer = setTimeout(() => {
          waiters.delete(wake);
          reject(new Error(`no matching event within ${timeoutMs} ms`));
        }, timeoutMs);
        if (!check()) waiters.add(wake);
      });
    },
    close() {
      req.destroy();
    },
  };
}

function sessionOf(event: ServiceEvent): SessionView | null {
  if (event.type !== "session.upserted") return null;
  const parsed = SessionUpsertedPayloadSchema.safeParse(event.payload);
  return parsed.success ? parsed.data.session : null;
}

/** Hook stdin in the documented input shape, synthetic values only. */
function hookInput(runtimeDir: string, event: string, sessionId: string): string {
  return JSON.stringify({
    session_id: sessionId,
    transcript_path: join(runtimeDir, "claude", "projects", "demo", `${sessionId}.jsonl`),
    cwd: join(runtimeDir, "code", "demo"),
    permission_mode: "default",
    hook_event_name: event,
    ...(event === "SessionStart" ? { source: "startup" } : { prompt: "synthetic prompt" }),
  });
}

/** Spawns the compiled hook with a clean env; resolves with its wall time. */
function runHook(runtimeDir: string, stdin: string): { spawnedAt: number; done: Promise<number> } {
  const spawnedAt = performance.now();
  const child = spawn(process.execPath, [COMPILED_HOOK, "--runtime-dir", runtimeDir], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/",
      CLAUDE_PID: String(process.pid),
    },
    stdio: ["pipe", "ignore", "ignore"],
  });
  const done = new Promise<number>((resolveDone) => {
    child.once("close", () => resolveDone(performance.now() - spawnedAt));
  });
  child.stdin.end(stdin);
  return { spawnedAt, done };
}

function percentile(samples: readonly number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] as number;
}

async function handshake(socketPath: string): Promise<string> {
  const res = await requestOverSocket<HandshakeResponse>(socketPath, {
    method: "POST",
    path: HANDSHAKE_PATH,
  });
  return res.body.token;
}

describe("PERF-04: real hook -> real service -> event stream", () => {
  it("delivers 20 hook events as session.upserted with p95 < 2 s and max < 10 s (Test 4)", async () => {
    await withTempSocketDir(async ({ dir, socketPath }) => {
      process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
      mkdirSync(join(dir, "claude", "projects", "demo"), { recursive: true });
      const service = await startServiceForTest({
        socketPath,
        dbPath: join(dir, "operational.db"),
      });
      const token = await handshake(socketPath);
      const stream = collectEvents(socketPath, token);
      try {
        const latencies: number[] = [];
        const hookWalls: number[] = [];
        // SPAWNS / 2 distinct sessions, each a SessionStart then a UserPromptSubmit.
        for (let pair = 0; pair < SPAWNS / 2; pair += 1) {
          const sessionId = `perf-${pair}-${randomUUID().slice(0, 8)}`;
          for (const event of ["SessionStart", "UserPromptSubmit"] as const) {
            const hook = runHook(dir, hookInput(dir, event, sessionId));
            const arrival = await stream.waitFor((candidate) => {
              const session = sessionOf(candidate);
              if (session === null || session.claudeSessionId !== sessionId) return false;
              return event === "SessionStart"
                ? session.revision === 1
                : session.activity === "working";
            }, MAX_BUDGET_MS);
            latencies.push(arrival.at - hook.spawnedAt);
            hookWalls.push(await hook.done);
          }
        }
        const report = {
          spawns: SPAWNS,
          p50Ms: Math.round(percentile(latencies, 0.5)),
          p95Ms: Math.round(percentile(latencies, 0.95)),
          maxMs: Math.round(Math.max(...latencies)),
          hookWallP50Ms: Math.round(percentile(hookWalls, 0.5)),
          hookWallP95Ms: Math.round(percentile(hookWalls, 0.95)),
        };
        console.log(`PERF-04 ${JSON.stringify(report)}`);
        expect(percentile(latencies, 0.95)).toBeLessThan(P95_BUDGET_MS);
        expect(Math.max(...latencies)).toBeLessThan(MAX_BUDGET_MS);
        expect(percentile(hookWalls, 0.95)).toBeLessThan(HOOK_WALL_P95_BUDGET_MS);
      } finally {
        stream.close();
        await service.stop();
      }
    });
  }, 60_000);

  it("applies a record spooled while the service was down before the socket accepts a request (Test 5)", async () => {
    await withTempSocketDir(async ({ dir, socketPath }) => {
      process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
      const sessionId = `spooled-${randomUUID().slice(0, 8)}`;
      const hook = runHook(dir, hookInput(dir, "SessionStart", sessionId));
      await hook.done;
      expect(existsSync(join(dir, "spool", "hooks.ndjson"))).toBe(true);

      const service = await startServiceForTest({
        socketPath,
        dbPath: join(dir, "operational.db"),
      });
      const reachableAt = performance.now();
      try {
        const token = await handshake(socketPath);
        const snapshot = await requestOverSocket<SnapshotResponse>(socketPath, {
          method: "GET",
          path: SNAPSHOT_PATH,
          headers: { [AUTH_HEADER]: `Bearer ${token}` },
        });
        expect(snapshot.body.state.sessions?.map((session) => session.claudeSessionId)).toContain(
          sessionId,
        );
        const stream = collectEvents(socketPath, token, 0);
        try {
          const arrival = await stream.waitFor(
            (candidate) => sessionOf(candidate)?.claudeSessionId === sessionId,
            P95_BUDGET_MS,
          );
          expect(arrival.at - reachableAt).toBeLessThan(P95_BUDGET_MS);
        } finally {
          stream.close();
        }
        expect(existsSync(join(dir, "spool", "hooks.ndjson"))).toBe(false);
      } finally {
        await service.stop();
      }
    });
  }, 30_000);

  it("the compiled hook's socket and spool names equal the service's resolved paths (Test 6)", async () => {
    const limits = (await import(pathToFileURL(COMPILED_LIMITS).href)) as {
      SOCKET_FILE_NAME: string;
      SPOOL_DIR_NAME: string;
      SPOOL_FILE_NAME: string;
      STATUSLINE_SPOOL_FILE_NAME: string;
      SPOOL_DROP_FILE_NAME: string;
    };
    const saved = {
      runtime: process.env.CCC_RUNTIME_DIR,
      socket: process.env.CCC_SOCKET_PATH,
      spool: process.env.CCC_SPOOL_PATH,
    };
    const runtimeDir = join(process.env.HOME ?? "/", ".ccc-test", "names");
    process.env.CCC_RUNTIME_DIR = runtimeDir;
    delete process.env.CCC_SOCKET_PATH;
    delete process.env.CCC_SPOOL_PATH;
    try {
      const spoolDir = join(runtimeDir, limits.SPOOL_DIR_NAME);
      expect(resolveSocketPath()).toBe(join(runtimeDir, limits.SOCKET_FILE_NAME));
      expect(resolveSpoolPath()).toBe(join(spoolDir, limits.SPOOL_FILE_NAME));
      expect(resolveStatusLineSpoolPath()).toBe(join(spoolDir, limits.STATUSLINE_SPOOL_FILE_NAME));
      expect(resolveSpoolDropPath()).toBe(join(spoolDir, limits.SPOOL_DROP_FILE_NAME));
    } finally {
      for (const [key, value] of [
        ["CCC_RUNTIME_DIR", saved.runtime],
        ["CCC_SOCKET_PATH", saved.socket],
        ["CCC_SPOOL_PATH", saved.spool],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
