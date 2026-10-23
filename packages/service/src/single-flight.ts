/**
 * At most one outstanding operation per key (FIX6A Codex-1). A file-system call on a stalled mount
 * cannot be cancelled and holds a libuv thread-pool thread until the mount answers; the health
 * probes abandon it at their cap. A later check that asked again would hold another thread per
 * check until the pool is exhausted, so while one call is outstanding a new caller shares its
 * pending promise and starts nothing. Once the call settles the entry is dropped and the next
 * caller starts fresh.
 *
 * The shared work takes no caller's signal: each caller handles its own cancellation by racing the
 * shared promise ({@link raceSignal}), so one caller giving up never cancels what another is
 * waiting for. No file-system import: this module only keeps the table.
 */
export interface SingleFlight {
  run<T>(key: string, start: () => Promise<T>): Promise<T>;
}

export function createSingleFlight(): SingleFlight {
  const pending = new Map<string, Promise<unknown>>();
  return {
    run<T>(key: string, start: () => Promise<T>): Promise<T> {
      const shared = pending.get(key);
      if (shared !== undefined) return shared as Promise<T>;
      let call: Promise<T>;
      try {
        call = start();
      } catch (error) {
        call = Promise.reject(error);
      }
      const clear = (): void => {
        if (pending.get(key) === call) pending.delete(key);
      };
      pending.set(key, call);
      call.then(clear, clear);
      return call;
    },
  };
}

/**
 * One single-flight table per owner object, so a test double never shares state with the real
 * calls (the owner is the injected fs port, or a module-level token for the real one).
 */
export function singleFlightFor(
  owners: WeakMap<object, SingleFlight>,
  owner: object,
): SingleFlight {
  let table = owners.get(owner);
  if (table === undefined) {
    table = createSingleFlight();
    owners.set(owner, table);
  }
  return table;
}

/**
 * Resolves with the shared promise's value, or with `onAbort()` as soon as this caller's signal
 * fires. The shared call is not cancelled (it cannot be); its result is dropped for this caller.
 */
export function raceSignal<T>(
  shared: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort: () => T,
): Promise<T> {
  if (signal === undefined) return shared;
  if (signal.aborted) {
    // Keep a rejection of the abandoned call from surfacing as unhandled.
    shared.catch(() => undefined);
    return Promise.resolve(onAbort());
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => resolve(onAbort());
    signal.addEventListener("abort", abort, { once: true });
    shared.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
