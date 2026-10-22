import { useCallback, useEffect, useState } from "preact/hooks";
import type { ConnectionState } from "../connection-state.js";
import type { ScanActions } from "../projects/projects-actions.js";
import { applyScanState } from "../projects/scan-state.js";

/**
 * Where the scan state's first load stands:
 *
 * - `idle`: no read has started (the service is not live yet, or the view just mounted);
 * - `loading`: a read is in flight and nothing has been received;
 * - `ready`: the state arrived and was applied to the shared `scanState` signal;
 * - `failed`: the read answered with a failure (the shared signal is left as it was).
 *
 * Never "empty": an empty scan state is a successful answer, so it is `ready`.
 */
export type ScanLoadPhase = "idle" | "loading" | "ready" | "failed";

/** What {@link useScanState} returns: where the first load stands, and a way to ask again. */
export interface ScanState {
  readonly phase: ScanLoadPhase;
  /** Reads the state once more (the `Try again` after a failed read). A no-op unless live. */
  readonly reload: () => void;
}

/**
 * Reads the scan folders and suggestions the service holds, shared by the Projects destination
 * and the Settings Projects section (plan 08-11, Task 2).
 *
 * The state is read once when the surface opens and again each time the service comes back (a
 * restart forgets every suggestion, D-07), never on a timer: scans themselves run only on the
 * owner's request. A live connection is required, so opening the surface while the service is
 * still connecting does not spend the read on a request that cannot be answered. The answer goes
 * into the shared `scanState` signal (memory only, D-43); this hook returns only the phase.
 * `actions` is a stable host-built object, not a dependency to track.
 */
export function useScanState(actions: ScanActions, connection: ConnectionState): ScanState {
  const [phase, setPhase] = useState<ScanLoadPhase>("idle");
  // Bumped by `reload`, so a failed read can be asked for again without remounting the surface.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (connection.kind !== "live") return;
    let cancelled = false;
    // A re-read after a reconnect keeps showing what it already had.
    setPhase((current) => (current === "ready" ? "ready" : "loading"));
    void actions.listScanState().then(
      (outcome) => {
        if (cancelled) return;
        if (outcome.kind === "state") {
          applyScanState(outcome.state);
          setPhase("ready");
        } else {
          setPhase("failed");
        }
      },
      () => {
        if (!cancelled) setPhase("failed");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [connection.kind, attempt]);
  const reload = useCallback(() => setAttempt((count) => count + 1), []);
  return { phase, reload };
}
