import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import http from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUTH_HEADER,
  EVENTS_PATH,
  HANDSHAKE_PATH,
  type HandshakeResponse,
  type ServiceEvent,
  ServiceEventSchema,
  SessionUpsertedPayloadSchema,
  type SessionView,
} from "@ccc/domain";
import { getSessionRun, openStore } from "@ccc/operational-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requestOverSocket, startServiceForTest } from "./service-harness.js";
import { withTempSocketDir } from "./socket-fixture.js";

/**
 * SESS-06/07/08 with real processes and the real built service (05-11):
 * throwaway `node` children stand in for Claude processes, the COMPILED hook
 * reports their pids exactly as Claude Code's hook would, and the event
 * stream is read over the service's Unix socket. Every path lives under a
 * short `~/.ccc-test/` temp dir; only processes this file spawns are ever
 * signalled.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPILED_HOOK = resolve(HERE, "../../collectors/dist/hook/entry.js");

const KEYCHAIN_SERVICE_NAME = "com.claude-command-center";
const ITEM_NOT_FOUND_EXIT_CODE = 44;

// The Keychain throwaway from replay-and-resync.test.ts (also used by
// claude-perf04.int.test.ts): the real service persists its install secret
// to the real Keychain, under a throwaway account here.
let throwawayAccount: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  throwawayAccount = `install-secret-test-${randomBytes(6).toString("hex")}`;
  process.env.CCC_INSTALL_SECRET_ACCOUNT = throwawayAccount;
  process.env.CCC_HEARTBEAT_INTERVAL_MS = "150";
  process.env.CCC_LIVENESS_SWEEP_MS = "200";
  process.env.CCC_LIVENESS_GRACE_MS = "500";
});

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  delete process.env.CCC_INSTALL_SECRET_ACCOUNT;
  delete process.env.CCC_HEARTBEAT_INTERVAL_MS;
  delete process.env.CCC_LIVENESS_SWEEP_MS;
  delete process.env.CCC_LIVENESS_GRACE_MS;
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

interface EventCollector {
  readonly events: ServiceEvent[];
  waitFor(predicate: (event: ServiceEvent) => boolean, timeoutMs: number): Promise<ServiceEvent>;
  close(): void;
}

/** One long-lived subscription to the raw event stream (the claude-perf04 parser). */
function collectEvents(socketPath: string, token: string): EventCollector {
  const events: ServiceEvent[] = [];
  const waiters = new Set<() => void>();
  const headers: Record<string, string> = { [AUTH_HEADER]: `Bearer ${token}` };
  const req = http.request({ socketPath, path: EVENTS_PATH, method: "GET", headers }, (res) => {
    let buffer = "";
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      buffer += chunk;
      let idx = buffer.indexOf("\n\n");
      while (idx !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLine = raw.match(/^data: (.+)$/m);
        if (dataLine) {
          const parsed = ServiceEventSchema.safeParse(JSON.parse(dataLine[1] as string));
          if (parsed.success) events.push(parsed.data);
        }
        idx = buffer.indexOf("\n\n");
      }
      for (const wake of waiters) wake();
    });
  });
  req.on("error", () => {});
  req.end();

  return {
    events,
    waitFor(predicate, timeoutMs) {
      return new Promise((resolveWait, reject) => {
        const check = (): boolean => {
          const hit = events.find(predicate);
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

async function handshake(socketPath: string): Promise<string> {
  const res = await requestOverSocket<HandshakeResponse>(socketPath, {
    method: "POST",
    path: HANDSHAKE_PATH,
  });
  return res.body.token;
}

/** A throwaway idle `node` process standing in for a Claude process; only this file signals it. */
async function spawnFakeClaude(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  children.push(child);
  await new Promise<void>((resolveSpawn, reject) => {
    child.once("spawn", () => resolveSpawn());
    child.once("error", reject);
  });
  return child;
}

/** SIGKILLs a throwaway child and waits until Node has reaped it (a zombie still answers kill(0)). */
async function killAndReap(child: ChildProcess): Promise<void> {
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  child.kill("SIGKILL");
  await exited;
}

/** Runs the compiled hook once, exactly as Claude Code spawns it, with CLAUDE_PID = `pid`. */
async function runHook(
  runtimeDir: string,
  pid: number,
  record: Record<string, unknown>,
): Promise<void> {
  const child = spawn(process.execPath, [COMPILED_HOOK, "--runtime-dir", runtimeDir], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/",
      CLAUDE_PID: String(pid),
    },
    stdio: ["pipe", "ignore", "ignore"],
  });
  const done = new Promise<void>((resolveDone) => child.once("close", () => resolveDone()));
  child.stdin.end(JSON.stringify(record));
  await done;
}

function sessionStart(sessionId: string, cwd: string): Record<string, unknown> {
  return {
    session_id: sessionId,
    cwd,
    permission_mode: "default",
    model: "claude-test-model",
    hook_event_name: "SessionStart",
    source: "startup",
  };
}

describe("SESS-06: a Claude process killed without SessionEnd reads unknown (Task 1, Test 4)", () => {
  it("turns the Run stale on the live stream within 5 s and never completed or failed", async () => {
    await withTempSocketDir(async ({ dir, socketPath }) => {
      process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
      mkdirSync(join(dir, "claude", "projects"), { recursive: true });
      const service = await startServiceForTest({
        socketPath,
        dbPath: join(dir, "operational.db"),
      });
      const token = await handshake(socketPath);
      const stream = collectEvents(socketPath, token);
      try {
        const claude = await spawnFakeClaude();
        const pid = claude.pid as number;
        const sessionId = `liveness-${randomUUID().slice(0, 8)}`;
        await runHook(dir, pid, sessionStart(sessionId, join(dir, "code", "demo")));
        const started = await stream.waitFor(
          (event) =>
            sessionOf(event)?.claudeSessionId === sessionId &&
            sessionOf(event)?.state === "running",
          10_000,
        );
        const runId = sessionOf(started)?.runId;

        // Alive with a matching identity: several sweeps change nothing.
        await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
        expect(
          stream.events.filter((event) => sessionOf(event)?.runId === runId).map(sessionOf),
        ).toHaveLength(1);

        await killAndReap(claude);
        await stream.waitFor(
          (event) => sessionOf(event)?.runId === runId && sessionOf(event)?.state === "stale",
          5_000,
        );
        const states = stream.events
          .map(sessionOf)
          .filter((session) => session?.runId === runId)
          .map((session) => session?.state);
        expect(states).not.toContain("completed");
        expect(states).not.toContain("failed");
      } finally {
        stream.close();
        await service.stop();
      }
    });
  }, 30_000);
});

describe("SESS-07/08: two concurrent sessions under two projects (Task 3, Test 5)", () => {
  it("shows two Runs, each with its project, pid, model, launch source and start time", async () => {
    await withTempSocketDir(async ({ dir, socketPath }) => {
      process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
      mkdirSync(join(dir, "claude", "projects"), { recursive: true });
      const dbPath = join(dir, "operational.db");
      const service = await startServiceForTest({ socketPath, dbPath });
      const token = await handshake(socketPath);
      const stream = collectEvents(socketPath, token);
      try {
        const roots = ["alpha", "beta"].map((name) => {
          const root = join(realpathSync(dir), "projects", name);
          mkdirSync(join(root, "src"), { recursive: true });
          return { projectId: `proj-${name}`, root };
        });
        // Test seeding only: product code never writes `projects` (D-57).
        const seed = openStore(dbPath);
        try {
          for (const { projectId, root } of roots) {
            seed.db
              .prepare(
                "INSERT INTO projects (project_id, path, workspace_id, display_name, registered_at) VALUES (?, ?, NULL, ?, ?)",
              )
              .run(projectId, root, projectId, new Date().toISOString());
          }
        } finally {
          seed.close();
        }

        const sessions: { sessionId: string; pid: number; projectId: string }[] = [];
        for (const { projectId, root } of roots) {
          const claude = await spawnFakeClaude();
          const sessionId = `two-${projectId}-${randomUUID().slice(0, 8)}`;
          sessions.push({ sessionId, pid: claude.pid as number, projectId });
          const sentAt = Date.now();
          await runHook(dir, claude.pid as number, sessionStart(sessionId, join(root, "src")));
          const seen = await stream.waitFor((event) => {
            const session = sessionOf(event);
            return session?.claudeSessionId === sessionId && session.projectId === projectId;
          }, 10_000);
          expect(Date.now() - sentAt).toBeLessThan(10_000);
          const view = sessionOf(seen);
          expect(view?.state).toBe("running");
          expect(view?.model).toBe("claude-test-model");
          expect(view?.launchSource).not.toBeNull();
          expect(view?.startedAt).toBeTruthy();
        }

        const views = sessions.map(({ sessionId }) =>
          stream.events.map(sessionOf).find((session) => session?.claudeSessionId === sessionId),
        );
        expect(new Set(views.map((view) => view?.runId)).size).toBe(2);

        const read = openStore(dbPath);
        try {
          for (const [i, view] of views.entries()) {
            const run = getSessionRun(read.db, view?.runId as never);
            expect(run?.pid).toBe(sessions[i]?.pid);
            expect(run?.projectId).toBe(sessions[i]?.projectId);
          }
        } finally {
          read.close();
        }
      } finally {
        stream.close();
        await service.stop();
      }
    });
  }, 40_000);
});
