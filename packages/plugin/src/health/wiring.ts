import {
  DIAGNOSTICS_ERROR_CODES,
  type DiagnosticsErrorCode,
  type DiagnosticsHealthResponse,
  type HealthTrigger,
} from "@ccc/domain/diagnostics.js";
import type { HostRegistry } from "../host-registry.js";
import { configureHealth, HealthApiError } from "./api.js";
import { onHealthLive, resetHealthState, watchConnection } from "./state.js";

/**
 * Connects the Diagnostics code to Obsidian and the service (plan 08-13; D-02, D-05; the
 * `research/wiring.ts` precedent). `main.ts` passes the one function it owns,
 * `getDiagnosticsHealth(client, trigger)` from `@ccc/service-api-client`; this module never
 * imports the client package, and nothing under `health/` makes a network call itself.
 *
 * - The API holder is configured with that function behind the closed-code adapter: whatever the
 *   client throws, only a code from the closed vocabulary comes out, never a message.
 * - A connection watcher drops the held answer the moment the service is not live (D-03).
 * - `onLive` is the reconnect hook `main.ts` adds to `combineOnLive`: it refetches with the
 *   `reconnect` trigger and only while a Diagnostics section is mounted.
 *
 * All of it is released through the registry. A disposer only removes what its own wiring
 * installed, so a reload that loads before the previous unload has finished still ends with one
 * configuration and one watcher.
 */

export interface WireHealthDeps {
  /** The authenticated diagnostics client call (injected, never imported by value here). */
  readonly getHealth: (trigger: HealthTrigger) => Promise<DiagnosticsHealthResponse>;
}

export interface HealthWiring {
  /** The reconnect hook: refetch with `reconnect` when a section is mounted. */
  readonly onLive: () => void;
  /** Releases the configuration and the watcher this wiring installed. Safe to call twice. */
  readonly dispose: () => void;
}

const CLOSED_CODES: ReadonlySet<string> = new Set(DIAGNOSTICS_ERROR_CODES);

/** A code from the closed set when the error carries one, else `internal`; never its message. */
function closedCode(error: unknown): DiagnosticsErrorCode {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return typeof code === "string" && CLOSED_CODES.has(code)
    ? (code as DiagnosticsErrorCode)
    : "internal";
}

/** The wiring whose configuration is live, so a late disposer from an older wiring does nothing. */
let live: symbol | null = null;

export function wireHealth(registry: HostRegistry, deps: WireHealthDeps): HealthWiring {
  const mine = Symbol("health-wiring");
  configureHealth({
    api: {
      get: async (trigger) => {
        try {
          return await deps.getHealth(trigger);
        } catch (error) {
          throw new HealthApiError(closedCode(error));
        }
      },
    },
  });
  live = mine;
  const stopWatching = watchConnection();

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    stopWatching();
    // Only this wiring's own watcher is released unconditionally; a newer wiring keeps its answer.
    if (live === mine) {
      live = null;
      configureHealth(null);
      resetHealthState();
    }
  };
  registry.cleanup(dispose);
  return { onLive: onHealthLive, dispose };
}
