import {
  type DiagnosticsHealthResponse,
  DiagnosticsHealthResponseSchema,
  type HealthTrigger,
  type ProbeOutcome,
  type ServiceSideRow,
  toDisplayPath,
} from "@ccc/domain";
import { logger } from "../logging.js";

/**
 * The diagnostics services behind `GET /api/v1/diagnostics/health` (plan 08-07; D-02, D-04, D-05).
 *
 * Built in `main.ts` from narrow, optional ports, one per subsystem: a subsystem whose port is
 * absent reads `unknown` / `subsystem-not-wired`, never a guess (08-12 wires the hooks, collectors,
 * scheduler and launchers ports). A port is a probe: a function of an abort signal and the
 * trigger that returns a {@link ProbeOutcome} (a row without its check time and freshness).
 * Nothing here can launch, install, write or reach the network.
 */

/** One subsystem's check. It must stop when `signal` aborts; it must not throw (a throw is `probe-error`). */
export type Probe = (signal: AbortSignal, trigger: HealthTrigger) => Promise<ProbeOutcome>;

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
  /** The persisted vault root, read fresh each time; null when no vault has been set up. */
  readonly vault: { readonly readRoot: () => string | null };
  readonly hooks?: Probe | undefined;
  readonly collectors?: Probe | undefined;
  readonly scheduler?: Probe | undefined;
  readonly launchers?: Probe | undefined;
  readonly serviceFacts: DiagnosticsServiceFacts;
  readonly now: () => Date;
}

export interface DiagnosticsServices {
  /**
   * Runs the checks and answers the strict response. `trigger` says why (Amendment A1): only a
   * `gesture` may cause a probe to spawn `security`. Resolves, or rejects with an error the route
   * answers as the closed `internal` code.
   */
  check(trigger: HealthTrigger, signal?: AbortSignal): Promise<DiagnosticsHealthResponse>;
}

function notWired(id: ServiceSideRow["id"]): ProbeOutcome {
  return { id, status: "unknown", reasonCode: "subsystem-not-wired" } as ProbeOutcome;
}

export function createDiagnosticsServices(ports: DiagnosticsPorts): DiagnosticsServices {
  const { serviceFacts } = ports;

  // Task 1 vault probe: the real probe replaces this in Task 3.
  const probeVaultInline: Probe = () => {
    const root = ports.vault.readRoot();
    if (root === null) {
      return Promise.resolve({
        id: "vault",
        status: "setup-needed",
        reasonCode: "vault-not-set-up",
        setupAction: { kind: "run-plugin-command", command: "vault-setup" },
      } as ProbeOutcome);
    }
    return Promise.resolve(notWired("vault"));
  };

  const probes: readonly [ServiceSideRow["id"], Probe | undefined][] = [
    ["vault", probeVaultInline],
    ["hooks", ports.hooks],
    ["collectors", ports.collectors],
    ["scheduler", ports.scheduler],
    ["launchers", ports.launchers],
  ];

  return {
    async check(trigger, signal) {
      const effective = signal ?? new AbortController().signal;
      const checkedAt = ports.now().toISOString();
      const rows: ServiceSideRow[] = [];
      for (const [id, probe] of probes) {
        let outcome: ProbeOutcome;
        if (probe === undefined) {
          outcome = notWired(id);
        } else {
          try {
            outcome = await probe(effective, trigger);
          } catch (err: unknown) {
            logger.warn(
              {
                subsystem: id,
                code: "probe-error",
                errorName: err instanceof Error ? err.name : typeof err,
              },
              "diagnostics probe failed",
            );
            outcome = { id, status: "unknown", reasonCode: "probe-error" } as ProbeOutcome;
          }
        }
        rows.push({ ...outcome, checkedAt, freshness: "live" } as ServiceSideRow);
      }
      const root = ports.vault.readRoot();
      const display = (path: string): string =>
        toDisplayPath(path, serviceFacts.homeDir) ?? "…/unknown";
      return DiagnosticsHealthResponseSchema.parse({
        generatedAt: checkedAt,
        service: {
          version: serviceFacts.version,
          startedAt: serviceFacts.startedAt,
          storeSchemaVersion: serviceFacts.storeSchemaVersion(),
        },
        rows,
        keychain: { installSecret: "unknown", researchKey: "unknown" },
        paths: {
          vault: root === null ? null : display(root),
          runtimeDir: display(serviceFacts.runtimeDir),
          socket: display(serviceFacts.socketPath),
        },
        vaultFingerprint: null,
        counts: { projects: null, scanFolders: null, openTasks: null, reports: null },
      });
    },
  };
}
