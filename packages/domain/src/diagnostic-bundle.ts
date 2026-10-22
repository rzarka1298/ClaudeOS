import { z } from "zod";
import {
  COLLECTORS_PART_REASONS,
  COLLECTORS_REASON_STATUS,
  COLLECTORS_REASONS,
  type DiagnosticsHealthResponse,
  DOTTED_VERSION_PATTERN,
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
 * constants, so they count as the bundle's own vocabulary. The bundle schema admits exactly these
 * (FIX2A F3): an unknown code is skipped by the builder and refused by the schema, never passed. A new
 * writer adds its code here, which is a reviewed change.
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

/** The pre-release words a version may carry: part of the bundle's own vocabulary, never a name. */
const PRE_RELEASE_WORDS = ["alpha", "beta", "rc"] as const;
const DottedVersionSchema = z.string().max(64).regex(DOTTED_VERSION_PATTERN, {
  message: "must be a dotted version",
});
/** A code the plugin actually writes (FIX2A F3): a closed enum, so free text cannot ride in a code. */
const PluginDiagnosticCodeSchema = z.enum(KNOWN_PLUGIN_DIAGNOSTIC_CODES);
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
  code: PluginDiagnosticCodeSchema,
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
    ...PRE_RELEASE_WORDS,
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

/** A version of the closed shape, else null: free text is never passed through (FIX2A F2). */
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
      !(KNOWN_PLUGIN_DIAGNOSTIC_CODES as readonly string[]).includes(record.code) ||
      at === null
    ) {
      continue;
    }
    kept.push({
      source: record.source as "layout",
      code: record.code as (typeof KNOWN_PLUGIN_DIAGNOSTIC_CODES)[number],
      at,
    });
  }
  return kept.slice(-BUNDLE_MAX_DIAGNOSTICS);
}

/**
 * Builds the bundle from the narrow input by explicit field picks and parses it. Nothing in the
 * input that the schema does not name can reach the output, whatever the input carries at run time.
 */
export function buildDiagnosticBundle(input: DiagnosticBundleInput): DiagnosticBundle {
  // While the service is not live, no row shows a last good value (D-03): a response the plugin
  // still holds from before the disconnect is not used.
  const health = input.connection === "live" ? input.health : null;
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

/**
 * The serialisation of a bundle. Prefer {@link verifyAndSerialise}, the one entry point plans 08-13
 * and 08-16 use for the preview, Copy and Save string; this stays for tests and for the verifier's own
 * size check.
 */
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
export type BundleRefusalCode = (typeof BUNDLE_REFUSAL_CODES)[number];

export type VerifyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly rule: BundleRefusalCode };

/** The owner data the denylist is built from. The plugin holds all of it already. */
export interface DenylistInput {
  readonly projectNames: readonly string[];
  readonly folderBasenames: readonly string[];
  readonly github: readonly { readonly owner: string; readonly repo: string }[];
  readonly vaultName: string | null;
  readonly userName: string | null;
}

type DenylistRule = Extract<BundleRefusalCode, `denylist-${string}`>;

