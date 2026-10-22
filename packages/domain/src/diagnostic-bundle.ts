import { z } from "zod";
import {
  COLLECTORS_PART_REASONS,
  COLLECTORS_REASON_STATUS,
  COLLECTORS_REASONS,
  type DiagnosticsHealthResponse,
  HOOKS_REASON_STATUS,
  HOOKS_REASONS,
  LAUNCHER_PART_IDS,
  LAUNCHERS_REASON_STATUS,
  LAUNCHERS_REASONS,
  SCHEDULER_PART_REASONS,
  SCHEDULER_REASON_STATUS,
  SCHEDULER_REASONS,
  SERVICE_REASON_STATUS,
  SERVICE_REASONS,
  SUBSYSTEM_IDS,
  SUBSYSTEM_STATUSES,
  SubsystemStatusSchema,
  VAULT_REASON_STATUS,
  VAULT_REASONS,
} from "./diagnostics.js";
import { LAUNCHER_STATUSES, type LauncherStatus, LauncherStatusSchema } from "./projects.js";
import { FreshnessSchema } from "./usage.js";

/**
 * The diagnostic bundle (plan 08-09; D-10, D-11, D-14, OD-5; DIAG-04; threats T-08-23 to T-08-26):
 * what an owner may copy or save into a public bug report.
 *
 * It is **allowlist-built**, not scrubbed after the fact. {@link DiagnosticBundleSchema} is strict
 * at every level and admits only versions, the platform, the connection state (never its reason),
 * the six subsystem rows as status plus reason code plus times plus parts, nullable integer counts,
 * feature flags and the plugin's diagnostic records reduced to source, code and time.
 * {@link buildDiagnosticBundle} constructs it by **explicit field picks** (no spread, no rest), so
 * a field the input happens to carry is never copied; it then parses the result. There is no
 * message, log line, path, display path, title, name, vault fingerprint or keychain value anywhere.
 *
 * {@link verifyBundle} is the second, independent check, run before a bundle is offered. It ports
 * the repository's privacy rules (`scripts/check-privacy.sh`) and adds the shapes that script lacks,
 * plus a runtime denylist of the owner's own names. A refusal names the rule, never the value.
 *
 * This file is Node-free: it is reachable from the plugin's browser bundle.
 */

// ---------------------------------------------------------------------------
// Constants and closed vocabularies

export const BUNDLE_VERSION = 1;

/** The largest serialised bundle that is offered (32 KiB). */
export const BUNDLE_MAX_BYTES = 32 * 1024;

/** The most plugin diagnostic records a bundle holds (the plugin keeps 100). */
export const BUNDLE_MAX_DIAGNOSTICS = 100;

/** The plugin diagnostic sources the bundle admits. */
export const BUNDLE_DIAGNOSTIC_SOURCES = ["layout"] as const;

/**
 * The diagnostic codes the plugin writes today (override-invalid, override-unreadable and
 * override-apply-failed from the layout file, and the three layout skip reasons). They are developer
 * constants, so they count as the bundle's own vocabulary; any other well-formed code is still
 * admitted (a later writer) but is then checked like free text.
 */
export const KNOWN_PLUGIN_DIAGNOSTIC_CODES = [
  "override-invalid",
  "override-unreadable",
  "override-apply-failed",
  "unknown-widget",
  "feature-off",
  "duplicate",
] as const;

const CONNECTION_STATES = ["live", "connecting", "disconnected"] as const;
export type BundleConnectionState = (typeof CONNECTION_STATES)[number];
const REDUCED_MOTION_VALUES = ["auto", "reduced"] as const;
const ARCHITECTURES = ["arm64", "x64"] as const;
const STORED_LAUNCHER_IDS = ["antigravity", "claude-code", "claude-desktop", "codex"] as const;
export type StoredLauncherKey = (typeof STORED_LAUNCHER_IDS)[number];

/** A dotted version such as `0.1.0` or `2.1.5-beta.1`. Mirrors the health contract's pattern. */
const DOTTED_VERSION_PATTERN = /^\d+(?:\.\d+){1,3}(?:-[A-Za-z0-9.]{1,32})?$/;
const KEBAB_CODE_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
const DottedVersionSchema = z.string().max(64).regex(DOTTED_VERSION_PATTERN, {
  message: "must be a dotted version",
});
const KebabCodeSchema = z.string().regex(KEBAB_CODE_PATTERN, { message: "must be a kebab code" });
const IsoUtcSchema = z.iso.datetime();
const CountSchema = z.int().nonnegative().nullable();

// ---------------------------------------------------------------------------
// The schema

