import type {
  BundleRefusalCode,
  DenylistInput,
  DiagnosticBundleInput,
} from "./diagnostic-bundle.js";
import { type DiagnosticsHealthResponse, DiagnosticsHealthResponseSchema } from "./diagnostics.js";

/**
 * The hostile corpus of the diagnostic bundle (plan 08-09; D-14, T-08-23, T-08-24). Test data, not
 * product code: only the full barrel exports it, the browser barrel leaves it out.
 *
 * Every sample that looks like a home path, an email address, a token or an owner's name is
 * assembled at run time from harmless pieces (the 2ed79b99 precedent), so this tracked file holds
 * no literal that the repository's own privacy scan or a secret scanner would flag, and no real
 * name, path or key. The user segment is the made-up `alice-example`.
 */

const join = (...pieces: string[]): string => pieces.join("");

/** The made-up macOS user name every path sample uses. */
export const SYNTHETIC_USER = join("alice", "-", "example");
const USERS = join("/Us", "ers/");
const SLASH_ESCAPED = join("\\", "/");
const UNICODE_SLASH = join("\\", "u002", "f");
const PERCENT_SLASH = join("%2", "F");
const AT = join("@");

/**
 * The owner data the denylist is built from in the corpus. Chosen so no entry is a substring of
 * another, so every name sample is refused by exactly the rule that owns it.
 */
export const CORPUS_DENYLIST_INPUT: DenylistInput = {
  projectNames: ["Orchard Ledger"],
  folderBasenames: ["plum-cellar"],
  github: [{ owner: "someone-example", repo: "quince-engine" }],
  vaultName: "Field Notes",
  userName: SYNTHETIC_USER,
};

export interface HostileSample {
  readonly name: string;
  readonly rule: BundleRefusalCode;
  readonly value: string;
}

