/**
 * The service's graceful shutdown (D-09, wave-5 Codex review).
 *
 * Order: approvals first (the sweeper stops, every execution already running
 * is awaited), then usage, then the Claude services, and only then the store
 * closes and the process exits. `exit` is therefore never called while an
 * approval execution is in flight.
 *
 * Every other timer in the service is unreferenced and the listener closes at
 * once, so a drain that waits on an unreferenced termination timer could let
 * Node leave its event loop empty and exit mid-execution. A REFERENCED
 * keep-alive handle is held until the drain has finished; a second signal is a
 * no-op (it never exits early).
 */
export interface ShutdownDeps {
  readonly stopApprovals: () => Promise<void>;
  readonly stopUsage: () => Promise<void>;
  readonly stopClaude: () => Promise<void>;
  /** Stops intake: timers and collectors that must not run during the drain. */
  readonly stopIntake: () => void;
  /** Closes the listener; the callback runs once every open connection has ended. */
  readonly closeServer: (done: () => void) => void;
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
      .then(() => deps.stopUsage())
      .then(() => deps.stopClaude())
      .catch((err: unknown) => {
        deps.onError("shutdown: claude services did not stop cleanly", err);
      });
    deps.closeServer(() => {
      void drained.then(() => {
        deps.closeResources();
        keepAlive.stop(handle);
        deps.exit(0);
      });
    });
  };
}
