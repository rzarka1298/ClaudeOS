import {
  COLLECTORS_PASSIVE_PART_IDS,
  COLLECTORS_REASON_STATUS,
  type CollectorsPartId,
  type DiagnosticsHealthResponse,
  DiagnosticsHealthResponseSchema,
  type HealthFacts,
  HOOKS_REASON_STATUS,
  LAUNCHERS_REASON_STATUS,
  type LauncherPartId,
  rollupPartStatuses,
  SCHEDULER_PASSIVE_PART_IDS,
  SCHEDULER_REASON_STATUS,
  type SetupAction,
  type SubsystemStatus,
  VAULT_REASON_STATUS,
} from "@ccc/domain/diagnostics.js";

/**
 * Synthetic health responses for the Diagnostics tests (plan 08-13). Every value is invented and
 * every response is built through the strict domain schema, so a fixture can never describe a
 * state the service could not send. Test support only.
 */

export const HEALTH_T0 = "2026-10-22T09:00:00.000Z";
/** Thirty seconds after {@link HEALTH_T0}: the "now" of a freshly fetched response. */
export const HEALTH_NOW = Date.parse(HEALTH_T0) + 30_000;

const STATUS_OF: Readonly<Record<string, SubsystemStatus>> = {
  ...VAULT_REASON_STATUS,
  ...HOOKS_REASON_STATUS,
  ...COLLECTORS_REASON_STATUS,
  ...SCHEDULER_REASON_STATUS,
  ...LAUNCHERS_REASON_STATUS,
};

export interface PartExtras {
  readonly setupAction?: SetupAction;
  readonly facts?: HealthFacts;
}

export interface FixturePart extends PartExtras {
  readonly partId: string;
  readonly status: SubsystemStatus;
  readonly reasonCode: string;
}

export function part(partId: string, reasonCode: string, extras: PartExtras = {}): FixturePart {
  const status = STATUS_OF[reasonCode];
  if (status === undefined) throw new Error(`fixture: no status for ${reasonCode}`);
  return { partId, status, reasonCode, ...extras };
}

export interface RowOptions extends PartExtras {
  readonly checkedAt?: string;
  readonly freshness?: "live" | "cached" | "stale" | "unavailable";
}

/** A row without parts (vault, hooks, or a probe that did not finish). */
export function plainRow(
  id: "vault" | "hooks" | "collectors" | "scheduler" | "launchers",
  reasonCode: string,
  options: RowOptions = {},
): Record<string, unknown> {
  const status = STATUS_OF[reasonCode];
  if (status === undefined) throw new Error(`fixture: no status for ${reasonCode}`);
  const { checkedAt = HEALTH_T0, freshness = "live", setupAction, facts } = options;
  return {
    id,
    status,
    reasonCode,
    checkedAt,
    freshness,
    ...(setupAction === undefined ? {} : { setupAction }),
    ...(facts === undefined ? {} : { facts }),
  };
}

/** A row of parts, rolled up and decided the way the service's probes do it. */
export function partsRow(
  id: "collectors" | "scheduler" | "launchers",
  parts: readonly FixturePart[],
  options: Pick<RowOptions, "checkedAt" | "freshness"> = {},
): Record<string, unknown> {
  const passive: readonly string[] =
    id === "collectors"
      ? COLLECTORS_PASSIVE_PART_IDS
      : id === "scheduler"
        ? SCHEDULER_PASSIVE_PART_IDS
        : [];
  const status = rollupPartStatuses(parts, passive);
  const matching = parts.filter((candidate) => candidate.status === status);
  const deciding = matching.find((candidate) => !passive.includes(candidate.partId)) ?? matching[0];
  if (deciding === undefined) throw new Error("fixture: a roll-up status no part has");
  const { checkedAt = HEALTH_T0, freshness = "live" } = options;
  return {
    id,
    status,
    reasonCode: deciding.reasonCode,
    checkedAt,
    freshness,
    parts,
    ...(deciding.setupAction === undefined ? {} : { setupAction: deciding.setupAction }),
    ...(deciding.facts === undefined ? {} : { facts: deciding.facts }),
  };
}

const COLLECTOR_ORDER: readonly CollectorsPartId[] = [
  "telemetry",
  "status-line",
  "transcript-analysis",
  "spool",
  "codex-install",
  "codex-hooks",
  "codex-bridge",
  "codex-doctor",
];

const COLLECTOR_OK: Readonly<Record<CollectorsPartId, string>> = {
  telemetry: "telemetry-ok",
  "status-line": "statusline-reporting",
  "transcript-analysis": "analysis-on",
  spool: "spool-clean",
  "codex-install": "codex-installed",
  "codex-hooks": "codex-hooks-receiving",
  "codex-bridge": "codex-bridge-ready",
  "codex-doctor": "codex-doctor-ok",
};

/** The eight collectors parts, all `ok`, with `overrides` replacing a part's reason (and extras). */
export function collectorsParts(
  overrides: Partial<Record<CollectorsPartId, readonly [string, PartExtras?]>> = {},
): FixturePart[] {
  return COLLECTOR_ORDER.map((partId) => {
    const override = overrides[partId];
    return override === undefined
      ? part(partId, COLLECTOR_OK[partId])
      : part(partId, override[0], override[1] ?? {});
  });
}

