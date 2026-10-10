import { type ChildProcess, spawn } from "node:child_process";
import { homedir } from "node:os";
import { normalizeRateLimitsReply } from "@ccc/collectors";
import type { CodexUsageSnapshot, CodexUsageUnavailableReason } from "@ccc/domain";

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

/** Fixed child PATH; it holds no Node, so tests use an absolute interpreter. */
const CHILD_PATH = "/usr/bin:/bin";

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
  dispose(): void;
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

  function childEnv(): Record<string, string> {
    const env: Record<string, string> = {
      HOME: (deps.homeDir ?? homedir)(),
      PATH: CHILD_PATH,
      LC_ALL: "C",
    };
    const codexHome = deps.codexHome?.() ?? null;
    if (codexHome !== null && codexHome.length > 0) env.CODEX_HOME = codexHome;
    return env;
  }

  function runOnce(): Promise<CodexUsageSnapshot> {
    const path = deps.executablePath();
    if (path === null) {
      deps.logger?.warn({ reason: "no-executable" }, "codex usage read skipped");
      return Promise.resolve(unavailable("read-failed", now()));
    }
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawnChild(path, ["app-server"], {
          shell: false,
          stdio: ["pipe", "pipe", "ignore"],
          env: childEnv(),
          windowsHide: true,
        });
      } catch {
        deps.logger?.warn({ reason: "spawn-failed" }, "codex usage read failed");
        resolve(unavailable("read-failed", now()));
        return;
      }
      let result: CodexUsageSnapshot | null = null;
      let exited = false;
      let phase: "initialize" | "read" = "initialize";
      let pending = "";

      const send = (message: unknown): void => {
        try {
          child.stdin?.write(`${JSON.stringify(message)}\n`);
        } catch {
          settle(unavailable("read-failed", now()));
        }
      };
      const finishWhenGone = (): void => {
        if (exited && result !== null) resolve(result);
      };
      const settle = (snapshot: CodexUsageSnapshot): void => {
        if (result !== null) return;
        result = snapshot;
        try {
          child.stdin?.end();
        } catch {
          // The child may already be gone.
        }
        try {
          child.kill();
        } catch {
          // Already gone.
        }
        finishWhenGone();
      };

      child.on("error", () => {
        exited = true;
        settle(unavailable("read-failed", now()));
        finishWhenGone();
      });
      child.on("exit", () => {
        exited = true;
        settle(unavailable("read-failed", now()));
        finishWhenGone();
      });
      child.stdin?.on("error", () => settle(unavailable("read-failed", now())));

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
            settle(unavailable("read-failed", now()));
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
            settle(unavailable("read-failed", now()));
            return;
          }
          settle(normalizeRateLimitsReply(message.result, { observedAtMs: now() }));
        }
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        if (result !== null) return;
        pending += chunk.toString("utf8");
        for (let nl = pending.indexOf("\n"); nl >= 0; nl = pending.indexOf("\n")) {
          const line = pending.slice(0, nl).trim();
          pending = pending.slice(nl + 1);
          if (line.length > 0) handleLine(line);
          if (result !== null) return;
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
    read: () => runOnce(),
    dispose() {},
  };
}