/** Path, email and token shapes: refused by a built-in rule, whatever the denylist holds. */
export const HOSTILE_SHAPE_SAMPLES: readonly HostileSample[] = [
  {
    name: "a home path",
    rule: "home-path",
    value: join(USERS, SYNTHETIC_USER, "/Documents/notes"),
  },
  {
    name: "a home path with a trailing slash",
    rule: "home-path",
    value: join(USERS, SYNTHETIC_USER, "/"),
  },
  {
    name: "a home path without a trailing slash",
    rule: "home-path",
    value: join(USERS, SYNTHETIC_USER),
  },
  {
    name: "a home path with a space in the user segment",
    rule: "home-path",
    value: join(USERS, "alice example", "/notes"),
  },
  {
    name: "a home path with escaped slashes",
    rule: "home-path",
    value: join(SLASH_ESCAPED, "Users", SLASH_ESCAPED, SYNTHETIC_USER, SLASH_ESCAPED, "x"),
  },
  {
    name: "a home path with unicode-escaped slashes",
    rule: "home-path",
    value: join(UNICODE_SLASH, "Users", UNICODE_SLASH, SYNTHETIC_USER, UNICODE_SLASH, "x"),
  },
  {
    name: "a home path with percent-encoded slashes",
    rule: "home-path",
    value: join(PERCENT_SLASH, "Users", PERCENT_SLASH, SYNTHETIC_USER, PERCENT_SLASH, "x"),
  },
  {
    name: "a home path with the folder name in other letter cases",
    rule: "home-path",
    value: join("/uSe", "rs/", SYNTHETIC_USER, "/x"),
  },
  {
    name: "a home path in full-width characters",
    rule: "home-path",
    value: join("\uFF0F", "Users", "\uFF0F", SYNTHETIC_USER),
  },
  {
    name: "a home path with a zero-width character inside",
    rule: "home-path",
    value: join("/Us", "\u200B", "ers/", SYNTHETIC_USER),
  },
  {
    name: "a home path percent-encoded twice",
    rule: "home-path",
    value: join("%252F", "Users", "%252F", SYNTHETIC_USER),
  },
  { name: "a Linux home path", rule: "home-path", value: join("/ho", "me/dev/x") },
  { name: "a file URL", rule: "home-path", value: join("file", ":///x") },
  { name: "a macOS temporary folder", rule: "home-path", value: join("/var/", "folders/ab/T/x") },
  {
    name: "a private temporary folder",
    rule: "home-path",
    value: join("/private/", "var/folders/ab/T/x"),
  },
  {
    name: "an end-to-end run root",
    rule: "home-path",
    value: join("/tm", "p/ccc-uat.abc123/vault"),
  },
  { name: "a tilde path", rule: "tilde-path", value: join("~", "/Documents") },
  { name: "a $HOME path", rule: "tilde-path", value: join("$", "HOME/x") },
  { name: "a braced $HOME path", rule: "tilde-path", value: join("${", "HOME}/x") },
  { name: "a plain email address", rule: "email", value: join("someone", AT, "mail", ".", "co") },
  {
    name: "a plus-tagged email on a subdomain",
    rule: "email",
    value: join("A+tag", AT, "sub.domain", ".io"),
  },
  {
    name: "a bearer token shape",
    rule: "token-shaped",
    value: join("v1", ".", "abcdefgh12", ".", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123"),
  },
  {
    name: "a provider-prefixed key",
    rule: "token-shaped",
    value: join("sk", "-ant-", "api03-", "AbCdEfGhIjKlMnOp"),
  },
  {
    name: "a code-host personal access token",
    rule: "token-shaped",
    value: join("gh", "p_", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"),
  },
  {
    name: "a 40-character hex string",
    rule: "token-shaped",
    value: join("0123456789abcdef", "0123456789abcdef", "01234567"),
  },
  {
    name: "a 44-character base64-like string",
    rule: "token-shaped",
    value: join("AbCdEfGhIjKlMnOpQrStUvWxYz", "0123456789", "+/AbCdEf"),
  },
  {
    name: "a JWT",
    rule: "token-shaped",
    value: join("ey", "Jhbgc", ".", "eyJzdWIiOiJ4", ".", "abcDEF123_-xyz"),
  },
  {
    name: "a UUID",
    rule: "token-shaped",
    value: join("123e4567", "-", "e89b", "-", "12d3", "-", "a456", "-", "426614174000"),
  },
];

/** A name variant and the rule that must refuse it, for the corpus denylist. */
export const HOSTILE_NAME_SAMPLES: readonly HostileSample[] = [
  { name: "the project name", rule: "denylist-project", value: "Orchard Ledger" },
  { name: "the project name upper-cased", rule: "denylist-project", value: "ORCHARD LEDGER" },
  {
    name: "the project name inside a longer token",
    rule: "denylist-project",
    value: "xxorchard ledgerxx",
  },
  {
    name: "the project name with a zero-width space inside",
    rule: "denylist-project",
    value: join("Orch", "​", "ard Ledger"),
  },
  {
    name: "the project name in full-width letters",
    rule: "denylist-project",
    value: "Ｏｒｃｈａｒｄ　Ｌｅｄｇｅｒ",
  },
  {
    name: "the project name with diacritics",
    rule: "denylist-project",
    value: join("Órchard L", "é", "dger"),
  },
  {
    name: "the project name with other separators",
    rule: "denylist-project",
    value: "orchard_ledger",
  },
  { name: "the project name with no separator", rule: "denylist-project", value: "OrchardLedger" },
  { name: "the folder name", rule: "denylist-folder", value: "plum-cellar" },
  { name: "the folder name with underscores", rule: "denylist-folder", value: "plum_cellar" },
  { name: "the folder name without the hyphen", rule: "denylist-folder", value: "plumcellar" },
  { name: "the GitHub owner", rule: "denylist-github", value: "someone-example" },
  { name: "the GitHub repository", rule: "denylist-github", value: "quince-engine" },
  {
    name: "the GitHub owner/repository",
    rule: "denylist-github",
    value: "someone-example/quince-engine",
  },
  { name: "the vault name", rule: "denylist-vault", value: "Field Notes" },
  { name: "the vault name in a different case", rule: "denylist-vault", value: "field NOTES" },
  { name: "the macOS user name", rule: "denylist-user", value: SYNTHETIC_USER },
];

/** Forms the privacy script allows: they must not be refused by a shape rule. */
export const PASS_THROUGH_SAMPLES: readonly { readonly name: string; readonly value: string }[] = [
  { name: "the USERNAME placeholder home path", value: join(USERS, "USERNAME", "/Library/x") },
  { name: "the lower-case username placeholder", value: join(USERS, "username", "/x") },
  { name: "the angle-bracket placeholder", value: join(USERS, "<username>", "/x") },
  { name: "the $USER placeholder", value: join(USERS, "$USER", "/x") },
  { name: "the you placeholder", value: join(USERS, "you", "/x") },
  { name: "an example.com address", value: join("person", AT, "example", ".com") },
  { name: "an example.org address", value: join("person", AT, "example", ".org") },
  { name: "an example.net address", value: join("person", AT, "example", ".net") },
];

/** A canary no real value can equal; the builder tests seed it into every free-text source field. */
export const CORPUS_CANARY = join("CANARY", "-", "9f2c1e", "-", "unique");

// ---------------------------------------------------------------------------
// Clean inputs: what the builder, the matrix and the property test start from

const INSTANT = "2026-10-22T09:00:00.000Z";

const part = (
  partId: string,
  reasonCode: string,
  status: string,
  extra: Record<string, unknown> = {},
) => ({ partId, status, reasonCode, ...extra });

const row = (
  id: string,
  reasonCode: string,
  status: string,
  extra: Record<string, unknown> = {},
) => ({ id, status, reasonCode, checkedAt: INSTANT, freshness: "live", ...extra });

const COMMON = {
  generatedAt: INSTANT,
  service: { version: "0.1.0", startedAt: INSTANT, storeSchemaVersion: 12 },
  keychain: { installSecret: "present", researchKey: "absent" },
  paths: { vault: null, runtimeDir: "~/.example-runtime", socket: "~/.example-runtime/svc.sock" },
  vaultFingerprint: null,
};

/** A fresh install: five setup-needed rows, parts on collectors, scheduler and launchers. */
export function freshInstallHealth(): DiagnosticsHealthResponse {
  return DiagnosticsHealthResponseSchema.parse({
    ...COMMON,
    rows: [
      row("vault", "vault-not-set-up", "setup-needed"),
      row("hooks", "hooks-not-installed", "setup-needed"),
      row("collectors", "statusline-not-installed", "setup-needed", {
        parts: [
          part("telemetry", "telemetry-ok", "ok"),
          part("status-line", "statusline-not-installed", "setup-needed"),
          part("transcript-analysis", "analysis-off", "setup-needed"),
          part("spool", "spool-clean", "ok"),
          part("codex-install", "codex-not-installed", "setup-needed"),
          part("codex-hooks", "codex-hooks-not-installed", "setup-needed"),
          part("codex-bridge", "codex-bridge-not-installed", "setup-needed"),
          part("codex-doctor", "codex-doctor-not-run", "setup-needed"),
        ],
      }),
      row("scheduler", "never-run", "setup-needed", {
        parts: [
          part("last-run", "never-run", "setup-needed"),
          part("research-key", "research-key-missing", "setup-needed"),
          part("sources", "sources-configured", "ok"),
        ],
      }),
      row("launchers", "launcher-not-set-up", "setup-needed", {
        parts: ["antigravity", "claude-code", "claude-desktop", "codex"].map((id) =>
          part(id, "launcher-not-set-up", "setup-needed"),
        ),
      }),
    ],
    counts: { projects: null, scanFolders: null, openTasks: null, reports: null },
  });
}

/** A busy install: every kind of row, facts, setup actions, a fingerprint and display paths the bundle must drop. */
export function richHealth(): DiagnosticsHealthResponse {
  return DiagnosticsHealthResponseSchema.parse({
    ...COMMON,
    paths: {
      vault: "~/Notes/vault",
      runtimeDir: "~/.example-runtime",
      socket: "~/.example-runtime/svc.sock",
    },
    vaultFingerprint: { salt: "0123456789abcdef0123456789abcdef", digest: "0123456789abcdef" },
    rows: [
      row("vault", "vault-ready", "ok"),
      row("hooks", "events-silent", "unknown", { facts: { silenceThresholdMs: 600000 } }),
      row("collectors", "spool-dropped-records", "degraded", {
        facts: { dropCount: 4, dropsSince: INSTANT },
        parts: [
          part("telemetry", "telemetry-ok", "ok"),
          part("status-line", "statusline-reporting", "ok"),
          part("transcript-analysis", "analysis-on", "ok"),
          part("spool", "spool-dropped-records", "degraded", {
            facts: { dropCount: 4, dropsSince: INSTANT },
          }),
          part("codex-install", "codex-installed", "ok"),
          part("codex-hooks", "codex-hooks-receiving", "ok"),
          part("codex-bridge", "codex-bridge-ready", "ok"),
          part("codex-doctor", "codex-doctor-warning", "degraded", {
            setupAction: { kind: "go-to-section", section: "integrations" },
          }),
        ],
      }),
      row("scheduler", "run-all-sources-failed", "degraded", {
        parts: [
          part("last-run", "run-all-sources-failed", "degraded", {
            setupAction: { kind: "go-to-section", section: "research" },
            facts: { lastFailureAt: INSTANT },
          }),
          part("research-key", "research-key-present", "ok"),
          part("sources", "sources-configured", "ok", { facts: { sourceCount: 3 } }),
        ],
      }),
      row("launchers", "bundle-not-found", "failing", {
        parts: [
          part("antigravity", "bundle-not-found", "failing"),
          part("claude-code", "launcher-ready", "ok"),
          part("claude-desktop", "launcher-untested", "setup-needed"),
          part("codex", "launcher-not-set-up", "setup-needed"),
        ],
      }),
    ],
    counts: { projects: 3, scanFolders: 1, openTasks: 12, reports: 2 },
  });
}

/** A clean bundle input: nothing in it is a name, a path, an address or a token. */
export function cleanBundleInput(
  overrides: Partial<DiagnosticBundleInput> = {},
): DiagnosticBundleInput {
  return {
    generatedAt: "2026-10-22T09:30:00.000Z",
    health: richHealth(),
    connection: "live",
    vaultCheck: "match",
    versions: { plugin: "0.1.0", obsidian: "1.13.7", electron: "37.2.1", node: "24.20.0" },
    platformArch: "arm64",
    features: {
      reducedMotion: "auto",
      transcriptAnalysis: true,
      notifyApprovals: true,
      launchers: {
        antigravity: "tested",
        "claude-code": "set-up",
        "claude-desktop": "not-set-up",
        codex: "not-set-up",
      },
    },
    pluginDiagnostics: [
      {
        source: "layout",
        code: "override-invalid",
        message: "The layout file was ignored.",
        at: INSTANT,
      },
      { source: "layout", code: "unknown-widget", message: "Layout entry skipped.", at: INSTANT },
    ],
    ...overrides,
  };
}