export const CLAUDE_INSTALL_ACTION: SetupAction = {
  kind: "copy-command",
  command: "claude-hooks-install",
};
export const GO_LAUNCHERS: SetupAction = { kind: "go-to-section", section: "launchers" };
export const GO_RESEARCH: SetupAction = { kind: "go-to-section", section: "research" };
export const KEY_SETUP: SetupAction = { kind: "copy-command", command: "research-key-setup" };
export const VAULT_SETUP: SetupAction = { kind: "run-plugin-command", command: "vault-setup" };

/** The fresh-install collectors row: the status line, analysis and Codex parts all need setup. */
export function freshCollectorsParts(): FixturePart[] {
  return collectorsParts({
    "status-line": ["statusline-not-installed", { setupAction: CLAUDE_INSTALL_ACTION }],
    "transcript-analysis": [
      "analysis-off",
      { setupAction: { kind: "go-to-section", section: "security" } },
    ],
    "codex-install": ["codex-not-installed"],
    "codex-hooks": [
      "codex-hooks-not-installed",
      { setupAction: { kind: "copy-command", command: "codex-hooks-install" } },
    ],
    "codex-bridge": [
      "codex-bridge-not-installed",
      { setupAction: { kind: "copy-command", command: "codex-bridge-install" } },
    ],
    "codex-doctor": [
      "codex-doctor-not-run",
      { setupAction: { kind: "go-to-section", section: "integrations" } },
    ],
  });
}

export function schedulerParts(
  overrides: { lastRun?: readonly [string, PartExtras?]; key?: string; sources?: string } = {},
): FixturePart[] {
  const lastRun = overrides.lastRun ?? ["never-run", { setupAction: GO_RESEARCH }];
  return [
    part("last-run", lastRun[0], lastRun[1] ?? {}),
    part(
      "research-key",
      overrides.key ?? "research-key-missing",
      (overrides.key ?? "research-key-missing") === "research-key-missing"
        ? { setupAction: KEY_SETUP }
        : {},
    ),
    part("sources", overrides.sources ?? "sources-configured", {
      facts: { sourceCount: 5 },
    }),
  ];
}

export function launcherParts(reason = "launcher-not-set-up", withTerminal = false): FixturePart[] {
  const ids: LauncherPartId[] = ["antigravity", "claude-code", "claude-desktop", "codex"];
  if (withTerminal) ids.push("terminal");
  return ids.map((partId) =>
    part(partId, reason, reason === "launcher-ready" ? {} : { setupAction: GO_LAUNCHERS }),
  );
}

export interface HealthOptions {
  readonly vault?: Record<string, unknown>;
  readonly hooks?: Record<string, unknown>;
  readonly collectors?: Record<string, unknown>;
  readonly scheduler?: Record<string, unknown>;
  readonly launchers?: Record<string, unknown>;
  readonly generatedAt?: string;
  readonly version?: string;
  readonly startedAt?: string;
  readonly storeSchemaVersion?: number | null;
  readonly vaultFingerprint?: { salt: string; digest: string } | null;
}

/** A response with the five service-side rows; every row defaults to the fresh-install answer. */
export function healthResponse(options: HealthOptions = {}): DiagnosticsHealthResponse {
  return DiagnosticsHealthResponseSchema.parse({
    generatedAt: options.generatedAt ?? HEALTH_T0,
    service: {
      version: options.version ?? "0.1.0",
      startedAt: options.startedAt ?? "2026-10-22T06:00:00.000Z",
      storeSchemaVersion:
        options.storeSchemaVersion === undefined ? 12 : options.storeSchemaVersion,
    },
    rows: [
      options.vault ?? plainRow("vault", "vault-not-set-up", { setupAction: VAULT_SETUP }),
      options.hooks ??
        plainRow("hooks", "hooks-not-installed", { setupAction: CLAUDE_INSTALL_ACTION }),
      options.collectors ?? partsRow("collectors", freshCollectorsParts()),
      options.scheduler ?? partsRow("scheduler", schedulerParts()),
      options.launchers ?? partsRow("launchers", launcherParts()),
    ],
    keychain: { installSecret: "unknown", researchKey: "unknown" },
    paths: { vault: null, runtimeDir: "~/.example-runtime", socket: "~/.example-runtime/svc.sock" },
    vaultFingerprint: options.vaultFingerprint === undefined ? null : options.vaultFingerprint,
    counts: { projects: null, scanFolders: null, openTasks: null, reports: null },
  });
}

/** Everything working. */
export function allOkHealth(options: HealthOptions = {}): DiagnosticsHealthResponse {
  return healthResponse({
    vault: plainRow("vault", "vault-ready"),
    hooks: plainRow("hooks", "hooks-receiving"),
    collectors: partsRow("collectors", collectorsParts()),
    scheduler: partsRow(
      "scheduler",
      schedulerParts({
        lastRun: ["last-run-succeeded", { facts: { lastSuccessAt: "2026-10-22T08:00:00.000Z" } }],
        key: "research-key-present",
      }),
    ),
    launchers: partsRow("launchers", launcherParts("launcher-ready")),
    ...options,
  });
}

/** A vault fingerprint for `basePath` the way the service computes it (SHA-256 of `salt:path`). */
export async function fingerprintFor(
  basePath: string,
  salt = "0123456789abcdef0123456789abcdef",
): Promise<{ salt: string; digest: string }> {
  const bytes = new TextEncoder().encode(`${salt}:${basePath}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return { salt, digest: hex.slice(0, 16) };
}
