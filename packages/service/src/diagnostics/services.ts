import { randomBytes } from "node:crypto";
import {
  type DiagnosticsHealthResponse,
  DiagnosticsHealthResponseSchema,
  type HealthTrigger,
  type ProbeOutcome,
  toBoundedDisplayPath,
} from "@ccc/domain";
import { logger } from "../logging.js";
import { type CollectorsProbePorts, probeCollectors } from "./collectors-probe.js";
import type { HealthCounts } from "./counts.js";
import { type HooksProbePorts, probeHooks } from "./hooks-probe.js";
import { type LaunchersProbePorts, probeLaunchers } from "./launchers-probe.js";
import {
  asCachedResponse,
  createHealthCache,
  type NamedProbe,
  type Probe,
  type ProbeLogEntry,
  runProbes,
  type SubsystemRowId,
} from "./run-probes.js";
import { type KeyPresence, probeScheduler, type SchedulerProbePorts } from "./scheduler-probe.js";
import { probeVault, type VaultProbePorts, vaultFingerprint } from "./vault-probe.js";

/**
 * The diagnostics services behind `GET /api/v1/diagnostics/health` (plan 08-07; D-02, D-04, D-05).
 *
 * Built in `main.ts` from narrow, optional ports, one per subsystem: a subsystem whose port is
 * absent reads `unknown` / `subsystem-not-wired`, never a guess. There are two ways to give a
 * subsystem its port. A `Probe` (a function of an abort signal and the trigger that returns a
 * {@link ProbeOutcome}, a row without its check time and freshness) is what the route tests inject.
 * A read-only port SET (`hooksPorts`, `collectorsPorts`, `schedulerPorts`, `launchersPorts`, plan
 * 08-12) is what the composition root builds from the real service objects; the services turn it
 * into the matching probe from plan 08-08. A `Probe` for a subsystem wins over its port set.
 * Nothing here can launch, install, write or reach the network: every port set is typed to reads.
 *
 * The research key presence is read ONCE per check, by the scheduler probe, and the same answer fills
 * `keychain.researchKey` (Amendment A1): it follows the trigger, so a reconnect never starts a
 * process and reads the last gesture's answer, or `unknown` before there has been one.
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
  /** The read-only port sets the probes of plan 08-08 run on (used when no `Probe` is given for the subsystem). */
  readonly hooksPorts?: HooksProbePorts | undefined;
  readonly collectorsPorts?: CollectorsProbePorts | undefined;
  readonly schedulerPorts?: SchedulerProbePorts | undefined;
  readonly launchersPorts?: LaunchersProbePorts | undefined;
  /**
   * What the service itself knows about its Keychain items. The install secret is reported from the
   * service's own startup read (it cannot answer without it), so it costs no Keychain call; the
   * research key comes from the scheduler probe's presence read, never from here.
   */
  readonly keychain?: { readonly installSecret: "present" | "absent" | "unknown" } | undefined;
  /** The four counts for the bundle. A throw reads four nulls; a count that cannot be read is null itself. */
  readonly counts?: (() => HealthCounts) | undefined;
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

/**
 * `keychain.researchKey` from the presence the scheduler probe observed. Only a definite answer
 * counts: `present` and `absent`. An unreadable check, a check no gesture has made yet, a check the
 * probe never reached (it was cut, or the scheduler is not wired) and the guarded test transport
 * (where the key is never consulted) all read `unknown`, never a guess.
 */
function researchKeyPresence(observed: KeyPresence | null): "present" | "absent" | "unknown" {
  return observed === "present" || observed === "absent" ? observed : "unknown";
}

const NO_COUNTS: HealthCounts = {
  projects: null,
  scanFolders: null,
  openTasks: null,
  reports: null,
};

const asCount = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/**
 * The counts port's answer, or four nulls when it is absent or throws. A member that is not a
 * non-negative safe integer reads null as well, so a misbehaving port can never fail the response.
 */
function countsOrNulls(port: (() => HealthCounts) | undefined): HealthCounts {
  if (port === undefined) return NO_COUNTS;
  try {
    const counts = port();
    return {
      projects: asCount(counts.projects),
      scanFolders: asCount(counts.scanFolders),
      openTasks: asCount(counts.openTasks),
      reports: asCount(counts.reports),
    };
  } catch {
    return NO_COUNTS;
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
    // The key presence the scheduler probe observed in THIS check, for keychain.researchKey. It
    // is recorded only when the probe's own signal had not fired, mirroring the probe, so a late
    // answer the runner discards never reaches the response.
    let observedKey: KeyPresence | null = null;
    const schedulerProbe: Probe | undefined =
      ports.scheduler ??
      (ports.schedulerPorts === undefined
        ? undefined
        : (signal, probeTrigger) => {
            const schedulerPorts = ports.schedulerPorts as SchedulerProbePorts;
            return probeScheduler(
              {
                ...schedulerPorts,
                keyPresence: async (keyTrigger, keySignal) => {
                  const presence = await schedulerPorts.keyPresence(keyTrigger, keySignal);
                  if (!keySignal.aborted) observedKey = presence;
                  return presence;
                },
              },
              signal,
              probeTrigger,
            );
          });
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
        wired(
          "hooks",
          ports.hooks ??
            (ports.hooksPorts === undefined
              ? undefined
              : (signal) => probeHooks(ports.hooksPorts as HooksProbePorts, signal)),
        ),
        wired(
          "collectors",
          ports.collectors ??
            (ports.collectorsPorts === undefined
              ? undefined
              : (signal) => probeCollectors(ports.collectorsPorts as CollectorsProbePorts, signal)),
        ),
        wired("scheduler", schedulerProbe),
        wired(
          "launchers",
          ports.launchers ??
            (ports.launchersPorts === undefined
              ? undefined
              : (signal) => probeLaunchers(ports.launchersPorts as LaunchersProbePorts, signal)),
        ),
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
      keychain: {
        installSecret: ports.keychain?.installSecret ?? "unknown",
        researchKey: researchKeyPresence(observedKey),
      },
      paths: {
        vault: root === null ? null : toBoundedDisplayPath(root, serviceFacts.homeDir),
        runtimeDir: display(serviceFacts.runtimeDir),
        socket: display(serviceFacts.socketPath),
      },
      vaultFingerprint: root === null ? null : vaultFingerprint(salt, root),
      counts: countsOrNulls(ports.counts),
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
