import { type ChildProcess, spawn } from "node:child_process";
import { homedir } from "node:os";
import { normalizeRateLimitsReply } from "@ccc/collectors";
import type { CodexUsageSnapshot, CodexUsageUnavailableReason } from "@ccc/domain";
import { codexChildEnv } from "./child-env.js";

/**
 * The Codex usage read (plan 05.1-15, D-21, CODEX-08, CODEX-09).
 *
 * `read()` starts `codex app-server`, speaks the three JSON-RPC messages the
 * weekly allowance needs (initialize, the initialized notification, and
 * `account/rateLimits/read`) and nothing else, normalises the reply INSIDE this
 * module through the plan 07 normaliser, and kills the child. The raw reply,
 * including the account id it carries, never leaves this function: the result is
 * a domain snapshot, a failure is an unavailable snapshot with a reason, and no
 * failure throws.
 *
 * The child runs with a MINIMAL environment (HOME, a fixed PATH, the C locale,
 * and CODEX_HOME only when the owner configured one), never the service's own
 * environment. This module reads no file at all: Codex reads its own
 * credentials inside its own process (CODEX-09).
 */

/** The client name sent in `initialize`. */
const CLIENT_NAME = "ccc_codex_collector";

/** The production read cap (D-21). Tests inject a short one. */
export const RATE_LIMITS_READ_CAP_MS = 20_000;

/** How long the child gets to exit after the default termination signal before it is forced. */
export const RATE_LIMITS_KILL_WAIT_MS = 2_000;

/**
 * How long dispose() gives the child to exit after the default termination signal before the
 * SIGKILL escalation (milliseconds). Shorter than the read-path wait so shutdown stays bounded.
 */
export const RATE_LIMITS_DISPOSE_GRACE_MS = 500;

/**
 * The deadline for the whole app-server termination during `stop()`: the dispose grace, the
 * forced kill, and a margin for the exit event. Overrides the per-step default for that step.
 */
export const CODEX_APP_SERVER_STOP_DEADLINE_MS = 1_500;

/** One line of a real reply is a few hundred bytes; anything past this is not one. */
export const RATE_LIMITS_LINE_CAP_BYTES = 128 * 1024;

/** Everything the child may write before the reply is judged hostile. */
export const RATE_LIMITS_TOTAL_CAP_BYTES = 512 * 1024;

export interface RateLimitsLogger {
  /** Reason codes only. Nothing from the reply is ever passed. */
  warn(fields: { readonly reason: string }, message: string): void;
}

export interface RateLimitsClientDeps {
  /** The saved Codex executable path, or null when none is configured. */
  readonly executablePath: () => string | null;
  /** CODEX_HOME for the child, only when the owner configured one. */
  readonly codexHome?: () => string | null;
  /** The home directory the child sees. Defaults to the service user's. */
  readonly homeDir?: () => string;
  readonly spawn?: SpawnFn;
  readonly now?: () => number;
  readonly capMs?: number;
  readonly killWaitMs?: number;
  readonly disposeGraceMs?: number;
  readonly lineCapBytes?: number;
  readonly totalCapBytes?: number;
  readonly logger?: RateLimitsLogger;
}

export interface SpawnOptionsLite {
  readonly shell: false;
  readonly stdio: ["pipe", "pipe", "ignore"];
  readonly env: Readonly<Record<string, string>>;
  readonly windowsHide: true;
}

export type SpawnFn = (
  file: string,
  args: readonly string[],
  options: SpawnOptionsLite,
) => ChildProcess;

export interface RateLimitsClient {
  /** Never rejects. */
  read(): Promise<CodexUsageSnapshot>;
  /** Resolves once the child (if any) has actually exited; SIGKILLs it after the grace. Never rejects. */
  dispose(): Promise<void>;
}

function defaultSpawn(
  file: string,
  args: readonly string[],
  options: SpawnOptionsLite,
): ChildProcess {
  return spawn(file, [...args], { ...options, env: { ...options.env } });
}

