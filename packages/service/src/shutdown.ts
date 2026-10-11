/**
 * The service's graceful shutdown (D-09, wave-5 Codex review).
 *
 * Order: approvals first (the sweeper stops, every execution already running
 * is awaited), then the Codex services (Phase 05.1), then usage, then the Claude services, and only then the store
 * closes and the process exits. `exit` is therefore never called while an
 * approval execution is in flight.
 *
 * Every other timer in the service is unreferenced and the listener closes at
 * once, so a drain that waits on an unreferenced termination timer could let
 * Node leave its event loop empty and exit mid-execution. A REFERENCED
 * keep-alive handle is held until the drain has finished; a second signal is a
 * no-op (it never exits early).
 */
/** How long the shutdown waits for the Codex services to stop before it moves on (milliseconds). */
export const CODEX_STOP_DEADLINE_MS = 5_000;

export interface ShutdownDeps {
  readonly stopApprovals: () => Promise<void>;
  /**
   * Stops the Codex services (Phase 05.1): after the approvals, before the usage and Claude services,
   * so its scans and reads finish before the store closes. Optional: absent in an older composition.
   */
  readonly stopCodex?: () => Promise<void>;
  /** The wait bound on `stopCodex`; defaults to {@link CODEX_STOP_DEADLINE_MS}. Injectable for tests. */
  readonly codexStopDeadlineMs?: number;
  /** Reason-coded log line for a Codex stop that exceeded its deadline (never a raw error). */
  readonly onCodexStopTimeout?: (reason: string) => void;
  readonly stopUsage: () => Promise<void>;
  readonly stopClaude: () => Promise<void>;
  /** Stops intake: timers and collectors that must not run during the drain. */
  readonly stopIntake: () => void;
  /** Closes the listener; the callback runs once every open connection has ended. */
  readonly closeServer: (done: () => void) => void;
  /**
   * Ends event streams and closes idle connections so the listener can finish
   * closing. Called at shutdown start and again once the drain has finished; it
   * never aborts a request or an approval execution that is in flight.
   */
  readonly closeConnections?: () => void;
  /** Closes the store and removes the socket file. */
  readonly closeResources: () => void;
  readonly exit: (code: number) => void;
  readonly onError: (message: string, err: unknown) => void;
  /** A referenced timer that keeps the event loop alive. */
  readonly keepAlive?: {
    readonly start: () => unknown;
    readonly stop: (handle: unknown) => void;
  };
}

const realKeepAlive = {
  start: (): unknown => setInterval(() => undefined, 1_000),
  stop: (handle: unknown): void => clearInterval(handle as NodeJS.Timeout),
};

/**
 * Waits for `stopCodex` at most the deadline: a hung Codex step must never keep the usage and
 * Claude services from stopping, the store from closing or the process from exiting. A timeout
 * is reported by the fixed reason code `codex-stop-timeout`; the stop keeps running unawaited.
 */
async function boundedCodexStop(deps: ShutdownDeps): Promise<void> {
  if (deps.stopCodex === undefined) return;
  const stopping = deps.stopCodex();
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(
      () => resolve("timeout"),
      deps.codexStopDeadlineMs ?? CODEX_STOP_DEADLINE_MS,
    );
  });
  try {
    const outcome = await Promise.race([stopping.then(() => "done" as const), timedOut]);
    if (outcome === "timeout") {
      // A late rejection of the abandoned stop is not an error anyone can act on.
      stopping.catch(() => undefined);
      deps.onCodexStopTimeout?.("codex-stop-timeout");
    }
  } finally {
    clearTimeout(timer);
  }
}

export function createShutdown(deps: ShutdownDeps): () => void {
  const keepAlive = deps.keepAlive ?? realKeepAlive;
  let shuttingDown = false;
  return () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const handle = keepAlive.start();
    deps.stopIntake();
    const drained = deps
      .stopApprovals()
      .catch((err: unknown) => {
        deps.onError("shutdown: approval services did not stop cleanly", err);
      })
      .then(() => boundedCodexStop(deps))
      .catch((err: unknown) => {
        deps.onError("shutdown: codex services did not stop cleanly", err);
      })
      .then(() => deps.stopUsage())
      .catch((err: unknown) => {
        deps.onError("shutdown: usage services did not stop cleanly", err);
      })
      .then(() => deps.stopClaude())
      .catch((err: unknown) => {
        deps.onError("shutdown: claude services did not stop cleanly", err);
      })
      .then(() => deps.closeConnections?.());
    deps.closeServer(() => {
      void drained.then(() => {
        deps.closeResources();
        keepAlive.stop(handle);
        deps.exit(0);
      });
    });
    // After the listener stopped accepting: end the event streams now (they
    // would otherwise hold it open forever) and drop idle connections. A
    // request or execution in flight is untouched.
    deps.closeConnections?.();
  };
}