type StatusTable = Readonly<Record<string, (typeof SUBSYSTEM_STATUSES)[number]>>;

/** A part, kept to its id, status and reason code; its reason must be one of that part's own. */
function partSchema(
  partReasons: Readonly<Record<string, readonly [string, ...string[]]>>,
  table: StatusTable,
) {
  const partIds = Object.keys(partReasons) as [string, ...string[]];
  return z
    .strictObject({
      partId: z.enum(partIds),
      status: SubsystemStatusSchema,
      reasonCode: z.string(),
    })
    .refine(
      (part) =>
        (partReasons[part.partId] as readonly string[] | undefined)?.includes(part.reasonCode) ===
        true,
      { message: "the reason must be one of the part's own", path: ["reasonCode"] },
    )
    .refine((part) => table[part.reasonCode] === part.status, {
      message: "status must equal the status of the reason code",
      path: ["status"],
    });
}

function rowShape<Id extends string>(id: Id, reasons: readonly [string, ...string[]]) {
  return {
    id: z.literal(id),
    status: SubsystemStatusSchema,
    reasonCode: z.enum(reasons),
    checkedAt: IsoUtcSchema.nullable(),
    freshness: FreshnessSchema,
  };
}

function statusFollowsReason(table: StatusTable) {
  return (row: { readonly status: string; readonly reasonCode: string }): boolean =>
    table[row.reasonCode] === row.status;
}

const STATUS_FOLLOWS_REASON = {
  message: "status must equal the status of the reason code",
  path: ["status"],
};

/** A row without parts (the service row). */
function bundleRow<Id extends string>(
  id: Id,
  reasons: readonly [string, ...string[]],
  table: StatusTable,
) {
  return z
    .strictObject(rowShape(id, reasons))
    .refine(statusFollowsReason(table), STATUS_FOLLOWS_REASON);
}

/** A row that may carry parts of id, status and reason code. */
function bundleRowWithParts<Id extends string>(
  id: Id,
  reasons: readonly [string, ...string[]],
  table: StatusTable,
  parts: Readonly<Record<string, readonly [string, ...string[]]>>,
) {
  return z
    .strictObject({
      ...rowShape(id, reasons),
      parts: z.array(partSchema(parts, table)).max(8).exactOptional(),
    })
    .refine(statusFollowsReason(table), STATUS_FOLLOWS_REASON);
}

const LAUNCHER_PART_REASONS = Object.fromEntries(
  LAUNCHER_PART_IDS.map((partId) => [partId, LAUNCHERS_REASONS]),
) as Record<(typeof LAUNCHER_PART_IDS)[number], typeof LAUNCHERS_REASONS>;

const PluginDiagnosticSchema = z.strictObject({
  source: z.enum(BUNDLE_DIAGNOSTIC_SOURCES),
  code: KebabCodeSchema,
  at: IsoUtcSchema,
});

export const DiagnosticBundleSchema = z.strictObject({
  bundleVersion: z.literal(BUNDLE_VERSION),
  generatedAt: IsoUtcSchema,
  versions: z.strictObject({
    plugin: DottedVersionSchema,
    service: DottedVersionSchema.nullable(),
    obsidian: DottedVersionSchema.nullable(),
    electron: DottedVersionSchema.nullable(),
    node: DottedVersionSchema.nullable(),
    storeSchema: z.int().nonnegative().nullable(),
  }),
  platform: z.strictObject({
    os: z.literal("darwin"),
    arch: z.enum(ARCHITECTURES).nullable(),
  }),
  /** The state only. The raw reason text of a disconnect is an error message and never leaves. */
  connection: z.strictObject({ state: z.enum(CONNECTION_STATES) }),
  subsystems: z.tuple([
    bundleRow("service", SERVICE_REASONS, SERVICE_REASON_STATUS),
    bundleRow("vault", VAULT_REASONS, VAULT_REASON_STATUS),
    bundleRow("hooks", HOOKS_REASONS, HOOKS_REASON_STATUS),
    bundleRowWithParts(
      "collectors",
      COLLECTORS_REASONS,
      COLLECTORS_REASON_STATUS,
      COLLECTORS_PART_REASONS,
    ),
    bundleRowWithParts(
      "scheduler",
      SCHEDULER_REASONS,
      SCHEDULER_REASON_STATUS,
      SCHEDULER_PART_REASONS,
    ),
    bundleRowWithParts(
      "launchers",
      LAUNCHERS_REASONS,
      LAUNCHERS_REASON_STATUS,
      LAUNCHER_PART_REASONS,
    ),
  ]),
  counts: z.strictObject({
    projects: CountSchema,
    scanFolders: CountSchema,
    openTasks: CountSchema,
    reports: CountSchema,
    pluginDiagnostics: z.int().nonnegative().max(BUNDLE_MAX_DIAGNOSTICS),
  }),
  features: z.strictObject({
    reducedMotion: z.enum(REDUCED_MOTION_VALUES),
    transcriptAnalysis: z.boolean().nullable(),
    notifyApprovals: z.boolean(),
    launchers: z.strictObject({
      antigravity: LauncherStatusSchema.nullable(),
      "claude-code": LauncherStatusSchema.nullable(),
      "claude-desktop": LauncherStatusSchema.nullable(),
      codex: LauncherStatusSchema.nullable(),
    }),
  }),
  pluginDiagnostics: z.array(PluginDiagnosticSchema).max(BUNDLE_MAX_DIAGNOSTICS),
});
export type DiagnosticBundle = z.infer<typeof DiagnosticBundleSchema>;

