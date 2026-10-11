import { access, constants, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  type LaunchErrorKind,
  type LaunchResult,
  parseStoredLauncherConfig,
  type TerminalLauncher,
  type TerminalLaunchInput,
} from "@ccc/domain";
import { createRunIdMinter, openInApp, validateAgentLaunchChecked } from "@ccc/launchers";
import { getLauncherConfig, type OperationalStore } from "@ccc/operational-store";
import {
  type AgentBridgeRequest,
  type AgentPins,
  type WithdrawResult,
  waitForClaim,
  withdrawRequest,
  writeAgentPins,
  writeBridgeRequest,
} from "../codex/bridge-queue.js";
import {
  type BridgeStatus,
  type BridgeWindow,
  coveringWindows,
  hasAgentCapability,
  readBridgeStatus,
} from "../codex/bridge-state.js";
import type { Spawner } from "./spawner.js";

/**
 * The Antigravity terminal (plan 05.1-13, D-01, D-07, D-08, D-09, OQ-1): a third
 * {@link TerminalLauncher} behind the existing port, so Claude Code start, Phase 5 resume and
 * branch, the launcher Test step and the Codex half of the pair all reach it through the one
 * `selectTerminalLauncher` and inherit the 4 s cap, the in-flight dedupe and the concurrent-write
 * guard. It opens a tab in the project's Antigravity window by writing a validated request into
 * the codex-bridge queue and waiting for the extension's claim; "handed off" means the claimed
 * file for that run id appeared.
 *
 * What a launch does, in order, and what each refusal writes (nothing):
 *
 * 1. The agent is derived from the basename of `argv[0]` (`claude` or `codex`; anything else is
 *    `spawn-failed`) and the plan 05.1-09 validator runs on the exact final argv, with the
 *    executable check following symlinks and every directory argument realpath-contained.
 * 2. `argv[0]` must be the executable the saved launcher row names (the helper enforces the same
 *    pin from `agent-pins.json`, which is written just before the first request).
 * 3. The bridge is classified: no launcher is `bridge-not-installed`; ANY window covering the
 *    project that cannot claim agent requests (the installed 0.1.0 extension deletes requests it
 *    does not understand), or a kit marker without the agent capability when no window covers it,
 *    is `bridge-outdated`. Both are decided BEFORE a request exists.
 * 4. With no window covering the project, the saved Antigravity bundle must be the IDE app
 *    (`launcher-not-configured` otherwise) and is opened on the project once (single flight per
 *    directory, so the pair's two halves share it).
 * 5. The wait for the claim ends at the adapter deadline, which is below the pipeline cap by
 *    construction so this adapter's typed error wins over the generic timeout. On the deadline the
 *    request is withdrawn; a claim that landed first is a hand-off after all.
 *
 * The adapter never starts a shell, never signals a process, and logs reason codes only.
 */

/** The IDE app the bridge extension lives in; the other Antigravity app cannot host it. */
export const ANTIGRAVITY_IDE_BUNDLE_ID = "com.google.antigravity-ide";

/** The longest the adapter waits for a claim. */
export const MAX_ADAPTER_DEADLINE_MS = 3500;
/** How far below the pipeline cap the adapter's own deadline sits. */
export const DEADLINE_MARGIN_MS = 500;
/** The cap the launch pipeline uses (`LAUNCH_CAP_MS`), repeated here to avoid an import cycle. */
const DEFAULT_CAP_MS = 4000;
/** Run ids that collide (a second process minted the same millisecond) are retried this often. */
const MAX_MINT_ATTEMPTS = 5;
/** The product-to-bridge run id map is bounded; the oldest entry is evicted first. */
export const RUN_MAP_LIMIT = 64;

/** The smaller of 3500 ms and the cap minus 500 ms, never negative. */
export function adapterDeadlineMs(capMs: number): number {
  return Math.max(0, Math.min(MAX_ADAPTER_DEADLINE_MS, capMs - DEADLINE_MARGIN_MS));
}

