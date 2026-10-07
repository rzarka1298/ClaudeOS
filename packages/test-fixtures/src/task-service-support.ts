import type { GeneratedTaskVault } from "./task-fixtures.js";

/**
 * Support for the plan 06-25 integration suites that drive the REAL built
 * service over its socket against a generated task vault. Test code only.
 */

export interface TaskServiceReply<T> {
  readonly status: number;
  readonly body: T;
}

export interface TaskServiceSession {
  readonly dir: string;
  readonly socketPath: string;
  /** An authenticated POST with a JSON body. */
  post<T>(path: string, body: unknown): Promise<TaskServiceReply<T>>;
  /** Stops the service, starts it again on the same runtime directory and answers how long the first counts request took from the start. */
  restart(): Promise<{ readonly firstCountsMs: number }>;
  /** Resident set size of the running service in kilobytes. */
  rssKb(): number;
  /** The service's own log lines, parsed. */
  logLines(): Record<string, unknown>[];
  /** Opens one event subscription; resolves the events it saw once closed. */
  collectEvents(): { readonly events: { readonly type: string }[]; close(): void };
  /** Stops the service and removes the throwaway runtime directory and Keychain account. */
  close(): Promise<void>;
}

export interface TaskServiceOptions {
  /** True: register the vault and restart, so the boot walk fills the index. False: register only; the index stays empty until a rebuild. */
  readonly bootWalk: boolean;
}

const NOT_IMPLEMENTED = "task service support is not implemented yet (RED)";

/** Starts the real service on a throwaway runtime directory with the vault registered. Call `close()` when done. */
export async function startTaskService(
  _vault: GeneratedTaskVault,
  _options: TaskServiceOptions,
): Promise<TaskServiceSession> {
  throw new Error(NOT_IMPLEMENTED);
}

/** {@link startTaskService} with the teardown guaranteed. */
export async function withTaskService<T>(
  vault: GeneratedTaskVault,
  options: TaskServiceOptions,
  fn: (session: TaskServiceSession) => Promise<T>,
): Promise<T> {
  const session = await startTaskService(vault, options);
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}