function unavailable(reason: CodexUsageUnavailableReason, atMs: number): CodexUsageSnapshot {
  return {
    kind: "unavailable",
    reason,
    version: null,
    observedAt: new Date(atMs).toISOString(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createRateLimitsClient(deps: RateLimitsClientDeps): RateLimitsClient {
  const now = deps.now ?? Date.now;
  const spawnChild = deps.spawn ?? defaultSpawn;
  const capMs = deps.capMs ?? RATE_LIMITS_READ_CAP_MS;
  const killWaitMs = deps.killWaitMs ?? RATE_LIMITS_KILL_WAIT_MS;
  const disposeGraceMs = deps.disposeGraceMs ?? RATE_LIMITS_DISPOSE_GRACE_MS;
  const lineCap = deps.lineCapBytes ?? RATE_LIMITS_LINE_CAP_BYTES;
  const totalCap = deps.totalCapBytes ?? RATE_LIMITS_TOTAL_CAP_BYTES;

  let inFlight: Promise<CodexUsageSnapshot> | null = null;
  let abortCurrent: (() => void) | null = null;
  let disposed = false;
  let disposing: Promise<void> | null = null;

  function childEnv(path: string): Record<string, string> {
    return codexChildEnv({
      executablePath: path,
      codexHome: deps.codexHome?.() ?? null,
      home: (deps.homeDir ?? homedir)(),
    });
  }

  function failed(code: string): CodexUsageSnapshot {
    deps.logger?.warn({ reason: code }, "codex usage read failed");
    return unavailable("read-failed", now());
  }

  function runOnce(): Promise<CodexUsageSnapshot> {
    if (disposed) return Promise.resolve(failed("disposed"));
    const path = deps.executablePath();
    if (path === null) return Promise.resolve(failed("no-executable"));
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawnChild(path, ["app-server"], {
          shell: false,
          stdio: ["pipe", "pipe", "ignore"],
          env: childEnv(path),
          windowsHide: true,
        });
      } catch {
        resolve(failed("spawn-failed"));
        return;
      }
      let result: CodexUsageSnapshot | null = null;
      let exited = false;
      let escalating = false;
      let phase: "initialize" | "read" = "initialize";
      let totalBytes = 0;
      let pending: Buffer[] = [];
      let pendingBytes = 0;
      let escalateTimer: ReturnType<typeof setTimeout> | undefined;
      let backstopTimer: ReturnType<typeof setTimeout> | undefined;

      const clearTeardownTimers = (): void => {
        clearTimeout(escalateTimer);
        clearTimeout(backstopTimer);
      };
      const done = (): void => {
        clearTimeout(capTimer);
        clearTeardownTimers();
        abortCurrent = null;
        if (result !== null) resolve(result);
      };
      /** Records the outcome, then ends the child: default signal, wait, escalate. */
      const settle = (snapshot: CodexUsageSnapshot, graceMs: number = killWaitMs): void => {
        if (result !== null) return;
        result = snapshot;
        clearTimeout(capTimer);
        try {
          child.stdin?.end();
        } catch {
          // The child may already be gone.
        }
        if (exited) {
          done();
          return;
        }
        try {
          child.kill();
        } catch {
          // Already gone; the exit event follows.
        }
        scheduleEscalation(graceMs);
      };
      const escalate = (): void => {
        escalating = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
        backstopTimer = setTimeout(done, killWaitMs);
      };
      const scheduleEscalation = (graceMs: number): void => {
        clearTimeout(escalateTimer);
        escalateTimer = setTimeout(escalate, graceMs);
      };
      /** dispose(): end a pending read now, or shorten the SIGTERM wait of one that already settled. */
      const abort = (): void => {
        if (result === null) fail("disposed", disposeGraceMs);
        else if (!exited && !escalating) scheduleEscalation(Math.min(disposeGraceMs, killWaitMs));
      };
      const fail = (code: string, graceMs?: number): void => {
        if (result === null) settle(failed(code), graceMs);
      };

      const capTimer = setTimeout(() => fail("timeout"), capMs);
      abortCurrent = abort;

      child.on("error", () => {
        if (child.pid === undefined) {
          exited = true;
          fail("spawn-error");
          done();
        } else {
          fail("child-error");
        }
      });
      child.on("exit", () => {
        exited = true;
        fail("exited-early");
        done();
      });
      child.stdin?.on("error", () => fail("stdin-error"));

      const send = (message: unknown): void => {
        try {
          child.stdin?.write(`${JSON.stringify(message)}\n`);
        } catch {
          fail("write-failed");
        }
      };

      const handleLine = (line: string): void => {
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (!isRecord(message)) return;
        if (message.id === 1 && phase === "initialize") {
          if (message.error) {
            fail("initialize-error");
            return;
          }
          phase = "read";
          send({ method: "initialized" });
          send({
            id: 2,
            method: "account/rateLimits/read",
            params: { excludeResetCreditDetails: true, supportsLunaReserve: false },
          });
        } else if (message.id === 2 && phase === "read") {
          if (message.error) {
            fail("read-error");
            return;
          }
          settle(normalizeRateLimitsReply(message.result, { observedAtMs: now() }));
        }
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        if (result !== null) return;
        totalBytes += chunk.length;
        if (totalBytes > totalCap) {
          fail("total-cap");
          return;
        }
        let start = 0;
        for (;;) {
          const nl = chunk.indexOf(0x0a, start);
          const end = nl === -1 ? chunk.length : nl;
          pending.push(chunk.subarray(start, end));
          pendingBytes += end - start;
          if (pendingBytes > lineCap) {
            fail("line-cap");
            return;
          }
          if (nl === -1) return;
          const line = Buffer.concat(pending).toString("utf8").trim();
          pending = [];
          pendingBytes = 0;
          if (line.length > 0) handleLine(line);
          if (result !== null) return;
          start = nl + 1;
        }
      });

      send({
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: CLIENT_NAME, title: null, version: "1.0.0" } },
      });
    });
  }

  return {
    read() {
      if (inFlight !== null) return inFlight;
      const attempt = runOnce().finally(() => {
        if (inFlight === attempt) inFlight = null;
      });
      inFlight = attempt;
      return attempt;
    },
    dispose() {
      disposing ??= (async () => {
        disposed = true;
        const running = inFlight;
        abortCurrent?.();
        if (running !== null)
          await running.then(
            () => undefined,
            () => undefined,
          );
      })();
      return disposing;
    },
  };
}
