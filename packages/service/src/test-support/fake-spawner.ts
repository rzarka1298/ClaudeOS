import type {
  DetachOptions,
  DetachOutcome,
  Spawner,
  SpawnOptions,
  SpawnOutcome,
} from "../projects/spawner.js";

/** One recorded `run` call: the argv and the options object exactly as passed. */
export interface RecordedSpawn {
  readonly argv: readonly string[];
  readonly opts: SpawnOptions;
}

/**
 * How the fake answers:
 * - `succeed` — exit 0 at once (after `delayMs`, when given);
 * - `hang` — never settles on its own; it settles only when the caller's
 *   abort signal fires (a hung LaunchServices hand-off);
 * - `fail` — resolves with the given outcome (defaults filled in).
 */
export type FakeSpawnMode =
  | { readonly kind: "succeed"; readonly delayMs?: number }
  | { readonly kind: "hang" }
  | { readonly kind: "fail"; readonly outcome: Partial<SpawnOutcome> };

/** One recorded `detach` call: the argv and the options object exactly as passed. */
export interface RecordedDetach {
  readonly argv: readonly string[];
  readonly opts: DetachOptions;
}

export interface FakeSpawner extends Spawner {
  readonly calls: RecordedSpawn[];
  /** Every `detach` call (a custom template that runs a terminal binary directly). */
  readonly detached: RecordedDetach[];
  /** What `detach` answers; defaults to "still running after the grace". */
  detachOutcome: DetachOutcome;
  /** Changes how later calls are answered. */
  mode: FakeSpawnMode;
  /** How many calls saw their abort signal fire. */
  readonly abortsObserved: number;
}

const OK_OUTCOME: SpawnOutcome = {
  exitCode: 0,
  errno: null,
  stderrClass: "none",
  timedOut: false,
};

const FAILED_OUTCOME: SpawnOutcome = {
  exitCode: 1,
  errno: null,
  stderrClass: "other",
  timedOut: false,
};

/**
 * A call-recording spawner double (D-41): the launch pipeline's only process
 * port, replaced wholesale so no test ever runs the real `/usr/bin/open`.
 */
export function createFakeSpawner(initial: FakeSpawnMode = { kind: "succeed" }): FakeSpawner {
  const calls: RecordedSpawn[] = [];
  const detached: RecordedDetach[] = [];
  let abortsObserved = 0;
  const fake: FakeSpawner = {
    calls,
    detached,
    detachOutcome: { kind: "running" },
    mode: initial,
    get abortsObserved() {
      return abortsObserved;
    },
    run(argv, opts) {
      calls.push({ argv: [...argv], opts });
      const mode = fake.mode;
      const signal = opts.signal;
      switch (mode.kind) {
        case "succeed": {
          const delayMs = mode.delayMs ?? 0;
          if (delayMs <= 0) return Promise.resolve(OK_OUTCOME);
          return new Promise((resolve) => setTimeout(() => resolve(OK_OUTCOME), delayMs));
        }
        case "hang":
          return new Promise((resolve) => {
            signal?.addEventListener(
              "abort",
              () => {
                abortsObserved += 1;
                resolve({
                  exitCode: null,
                  errno: "ABORT_ERR",
                  stderrClass: "none",
                  timedOut: false,
                });
              },
              { once: true },
            );
          });
        case "fail":
          return Promise.resolve({ ...FAILED_OUTCOME, ...mode.outcome });
      }
    },
    detach(argv, opts) {
      detached.push({ argv: [...argv], opts });
      return Promise.resolve(fake.detachOutcome);
    },
  };
  return fake;
}