export interface AntigravityTerminalDeps {
  /** The bridge state as the service sees it (see `readBridgeStatus`). */
  readonly readStatus: () => BridgeStatus | Promise<BridgeStatus>;
  /** The fresh windows that have `projectRoot` open. */
  readonly windowsCovering: (
    status: BridgeStatus,
    projectRoot: string,
  ) => readonly BridgeWindow[] | Promise<readonly BridgeWindow[]>;
  /** The saved Antigravity launcher's bundle id, read on each call so a later save takes effect. */
  readonly savedBundleId: () => string | null;
  /** The executables the saved Claude Code and Codex launcher rows name (an absent row is absent). */
  readonly savedExecutables: () => AgentPins;
  /** The cold-start open goes through the existing process port. */
  readonly spawner: Spawner;
  /** Injected clock (tests); defaults to `Date.now`. */
  readonly now?: () => number;
  /** Injected sleep (tests); the default ends early when the signal fires. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** The strictly increasing run id minter shared by every caller in the process. */
  readonly mintRunId: () => string;
  /** The validator's executable check: an existing regular file with an execute bit (follows symlinks). */
  readonly isExecutable: (path: string) => boolean | Promise<boolean>;
  /** The validator's directory check: the real path when `path` (relative to `base`) is a directory. */
  readonly realDir: (path: string, base: string) => string | null | Promise<string | null>;
  /** The pipeline cap the adapter's deadline sits below; defaults to 4000 ms. */
  readonly capMs?: number;
  /** Time between looks at the claimed directory. */
  readonly pollMs?: number;
  /** Reason codes only: never a path, an argument or an environment value. */
  readonly log?: (reason: string) => void;
  /** Test seam for the request writer; defaults to {@link writeBridgeRequest}. */
  readonly writeRequest?: typeof writeBridgeRequest;
  /** Test seam for the withdraw race; defaults to {@link withdrawRequest}. */
  readonly withdraw?: (stateDir: string, runId: string) => WithdrawResult | Promise<WithdrawResult>;
}