interface DenylistEntry {
  readonly rule: DenylistRule;
  readonly folded: string;
  /** The folded entry with every character that is not a letter or digit removed. */
  readonly squashed: string;
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

/** Letters and digits only, so `plum-cellar`, `plum_cellar` and `Plum Cellar` compare equal. */
function squash(folded: string): string {
  return folded.replace(/[^\p{L}\p{N}]+/gu, "");
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
      entries.push({ rule, folded, squashed: squash(folded) });
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

// ---------------------------------------------------------------------------
// The privacy rules

/**
 * The shapes the verifier refuses, as data. The first two ({@link PRIVACY_RULES.homePath} and
 * {@link PRIVACY_RULES.email}) are ported from `scripts/check-privacy.sh` and a gate in
 * `packages/test-fixtures` (`privacy-rules-parity.test.ts`) keeps their source text, the placeholder
 * list and the example-domain exemption equal to the script's, so the script and the verifier cannot
 * drift. The rest are new: the script has no `/home/`, `~/`, token or temporary-folder rule.
 *
 * Every `source` is the text of a regular expression written without flags; the code builds the
 * `RegExp` objects once, below.
 */
export const PRIVACY_RULES = {
  /** Script rule 1: a macOS home path whose user segment is not one of the documented placeholders. */
  homePath: {
    source: "\\/Users\\/[A-Za-z0-9._$<>-]+\\/?",
    placeholderSegments: ["USERNAME", "username", "<username>", "$USER", "you"] as const,
  },
  /** Script rule 2: an email address that is not on a reserved example domain. */
  email: {
    source: "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}",
    exemptSource: "@example\\.(com|org|net)$",
  },
  /** Other absolute-path shapes that name a machine or a run: reported as `home-path`. */
  pathShapes: [
    "(^|[^A-Za-z0-9_.-])\\/home\\/[A-Za-z0-9._$<>-]+",
    "file:\\/\\/",
    "\\/(private\\/)?var\\/folders\\/",
    "(^|[^A-Za-z0-9_.-])\\/(private\\/)?tmp\\/",
  ],
  /** Shell home spellings: reported as `tilde-path`. */
  tildeShapes: ["(^|[^A-Za-z0-9_])~\\/", "[$][{]?HOME[}]?([^A-Za-z0-9_]|$)"],
  /** Token shapes with a recognisable prefix or structure: reported as `token-shaped`. */
  tokenShapes: [
    // This project's bearer token (.gitleaks.toml rule ccc-bearer-token).
    "v1\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{20,}",
    "sk-ant-[A-Za-z0-9_-]{8,}",
    "(^|[^A-Za-z0-9])sk-[A-Za-z0-9]{20,}",
    "gh[pousr]_[A-Za-z0-9]{20,}",
    "github_pat_[A-Za-z0-9_]{20,}",
    "AKIA[0-9A-Z]{16}",
    "xox[baprs]-[A-Za-z0-9-]{10,}",
    "eyJ[A-Za-z0-9_-]{4,}\\.[A-Za-z0-9_-]{4,}\\.[A-Za-z0-9_-]{4,}",
    "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
    "(^|[^A-Za-z0-9])[0-9a-fA-F]{32,}([^A-Za-z0-9]|$)",
  ],
  /** A long run of base64-like characters (the runner sanitiser's heuristic). */
  base64Run: "[A-Za-z0-9+/_=-]{32,}",
} as const;

// Case-insensitive: macOS file systems are, so a lower-case spelling of the users folder names the same folder.
const HOME_PATH = new RegExp(PRIVACY_RULES.homePath.source, "gi");
const EMAIL = new RegExp(PRIVACY_RULES.email.source, "g");
const EMAIL_EXEMPT = new RegExp(PRIVACY_RULES.email.exemptSource);
const PATH_SHAPES = PRIVACY_RULES.pathShapes.map((source) => new RegExp(source));
const TILDE_SHAPES = PRIVACY_RULES.tildeShapes.map((source) => new RegExp(source));
const TOKEN_SHAPES = PRIVACY_RULES.tokenShapes.map((source) => new RegExp(source));
const BASE64_RUN = new RegExp(PRIVACY_RULES.base64Run, "g");

/** Mixed upper, lower and digit; or single-case letters and digits with a digit. Kebab names are neither. */
function looksLikeToken(run: string): boolean {
  const mixed = /[A-Z]/.test(run) && /[a-z]/.test(run) && /\d/.test(run);
  const singleCase = /^[a-z0-9]+$/.test(run) !== /^[A-Z0-9]+$/.test(run) && /\d/.test(run);
  return mixed || singleCase;
}

function hasHomePath(text: string): boolean {
  for (const match of text.matchAll(HOME_PATH)) {
    let segment = match[0].slice("/Users/".length);
    if (segment.endsWith("/")) segment = segment.slice(0, -1);
    if (!(PRIVACY_RULES.homePath.placeholderSegments as readonly string[]).includes(segment)) {
      return true;
    }
  }
  return false;
}

function hasEmail(text: string): boolean {
  for (const match of text.matchAll(EMAIL)) {
    if (!EMAIL_EXEMPT.test(match[0])) return true;
  }
  return false;
}

function hasToken(text: string): boolean {
  if (TOKEN_SHAPES.some((shape) => shape.test(text))) return true;
  for (const match of text.matchAll(BASE64_RUN)) {
    if (looksLikeToken(match[0])) return true;
  }
  return false;
}

/** The first shape rule a text breaks, or null. The order is the order of {@link BUNDLE_REFUSAL_CODES}. */
function shapeRuleOf(text: string): BundleRefusalCode | null {
  if (hasHomePath(text) || PATH_SHAPES.some((shape) => shape.test(text))) return "home-path";
  if (TILDE_SHAPES.some((shape) => shape.test(text))) return "tilde-path";
  if (hasEmail(text)) return "email";
  if (hasToken(text)) return "token-shaped";
  return null;
}

/** JSON-style escapes undone, so an escaped slash or a unicode-escaped slash cannot hide a path. */
function unescapeText(text: string): string {
  return text
    .replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/\\x([0-9a-fA-F]{2})/g, (_m, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/\\\//g, "/");
}

/** Percent-escapes undone once; an invalid sequence leaves the text as it was, except plain ASCII escapes. */
function percentDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text.replace(/%([0-7][0-9a-fA-F])/g, (_m, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
  }
}

/** Compatibility-normalised (full-width slashes and letters become ASCII) and stripped of invisible format characters. */
function normalised(text: string): string {
  return text.normalize("NFKC").replace(/\p{Cf}/gu, "");
}

/**
 * The spellings of a string the rules look at: as written, JSON-unescaped, percent-decoded (once
 * and twice), those combined, and each of them normalised (NFKC, zero-width characters removed).
 * A plain ASCII string with no backslash or percent sign has only itself.
 */
function variantsOf(text: string): string[] {
  if (!/[\\%]|[^\x20-\x7e]/.test(text)) return [text];
  const unescaped = unescapeText(text);
  const decoded = percentDecode(text);
  const decodedTwice = percentDecode(decoded);
  const spellings = [
    text,
    unescaped,
    decoded,
    decodedTwice,
    unescapeText(decoded),
    unescapeText(decodedTwice),
    percentDecode(unescaped),
  ];
  return [...new Set(spellings.flatMap((spelling) => [spelling, normalised(spelling)]))];
}

const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/**
 * A string that is, by the strict schema, not user text: a closed token or a UTC instant. It cannot
 * break a shape rule, and the denylist skips it (a project called `2026` or `setup` would otherwise be
 * found inside every instant and token and block export for good). A dotted version is deliberately
 * NOT here (FIX2A F2): it is checked, see {@link checkLeaf}.
 */
function isSchemaTyped(text: string): boolean {
  return BUNDLE_VOCABULARY.has(text) || INSTANT_PATTERN.test(text);
}

function denylistRuleOf(text: string, denylist: Denylist): DenylistRule | null {
  if (denylist.entries.length === 0) return null;
  for (const variant of variantsOf(text)) {
    const folded = foldForComparison(variant);
    const squashed = squash(folded);
    for (const entry of denylist.entries) {
      if (folded.includes(entry.folded)) return entry.rule;
      if (entry.squashed.length >= DENYLIST_MIN_LENGTH && squashed.includes(entry.squashed)) {
        return entry.rule;
      }
    }
  }
  return null;
}

/**
 * The rule one string breaks, or null: the shape rules first (on every spelling of the string), then
 * the owner's denylist, which skips strings the schema types as a token, an instant or a version.
 */
export function checkLeaf(value: string, denylist: Denylist): BundleRefusalCode | null {
  if (isSchemaTyped(value)) return null;
  for (const variant of variantsOf(value)) {
    const rule = shapeRuleOf(variant);
    if (rule !== null) return rule;
  }
  // A version leaf is position-aware (FIX2A F2): it is still run through the denylist, but its numeric
  // components are exempt, so a project called `2026` or `1.13` cannot match inside `1.13.7`. What is left
  // of a closed-shape version is at most a pre-release word of the bundle's own vocabulary; a leaf in a
  // version position that is not of that shape keeps its whole text and is checked like any other string.
  const subject = DOTTED_VERSION_PATTERN.test(value) ? value.replace(/[0-9.]+/g, "") : value;
  return denylistRuleOf(subject, denylist);
}

/**
 * Every key the strict schema can emit. Keys are fixed by the schema, so the denylist skips them
 * (a project called `status` or `plugin` must not block export); a key not on this list is checked
 * like any other string.
 */
export const BUNDLE_KEY_VOCABULARY: ReadonlySet<string> = new Set([
  "bundleVersion",
  "generatedAt",
  "versions",
  "plugin",
  "service",
  "obsidian",
  "electron",
  "node",
  "storeSchema",
  "platform",
  "os",
  "arch",
  "connection",
  "state",
  "subsystems",
  "id",
  "status",
  "reasonCode",
  "checkedAt",
  "freshness",
  "parts",
  "partId",
  "counts",
  "projects",
  "scanFolders",
  "openTasks",
  "reports",
  "pluginDiagnostics",
  "features",
  "reducedMotion",
  "transcriptAnalysis",
  "notifyApprovals",
  "launchers",
  "antigravity",
  "claude-code",
  "claude-desktop",
  "codex",
  "source",
  "code",
  "at",
]);

function checkKey(key: string, denylist: Denylist): BundleRefusalCode | null {
  if (BUNDLE_KEY_VOCABULARY.has(key)) return null;
  return checkLeaf(key, denylist);
}

/** The most strings and the deepest nesting the verifier walks; past either the value is not a bundle. */
const MAX_WALK_NODES = 50_000;
const MAX_WALK_DEPTH = 64;

interface Strings {
  readonly keys: Set<string>;
  readonly leaves: Set<string>;
  readonly overflow: boolean;
}

/** Every key and every string value inside a value, without recursion, within a budget. */
function stringsOf(root: unknown): Strings {
  const keys = new Set<string>();
  const leaves = new Set<string>();
  const stack: { value: unknown; depth: number }[] = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const { value, depth } = stack.pop() as { value: unknown; depth: number };
    nodes += 1;
    if (nodes > MAX_WALK_NODES || depth > MAX_WALK_DEPTH) return { keys, leaves, overflow: true };
    if (typeof value === "string") leaves.add(value);
    else if (Array.isArray(value)) {
      for (const item of value) stack.push({ value: item, depth: depth + 1 });
    } else if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        keys.add(key);
        stack.push({ value: item, depth: depth + 1 });
      }
    }
  }
  return { keys, leaves, overflow: false };
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
 * Checks a value before it is offered as a bundle, in this order:
 *
 * 1. every key and every string value, in every spelling (as written, JSON-unescaped,
 *    percent-decoded), against the shape rules and then the denylist ({@link checkLeaf});
 * 2. the serialisation and its percent-decoded copy against the shape rules, so nothing a leaf
 *    walk could miss survives;
 * 3. the strict schema (`schema-invalid`), then the size (`too-large`).
 *
 * The privacy rules run first on purpose: a bundle that is both malformed and leaky is refused for
 * the leak, which is the more useful answer. The result names the rule and never the value.
 */
export function verifyBundle(bundle: unknown, denylist: Denylist): VerifyResult {
  const strings = stringsOf(bundle);
  if (strings.overflow) return { ok: false, rule: "too-large" };
  for (const key of strings.keys) {
    const rule = checkKey(key, denylist);
    if (rule !== null) return { ok: false, rule };
  }
  for (const leaf of strings.leaves) {
    const rule = checkLeaf(leaf, denylist);
    if (rule !== null) return { ok: false, rule };
  }

  let text: string;
  try {
    text = JSON.stringify(bundle) ?? "";
  } catch {
    return { ok: false, rule: "schema-invalid" };
  }
  for (const variant of variantsOf(text)) {
    const rule = shapeRuleOf(variant);
    if (rule !== null) return { ok: false, rule };
  }

  if (!DiagnosticBundleSchema.safeParse(bundle).success) {
    return { ok: false, rule: "schema-invalid" };
  }
  if (utf8Length(JSON.stringify(bundle, null, 2)) > BUNDLE_MAX_BYTES) {
    return { ok: false, rule: "too-large" };
  }
  return { ok: true };
}

/** The one offered string, or the rule that refused. */
export type VerifiedSerialisation =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly rule: BundleRefusalCode };

/**
 * THE entry point for the preview, Copy and Save string (FIX2A F4; plans 08-13 and 08-16 must offer
 * nothing else). It serialises the bundle exactly once, parses that same text back, and runs
 * {@link verifyBundle} on the parsed copy and the shape rules on the text itself. The `text` it
 * returns is the text that was checked: a getter or `toJSON` that changes after this call cannot
 * change what is offered, because the bundle is never read again. A value that cannot be serialised
 * (a cycle, a throwing getter) is `schema-invalid`.
 */
export function verifyAndSerialise(bundle: unknown, denylist: Denylist): VerifiedSerialisation {
  let text: string | undefined;
  let parsed: unknown;
  try {
    text = JSON.stringify(bundle, null, 2);
    if (text === undefined) return { ok: false, rule: "schema-invalid" };
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, rule: "schema-invalid" };
  }
  const verdict = verifyBundle(parsed, denylist);
  if (!verdict.ok) return verdict;
  for (const variant of variantsOf(text)) {
    const rule = shapeRuleOf(variant);
    if (rule !== null) return { ok: false, rule };
  }
  if (utf8Length(text) > BUNDLE_MAX_BYTES) return { ok: false, rule: "too-large" };
  return { ok: true, text };
}