/**
 * Every closed token the schema admits, folded to lower case: subsystem ids and statuses,
 * freshness values, connection states, every reason code and part id, platform and feature
 * values, launcher statuses and the known plugin diagnostic codes. A string equal to one of these
 * cannot be user text, so the denylist skips it (and never keeps an entry equal to one).
 */
export const BUNDLE_VOCABULARY: ReadonlySet<string> = new Set(
  [
    ...SUBSYSTEM_IDS,
    ...SUBSYSTEM_STATUSES,
    ...FreshnessSchema.options,
    ...CONNECTION_STATES,
    ...SERVICE_REASONS,
    ...VAULT_REASONS,
    ...HOOKS_REASONS,
    ...COLLECTORS_REASONS,
    ...SCHEDULER_REASONS,
    ...LAUNCHERS_REASONS,
    ...Object.keys(COLLECTORS_PART_REASONS),
    ...Object.keys(SCHEDULER_PART_REASONS),
    ...LAUNCHER_PART_IDS,
    ...STORED_LAUNCHER_IDS,
    ...LAUNCHER_STATUSES,
    ...REDUCED_MOTION_VALUES,
    ...ARCHITECTURES,
    "darwin",
    ...BUNDLE_DIAGNOSTIC_SOURCES,
    ...KNOWN_PLUGIN_DIAGNOSTIC_CODES,
  ].map((token) => token.toLowerCase()),
);

// ---------------------------------------------------------------------------
// The builder

/** The state of each stored launcher as the plugin knows it; null when it does not. */
export type BundleLauncherStatuses = Readonly<Record<StoredLauncherKey, LauncherStatus | null>>;

/** One plugin diagnostic record as the plugin holds it; the message is read by nothing and dropped. */
export interface BundlePluginDiagnostic {
  readonly source: string;
  readonly code: string;
  readonly message: string;
  readonly at: string;
}

/**
 * The narrow struct the plugin assembles (plan 08-16). Every key is mapped to the schema on
 * purpose: the type test in `diagnostic-bundle.test.ts` lists these keys, so a new one fails the
 * build until it is decided where it goes.
 */
export interface DiagnosticBundleInput {
  /** The instant the bundle is made. */
  readonly generatedAt: string;
  /** The service's answer, or null when there is none (the service is away or the request failed). */
  readonly health: DiagnosticsHealthResponse | null;
  /** The connection state only; its reason text is not a field of the input. */
  readonly connection: BundleConnectionState;
  /** The plugin's comparison of the open vault with the managed one (D-36), applied to a ready vault row. */
  readonly vaultCheck: "match" | "mismatch" | "unavailable";
  readonly versions: {
    readonly plugin: string;
    readonly obsidian: string | null;
    readonly electron: string | null;
    readonly node: string | null;
  };
  readonly platformArch: (typeof ARCHITECTURES)[number] | null;
  readonly features: {
    readonly reducedMotion: (typeof REDUCED_MOTION_VALUES)[number];
    readonly transcriptAnalysis: boolean | null;
    readonly notifyApprovals: boolean;
    readonly launchers: BundleLauncherStatuses;
  };
  readonly pluginDiagnostics: readonly BundlePluginDiagnostic[];
}

/** A version that is a dotted version, else null: free text is never passed through. */
function dotted(value: string | null): string | null {
  return value !== null && value.length <= 64 && DOTTED_VERSION_PATTERN.test(value) ? value : null;
}