/** The real-filesystem checks the launch validator asks for. */
export const defaultAgentChecks: Pick<AntigravityTerminalDeps, "isExecutable" | "realDir"> = {
  async isExecutable(path) {
    try {
      if (!(await stat(path)).isFile()) return false;
      await access(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  async realDir(path, base) {
    try {
      const real = await realpath(resolve(base, path));
      return (await stat(real)).isDirectory() ? real : null;
    } catch {
      return null;
    }
  },
};

// ---------------------------------------------------------------------------
// Process-wide state: the run id minter, the cold-start single flight, the run id map

/** One minter for the whole process, so two call sites cannot mint colliding ids. */
const sharedMinter = createRunIdMinter(Date.now);

/**
 * The process-wide minter of strictly increasing bridge run ids, for the one other writer of bridge
 * requests (the follow-log service, plan 05.1-28): two writers must never mint colliding ids.
 */
export function mintSharedBridgeRunId(): string {
  return sharedMinter();
}

type OpenOutcome = { readonly ok: true } | { readonly ok: false; readonly error: LaunchErrorKind };

/** An open of the IDE on a directory that has been issued and whose initiator is still waiting. */
const openInFlight = new Map<string, Promise<OpenOutcome>>();

const bridgeRunIds = new Map<string, string>();

/** Remembers which bridge run id a product run id was queued as (bounded; stores no path). */
export function rememberBridgeRun(productRunId: string, bridgeRunId: string): void {
  bridgeRunIds.delete(productRunId);
  bridgeRunIds.set(productRunId, bridgeRunId);
  while (bridgeRunIds.size > RUN_MAP_LIMIT) {
    const oldest = bridgeRunIds.keys().next();
    if (oldest.done === true) break;
    bridgeRunIds.delete(oldest.value);
  }
}

/** The bridge run id a product run id was queued as, or `null` when unknown or evicted. */
export function bridgeRunIdFor(productRunId: string): string | null {
  return bridgeRunIds.get(productRunId) ?? null;
}

// ---------------------------------------------------------------------------
// The adapter

const fail = (error: LaunchErrorKind): LaunchResult => ({ ok: false, error });

function agentOf(argv: readonly string[]): "claude" | "codex" | null {
  const first = argv[0];
  if (typeof first !== "string") return null;
  const name = first.slice(first.lastIndexOf("/") + 1);
  return name === "claude" || name === "codex" ? name : null;
}

interface LaunchState {
  cancelled: boolean;
  phase: "prep" | "wait";
  bridge: { dir: string; runId: string } | null;
  firstRunId: string | null;
}

export function createAntigravityTerminalLauncher(deps: AntigravityTerminalDeps): TerminalLauncher {
  const now = deps.now ?? Date.now;
  const capMs = deps.capMs ?? DEFAULT_CAP_MS;
  const withdraw = deps.withdraw ?? withdrawRequest;
  const writeRequest = deps.writeRequest ?? writeBridgeRequest;
  const log = (reason: string): void => deps.log?.(reason);

  /** Opens the IDE on `cwd`; the saved bundle was checked by the caller. */
  async function openIde(bundleId: string, cwd: string, timeoutMs: number): Promise<OpenOutcome> {
    try {
      const outcome = await deps.spawner.run(openInApp(bundleId, cwd), {
        timeoutMs: Math.max(1, timeoutMs),
      });
      if (outcome.exitCode === 0 && !outcome.timedOut) return { ok: true };
      return {
        ok: false,
        error: outcome.stderrClass === "bundle-not-found" ? "app-not-found" : "spawn-failed",
      };
    } catch {
      return { ok: false, error: "spawn-failed" };
    }
  }

  /**
   * Writes the request, retrying with the next id when a name is already taken. A write that
   * completes after the launch gave up (`state.cancelled`) is taken straight back.
   */
  async function queue(
    stateDir: string,
    base: Omit<AgentBridgeRequest, "runId" | "createdAt">,
    state: LaunchState,
  ): Promise<string | null> {
    for (let attempt = 0; attempt < MAX_MINT_ATTEMPTS; attempt += 1) {
      if (state.cancelled) return null;
      // The first id was minted when the launch was called, so request order is call order (the
      // pair's Claude half stays first) however the async checks of two launches interleave.
      const runId = state.firstRunId ?? deps.mintRunId();
      state.firstRunId = null;
      let written: string | null;
      // Recorded the instant THIS write publishes (and not before: until then the name may belong
      // to another launch), so the timeout handler can withdraw it while the writer settles.
      try {
        written = await writeRequest(
          stateDir,
          { ...base, runId, createdAt: new Date(now()).toISOString() },
          {
            isCancelled: () => state.cancelled,
            onPublished: () => {
              state.bridge = { dir: stateDir, runId };
            },
          },
        );
      } catch {
        // A published request (state.bridge set by onPublished) stays withdrawable.
        log("request-write-failed");
        return null;
      }
      if (written !== null && state.cancelled) {
        try {
          await withdraw(stateDir, runId);
        } catch {
          // Best effort: the request carries a validated, pinned argv either way.
        }
        return null;
      }
      if (written !== null) return runId;
      // Nothing of ours is queued (name taken, or the writer took its own request back).
      state.bridge = null;
      log("run-id-collision");
    }
    return null;
  }

  /**
   * Every filesystem call here is asynchronous, but an async call on a stalled volume (or behind a
   * macOS permission prompt) may simply never settle. The launch therefore races the whole body
   * against the adapter deadline: before a request exists the typed answer is `timeout` and nothing
   * is written; once it is queued the body's own claim wait owns the deadline, and this timer only
   * backstops a poll or a withdraw that stalls (a short grace after the deadline).
   */
  const WAIT_GRACE_MS = DEADLINE_MARGIN_MS / 2;
  const WITHDRAW_GRACE_MS = 150;

  async function launchBody(
    input: TerminalLaunchInput,
    deadlineAt: number,
    state: LaunchState,
  ): Promise<LaunchResult> {
    if (input.signal.aborted) return fail("timeout");

    // 1. The agent and the validator, before anything is read or written.
    const agent = agentOf(input.argv);
    if (agent === null) {
      log("refused:agent-name");
      return fail("spawn-failed");
    }
    const env = input.env ?? {};
    const verdict = await validateAgentLaunchChecked(
      { agent, argv: input.argv, env, projectRoot: input.cwd, cwd: input.cwd },
      { isExecutable: deps.isExecutable, realDir: deps.realDir },
    );
    if (!verdict.ok) {
      log(`refused:${verdict.reason}`);
      return fail("spawn-failed");
    }
    if (input.signal.aborted) return fail("timeout");

    // 2. The executable must be the one the saved launcher row names.
    const saved = deps.savedExecutables();
    if (state.cancelled) return fail("timeout");
    const pinned = saved[agent];
    if (pinned === undefined) {
      log("refused:no-saved-launcher");
      return fail("launcher-not-configured");
    }
    if (input.argv[0] !== pinned) {
      log("refused:pin-mismatch");
      return fail("spawn-failed");
    }

    // 3. The bridge, classified before a request exists.
    const status = await deps.readStatus();
    if (state.cancelled) return fail("timeout");
    if (!status.launcherPresent || !status.launchable) {
      log("bridge-not-installed");
      return fail("bridge-not-installed");
    }
    const covering = await deps.windowsCovering(status, verdict.projectRoot);
    if (state.cancelled) return fail("timeout");
    // Every fresh window shares the one queue, and an old extension deletes agent requests it
    // cannot claim, so a window on ANOTHER project that lacks the capability is just as fatal.
    if (status.windows.some((window) => !hasAgentCapability(window))) {
      log("bridge-outdated:window");
      return fail("bridge-outdated");
    }
    const cold = covering.length === 0;
    if (cold) {
      const kitCapable =
        status.protocol !== null || status.capabilities !== null
          ? hasAgentCapability(status)
          : status.windows.some((window) => hasAgentCapability(window));
      if (!kitCapable) {
        log("bridge-outdated:kit");
        return fail("bridge-outdated");
      }
      // 4. Cold start needs the IDE app saved as the Antigravity launcher.
      if (deps.savedBundleId() !== ANTIGRAVITY_IDE_BUNDLE_ID) {
        log("launcher-not-configured:bundle");
        return fail("launcher-not-configured");
      }
    }

    // 5. Queue the request.
    if (state.cancelled) return fail("timeout");
    if (!(await writeAgentPins(status.dir, saved))) {
      log("pins-write-failed");
      return fail("spawn-failed");
    }
    const runId = await queue(
      status.dir,
      {
        kind: "agent",
        mode: "agent",
        agent,
        projectRoot: verdict.projectRoot,
        cwd: verdict.cwd,
        argv: [...input.argv],
        env: { ...env },
        sessionId: null,
        liveLog: null,
        pid: null,
        protocol: 2,
      },
      state,
    );
    if (runId === null) return fail(state.cancelled ? "timeout" : "spawn-failed");
    state.phase = "wait";
    state.bridge = { dir: status.dir, runId };
    const productRunId = env.CCC_RUN_ID;
    if (productRunId !== undefined) rememberBridgeRun(productRunId, runId);

    let ownedKey: string | null = null;
    let ownedOpen: Promise<OpenOutcome> | undefined;
    try {
      if (cold) {
        const key = verdict.cwd;
        let open = openInFlight.get(key);
        if (open === undefined) {
          open = openIde(ANTIGRAVITY_IDE_BUNDLE_ID, key, deadlineAt - now());
          openInFlight.set(key, open);
          ownedKey = key;
          ownedOpen = open;
        } else {
          log("cold-start:joined");
        }
        const opened = await open;
        if (!opened.ok) {
          await withdraw(status.dir, runId);
          log(`cold-start:${opened.error}`);
          return fail(opened.error);
        }
      }

      // The wait: the claimed file is the hand-off.
      const waited = await waitForClaim(status.dir, runId, {
        deadlineMs: Math.max(0, deadlineAt - now()),
        signal: input.signal,
        now,
        ...(deps.pollMs === undefined ? {} : { pollMs: deps.pollMs }),
        ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
      });
      if (waited === "claimed") return { ok: true };
      if (waited === "aborted") {
        await withdraw(status.dir, runId);
        log("aborted");
        return fail("timeout");
      }
      // Deadline: take the request back; a claim that landed first is a hand-off after all.
      if ((await withdraw(status.dir, runId)) === "claimed") return { ok: true };
      log("window-not-ready");
      return fail("window-not-ready");
    } finally {
      if (ownedKey !== null && openInFlight.get(ownedKey) === ownedOpen) {
        openInFlight.delete(ownedKey);
      }
    }
  }

  return {
    async launch(input: TerminalLaunchInput): Promise<LaunchResult> {
      const deadlineAt = now() + adapterDeadlineMs(capMs);
      const state: LaunchState = {
        cancelled: false,
        phase: "prep",
        bridge: null,
        firstRunId: deps.mintRunId(),
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const backstop = new Promise<LaunchResult>((resolveBackstop) => {
        const giveUp = (): void => {
          state.cancelled = true;
          log(state.phase === "prep" ? "stalled:prepare" : "stalled:wait");
          const failure = fail(state.phase === "prep" ? "timeout" : "window-not-ready");
          if (state.bridge === null) {
            resolveBackstop(failure);
            return;
          }
          // Take the request back; one the extension claimed first is a hand-off after all. A
          // withdraw that itself stalls only delays the answer by a short grace.
          const { dir, runId } = state.bridge;
          let settled = false;
          const finish = (result: LaunchResult): void => {
            if (settled) return;
            settled = true;
            clearTimeout(graceTimer);
            resolveBackstop(result);
          };
          const graceTimer = setTimeout(() => finish(failure), WITHDRAW_GRACE_MS);
          void Promise.resolve()
            .then(() => withdraw(dir, runId))
            .then(
              (outcome) => finish(outcome === "claimed" ? { ok: true } : failure),
              () => finish(failure),
            );
        };
        const arm = (delay: number, graceOnly: boolean): void => {
          timer = setTimeout(
            () => {
              if (state.phase === "prep" || graceOnly) giveUp();
              else arm(WAIT_GRACE_MS, true);
            },
            Math.max(0, delay),
          );
        };
        arm(deadlineAt - now(), false);
        onAbort = () => {
          if (state.phase === "prep") giveUp();
        };
        input.signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        return await Promise.race([launchBody(input, deadlineAt, state), backstop]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (onAbort !== undefined) input.signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Production wiring

export interface CreateAntigravityDepsOptions {
  readonly store: OperationalStore;
  readonly spawner: Spawner;
  /** The service's own environment; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The owner's home directory; defaults to `os.homedir()`. */
  readonly home?: string;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly capMs?: number;
}

/**
 * The adapter's dependencies built from the saved launcher rows (read on each call, so a later
 * save takes effect), the service environment and home, the real clock and the SHARED run id
 * minter. Every call site passes `antigravity: createAntigravityDeps({ store, spawner })` to
 * `selectTerminalLauncher`.
 */
export function createAntigravityDeps(
  options: CreateAntigravityDepsOptions,
): AntigravityTerminalDeps {
  const { store } = options;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const now = options.now ?? Date.now;
  return {
    readStatus: () => readBridgeStatus({ env, home, now }),
    windowsCovering: (status, projectRoot) => coveringWindows(status, projectRoot),
    savedBundleId: () => {
      const record = getLauncherConfig(store.db, "antigravity");
      return record === null
        ? null
        : (parseStoredLauncherConfig("antigravity", record.config)?.bundleId ?? null);
    },
    savedExecutables: () => {
      const claudeRow = getLauncherConfig(store.db, "claude-code");
      const codexRow = getLauncherConfig(store.db, "codex");
      const claude =
        claudeRow === null
          ? undefined
          : parseStoredLauncherConfig("claude-code", claudeRow.config)?.executablePath;
      const codex =
        codexRow === null
          ? undefined
          : parseStoredLauncherConfig("codex", codexRow.config)?.executablePath;
      return {
        ...(claude === undefined ? {} : { claude }),
        ...(codex === undefined ? {} : { codex }),
      };
    },
    spawner: options.spawner,
    now,
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    mintRunId: sharedMinter,
    ...defaultAgentChecks,
    ...(options.capMs === undefined ? {} : { capMs: options.capMs }),
  };
}
