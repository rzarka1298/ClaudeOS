import { randomBytes } from "node:crypto";
import {
  type DiagnosticsHealthResponse,
  DiagnosticsHealthResponseSchema,
  type HealthTrigger,
  type ProbeOutcome,
  toBoundedDisplayPath,
} from "@ccc/domain";
import { logger } from "../logging.js";
import {
  asCachedResponse,
  createHealthCache,
  type NamedProbe,
  type Probe,
  type ProbeLogEntry,
  runProbes,
  type SubsystemRowId,
} from "./run-probes.js";
import { probeVault, type VaultProbePorts, vaultFingerprint } from "./vault-probe.js";

/**
 * The diagnostics services behind `GET /api/v1/diagnostics/health` (plan 08-07; D-02, D-04, D-05).
 *
 * Built in `main.ts` from narrow, optional ports, one per subsystem: a subsystem whose port is
 * absent reads `unknown` / `subsystem-not-wired`, never a guess (08-12 wires the hooks, collectors,
 * scheduler and launchers ports). A port is a probe: a function of an abort signal and the
 * trigger that returns a {@link ProbeOutcome} (a row without its check time and freshness).
 * Nothing here can launch, install, write or reach the network.
 */

/** The four probes 08-12 wires. The vault probe is built here from {@link DiagnosticsPorts.vault}. */
export type WiredProbeId = "hooks" | "collectors" | "scheduler" | "launchers";

/** What the service knows about itself. */
export interface DiagnosticsServiceFacts {
  /** The dotted service version, the same value the Phase 1 health route answers. */
  readonly version: string;
  /** The instant this process started, the same value the Phase 1 health route answers. */
  readonly startedAt: string;
  /** The store's schema version, or null when it cannot be read (never an invented number). */
  readonly storeSchemaVersion: () => number | null;
  /** The owner's home folder, for `~/...` display paths. */
  readonly homeDir: string;
  readonly runtimeDir: string;
  readonly socketPath: string;
}

export interface DiagnosticsPorts {
  /**
   * The persisted vault root, read fresh on each check (null when no vault has been set up; a throw reads
   * `probe-error`, FIX2A F9), plus
   * the probe's optional file-system and forbidden-root ports for tests. `salt` fixes the
   * fingerprint salt; by default one is drawn at random once per service.
   */
  readonly vault: VaultProbePorts & { readonly salt?: string | undefined };
  readonly hooks?: Probe | undefined;
  readonly collectors?: Probe | undefined;
  readonly scheduler?: Probe | undefined;
  readonly launchers?: Probe | undefined;
  readonly serviceFacts: DiagnosticsServiceFacts;
  readonly now: () => Date;
  /** Hears probes that did not answer (code and error class name only). Defaults to the service log. */
  readonly log?: ((entry: ProbeLogEntry) => void) | undefined;
  /**
   * A monotonic clock in milliseconds for the 2 second result cache (FIX2A m1). The wall clock can be
   * stepped (NTP, sleep, a manual change); a TTL measured on it can freeze a stale result for hours.
   * Defaults to `performance.now()`.
   */
  readonly monotonicNowMs?: (() => number) | undefined;
}

export interface DiagnosticsServices {
  /**
   * Runs the checks and answers the strict response. `trigger` says why (Amendment A1): only a
   * `gesture` may cause a probe to spawn `security`. Resolves, or rejects with an error the route
   * answers as the closed `internal` code.
   */
  check(trigger: HealthTrigger, signal?: AbortSignal): Promise<DiagnosticsHealthResponse>;
}

function notWired(id: SubsystemRowId): ProbeOutcome {
  return { id, status: "unknown", reasonCode: "subsystem-not-wired" } as ProbeOutcome;
}

function logProbe(entry: ProbeLogEntry): void {
  logger.warn(entry, "diagnostics probe did not answer");
}

/** The store's schema version, or null when the store cannot say (a throw is not an invented number). */
function storeSchemaVersionOrNull(facts: DiagnosticsServiceFacts): number | null {
  try {
    return facts.storeSchemaVersion();
  } catch {
    return null;
  }
}

export function createDiagnosticsServices(ports: DiagnosticsPorts): DiagnosticsServices {
  const { serviceFacts } = ports;
  const log = ports.log ?? logProbe;
  const cache = createHealthCache({ nowMs: ports.monotonicNowMs ?? (() => performance.now()) });

  // One salt per service process (D-36): a fingerprint observed in one process says nothing
  // about another, and the salt never leaves the machine except inside the response.
  const salt = ports.vault.salt ?? randomBytes(16).toString("hex");

  const wired = (id: SubsystemRowId, probe: Probe | undefined): NamedProbe => ({
    id,
    run: probe ?? (() => Promise.resolve(notWired(id))),
  });

  /**
   * One read of the persisted root per check, kept for the row, the display path and the fingerprint
   * (they must describe the same value). A throw is remembered, not propagated (FIX2A F9): the vault
   * probe reads it through {@link rootForProbe} and answers `probe-error`; the path and the
   * fingerprint are then null.
   */
  const readRootOnce = (): { readonly ok: true; readonly root: string | null } | { ok: false } => {
    try {
      return { ok: true, root: ports.vault.readRoot() };
    } catch {
      return { ok: false };
    }
  };

  const compute = async (trigger: HealthTrigger): Promise<DiagnosticsHealthResponse> => {
    const read = readRootOnce();
    const root = read.ok ? read.root : null;
    const rootForProbe = (): string | null => {
      if (!read.ok) throw new Error("the persisted vault root could not be read");
      return read.root;
    };
    const rows = await runProbes(
      [
        wired("vault", (signal) =>
          probeVault(
            {
              readRoot: rootForProbe,
              fs: ports.vault.fs,
              isForbiddenRoot: ports.vault.isForbiddenRoot,
            },
            signal,
          ),
        ),
        wired("hooks", ports.hooks),
        wired("collectors", ports.collectors),
        wired("scheduler", ports.scheduler),
        wired("launchers", ports.launchers),
      ],
      trigger,
      { now: ports.now, log },
    );
    // A path too long for the schema gets its last segment, not a failed response (FIX2A F9).
    const display = (path: string): string =>
      toBoundedDisplayPath(path, serviceFacts.homeDir) ?? "…/unknown";
    // The strict parse is the last guard: a response that does not parse is an internal error
    // (closed 500), never a body with a stray field.
    return DiagnosticsHealthResponseSchema.parse({
      generatedAt: ports.now().toISOString(),
      service: {
        version: serviceFacts.version,
        startedAt: serviceFacts.startedAt,
        storeSchemaVersion: storeSchemaVersionOrNull(serviceFacts),
      },
      rows,
      keychain: { installSecret: "unknown", researchKey: "unknown" },
      paths: {
        vault: root === null ? null : toBoundedDisplayPath(root, serviceFacts.homeDir),
        runtimeDir: display(serviceFacts.runtimeDir),
        socket: display(serviceFacts.socketPath),
      },
      vaultFingerprint: root === null ? null : vaultFingerprint(salt, root),
      counts: { projects: null, scanFolders: null, openTasks: null, reports: null },
    });
  };

  return {
    async check(trigger, signal) {
      // The caller's signal only stops this caller before a run starts: a run is shared, so one
      // caller leaving must never abort the others' probes.
      signal?.throwIfAborted();
      const answer = await cache.get(trigger, () => compute(trigger));
      return answer.cached ? asCachedResponse(answer.response) : answer.response;
    },
  };
}