/** An instant as UTC text, or null when it does not parse. */
function utc(value: string | null): string | null {
  if (value === null) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function launcherStatus(value: LauncherStatus | null): LauncherStatus | null {
  return (LAUNCHER_STATUSES as readonly unknown[]).includes(value) ? value : null;
}

type BundleRow = DiagnosticBundle["subsystems"][number];

/** The row the plugin shows for the service itself: from the connection state, never from text. */
function serviceRow(input: DiagnosticBundleInput): BundleRow {
  const live = input.connection === "live";
  const reasonCode =
    input.connection === "live"
      ? "service-live"
      : input.connection === "connecting"
        ? "service-connecting"
        : "service-unreachable";
  return {
    id: "service",
    status: SERVICE_REASON_STATUS[reasonCode],
    reasonCode,
    checkedAt: live ? utc(input.health?.generatedAt ?? null) : null,
    freshness: live && input.health !== null ? "live" : "unavailable",
  };
}

/** A row cleared because the service cannot be asked (D-03): unknown, never a last good value. */
function clearedRow(id: "vault" | "hooks" | "collectors" | "scheduler" | "launchers"): BundleRow {
  return {
    id,
    status: "unknown",
    reasonCode: "service-not-running",
    checkedAt: null,
    freshness: "unavailable",
  } as BundleRow;
}

/** A health row reduced to id, status, reason, time, freshness and parts of id, status and reason. */
function pickedRow(
  row: DiagnosticsHealthResponse["rows"][number],
  vaultCheck: DiagnosticBundleInput["vaultCheck"],
): BundleRow {
  if (row.id === "vault" && row.reasonCode === "vault-ready" && vaultCheck !== "match") {
    const reasonCode = vaultCheck === "mismatch" ? "vault-mismatch" : "vault-check-unavailable";
    return {
      id: "vault",
      status: VAULT_REASON_STATUS[reasonCode],
      reasonCode,
      checkedAt: utc(row.checkedAt),
      freshness: row.freshness,
    };
  }
  const base = {
    id: row.id,
    status: row.status,
    reasonCode: row.reasonCode,
    checkedAt: utc(row.checkedAt),
    freshness: row.freshness,
  };
  if (!("parts" in row) || row.parts === undefined) return base as BundleRow;
  return {
    ...base,
    parts: row.parts.map((part) => ({
      partId: part.partId,
      status: part.status,
      reasonCode: part.reasonCode,
    })),
  } as BundleRow;
}

function pickedDiagnostics(
  records: readonly BundlePluginDiagnostic[],
): DiagnosticBundle["pluginDiagnostics"] {
  const kept: DiagnosticBundle["pluginDiagnostics"] = [];
  for (const record of records) {
    const at = utc(record.at);
    if (
      !(BUNDLE_DIAGNOSTIC_SOURCES as readonly string[]).includes(record.source) ||
      !KEBAB_CODE_PATTERN.test(record.code) ||
      at === null
    ) {
      continue;
    }
    kept.push({ source: record.source as "layout", code: record.code, at });
  }
  return kept.slice(-BUNDLE_MAX_DIAGNOSTICS);
}

/**
 * Builds the bundle from the narrow input by explicit field picks and parses it. Nothing in the
 * input that the schema does not name can reach the output, whatever the input carries at run time.
 */
export function buildDiagnosticBundle(input: DiagnosticBundleInput): DiagnosticBundle {
  const { health } = input;
  const diagnostics = pickedDiagnostics(input.pluginDiagnostics);
  const subsystems: BundleRow[] = [
    serviceRow(input),
    ...(health === null
      ? (["vault", "hooks", "collectors", "scheduler", "launchers"] as const).map(clearedRow)
      : health.rows.map((row) => pickedRow(row, input.vaultCheck))),
  ];
  return DiagnosticBundleSchema.parse({
    bundleVersion: BUNDLE_VERSION,
    generatedAt: utc(input.generatedAt),
    versions: {
      plugin: input.versions.plugin,
      service: health === null ? null : dotted(health.service.version),
      obsidian: dotted(input.versions.obsidian),
      electron: dotted(input.versions.electron),
      node: dotted(input.versions.node),
      storeSchema: health === null ? null : health.service.storeSchemaVersion,
    },
    platform: { os: "darwin", arch: input.platformArch },
    connection: { state: input.connection },
    subsystems,
    counts: {
      projects: health === null ? null : health.counts.projects,
      scanFolders: health === null ? null : health.counts.scanFolders,
      openTasks: health === null ? null : health.counts.openTasks,
      reports: health === null ? null : health.counts.reports,
      pluginDiagnostics: diagnostics.length,
    },
    features: {
      reducedMotion: input.features.reducedMotion,
      transcriptAnalysis: input.features.transcriptAnalysis,
      notifyApprovals: input.features.notifyApprovals,
      launchers: {
        antigravity: launcherStatus(input.features.launchers.antigravity),
        "claude-code": launcherStatus(input.features.launchers["claude-code"]),
        "claude-desktop": launcherStatus(input.features.launchers["claude-desktop"]),
        codex: launcherStatus(input.features.launchers.codex),
      },
    },
    pluginDiagnostics: diagnostics,
  });
}

/** The one string that is previewed, copied and saved: built once, after the verifier passes. */
export function serialiseBundle(bundle: DiagnosticBundle): string {
  return JSON.stringify(bundle, null, 2);
}

// ---------------------------------------------------------------------------
// The denylist and the verifier

/**
 * Why the verifier refused a bundle. Closed, and each code names a rule, never the matched value.
 */
export const BUNDLE_REFUSAL_CODES = [
  "home-path",
  "tilde-path",
  "email",
  "token-shaped",
  "denylist-project",
  "denylist-folder",
  "denylist-github",
  "denylist-vault",
  "denylist-user",
  "schema-invalid",
  "too-large",
] as const;
export type RefusalCode = (typeof BUNDLE_REFUSAL_CODES)[number];

export type VerifyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly rule: RefusalCode };

/** The owner data the denylist is built from. The plugin holds all of it already. */
export interface DenylistInput {
  readonly projectNames: readonly string[];
  readonly folderBasenames: readonly string[];
  readonly github: readonly { readonly owner: string; readonly repo: string }[];
  readonly vaultName: string | null;
  readonly userName: string | null;
}

type DenylistRule = Extract<RefusalCode, `denylist-${string}`>;

interface DenylistEntry {
  readonly rule: DenylistRule;
  readonly folded: string;
}

/** The names to refuse, folded. Opaque to callers: pass it to {@link verifyBundle}. */
export interface Denylist {
  readonly entries: readonly DenylistEntry[];
}

/** Entries shorter than this are skipped: a short name matches inside everything (research Pitfall 9). */
export const DENYLIST_MIN_LENGTH = 4;

/**
 * Folds text for a denylist comparison: compatibility-decomposed (so full-width letters and
 * ligatures become plain ones), stripped of combining marks (diacritics) and invisible format
 * characters (zero-width spaces, bidi marks), recomposed and lower-cased.
 */
export function foldForComparison(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\p{M}\p{Cf}]/gu, "")
    .normalize("NFKC")
    .toLowerCase();
}

/**
 * Builds the denylist from the owner data the plugin holds: project display names, folder
 * basenames, GitHub owner, repository and owner/repository, the vault name and the macOS short
 * user name. An entry shorter than {@link DENYLIST_MIN_LENGTH} after folding, or equal to a token of
 * the bundle's own vocabulary, is dropped, so a project called `ok` or `degraded` cannot make
 * export permanently impossible. `.privacy-denylist.local` is not used: it is absent on every
 * other install.
 */
export function buildDenylist(input: DenylistInput): Denylist {
  const entries: DenylistEntry[] = [];
  const add = (rule: DenylistRule, value: string | null): void => {
    if (value === null) return;
    const folded = foldForComparison(value).trim();
    if (folded.length < DENYLIST_MIN_LENGTH || BUNDLE_VOCABULARY.has(folded)) return;
    if (!entries.some((entry) => entry.rule === rule && entry.folded === folded)) {
      entries.push({ rule, folded });
    }
  };
  for (const name of input.projectNames) add("denylist-project", name);
  for (const name of input.folderBasenames) add("denylist-folder", name);
  for (const target of input.github) {
    add("denylist-github", target.owner);
    add("denylist-github", target.repo);
    add("denylist-github", `${target.owner}/${target.repo}`);
  }
  add("denylist-vault", input.vaultName);
  add("denylist-user", input.userName);
  return { entries };
}

/** The serialised size in UTF-8 bytes, computed without a text encoder (this file is Node-free). */
function utf8Length(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * Checks a bundle before it is offered. Task 1 of plan 08-09 verifies the structure and the size;
 * the privacy rules and the denylist are added with the corpus.
 */
export function verifyBundle(bundle: unknown, _denylist: Denylist): VerifyResult {
  if (!DiagnosticBundleSchema.safeParse(bundle).success) {
    return { ok: false, rule: "schema-invalid" };
  }
  if (utf8Length(JSON.stringify(bundle, null, 2)) > BUNDLE_MAX_BYTES) {
    return { ok: false, rule: "too-large" };
  }
  return { ok: true };
}
