import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Typed table declarations for the operational store (ADR-0009, ADR-0018).
 * This module is the source of truth `drizzle-kit generate` diffs to
 * produce `migrations/*.sql` — the generated SQL, not this file, is the
 * artifact `applyMigrations` (`./migrate.ts`) actually runs. Every column
 * is `text` because every value this store persists (timestamps, IDs,
 * enums) round-trips as a string; nothing here needs SQLite's numeric
 * affinity.
 */

/**
 * Singleton service metadata (`started_at`, `service_version`, …).
 * Created ad hoc by plan 01-01's `open-store.ts` before this baseline
 * migration existed; the migration takes ownership of the table going
 * forward (see the `IF NOT EXISTS` note in `migrations/0000_initial.sql`).
 */
export const serviceMeta = sqliteTable("service_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/**
 * A registered directory on disk (ADR-0003). Its absolute `path` is
 * private configuration that never reaches a tracked vault file; the
 * Project-to-Workspace binding lives here, on the Project side, per
 * ADR-0005 — a Workspace's stable ID is safe to reference from vault
 * content, a Project's path is not.
 *
 * Phase 4 (migration 0002, D-02) adds the owner's own choices only:
 * `pinned` (`"true"` / `"false"` per this file's all-text rule),
 * `last_opened_at` (drives the PROJ-15 order) and `github_url_override`
 * (an owner-typed `https://github.com/owner/repo`, RR-12). Git state is
 * NOT stored here — branch names, commit subjects and remote URLs are
 * read live and held in service memory only (D-46, PROJ-14).
 */
export const projects = sqliteTable("projects", {
  projectId: text("project_id").primaryKey(),
  path: text("path").notNull().unique(),
  workspaceId: text("workspace_id"),
  displayName: text("display_name").notNull(),
  registeredAt: text("registered_at").notNull(),
  pinned: text("pinned").notNull().default("false"),
  lastOpenedAt: text("last_opened_at"),
  githubUrlOverride: text("github_url_override"),
});

/**
 * A folder the owner asked the service to scan for project suggestions
 * (PROJ-02, D-02). `depth` is `"1"`..`"3"` stored as text per this file's
 * all-text rule. Suggestions themselves are derived on each scan and held
 * in service memory; only the owner's scan roots persist.
 *
 * Never stored here: the names or paths of folders a scan found, and any
 * error text from reading them.
 */
export const scanRoots = sqliteTable("scan_roots", {
  scanRootId: text("scan_root_id").primaryKey(),
  path: text("path").notNull().unique(),
  depth: text("depth").notNull().default("1"),
  addedAt: text("added_at").notNull(),
  lastScannedAt: text("last_scanned_at"),
});

/**
 * One row per launcher (`antigravity`, `claude-code`, `claude-desktop`):
 * the owner-confirmed configuration as JSON-in-text, validated with the
 * domain launcher-config schema before it is saved, plus whether a test
 * launch succeeded (`tested`, `"true"` / `"false"`, RR-14).
 *
 * `config_json` holds only bundle IDs, an absolute executable path and argv
 * TEMPLATE elements (with `{projectPath}` / `{script}` placeholders). Never
 * stored here, and none may be added (D-46, PROJ-14): a rendered command
 * line for a real project, launch stderr or exit output, a git remote URL
 * or its userinfo, or any credential.
 */
export const launcherConfig = sqliteTable("launcher_config", {
  launcherId: text("launcher_id").primaryKey(),
  configJson: text("config_json").notNull(),
  tested: text("tested").notNull().default("false"),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Every Run (Session or Automation Run, ADR-0006): the service mints
 * `run_id` and `claude_session_id` is a nullable correlation field, never
 * the key — a Run must be able to exist here before Claude assigns it a
 * session identity (SESS-17). Indexed on `state` because restart recovery
 * (`recoverInterruptedRuns`) queries by state on every service start.
 */
export const runs = sqliteTable(
  "runs",
  {
    runId: text("run_id").primaryKey(),
    kind: text("kind").notNull(),
    projectId: text("project_id").references(() => projects.projectId),
    claudeSessionId: text("claude_session_id"),
    state: text("state").notNull(),
    startedAt: text("started_at").notNull(),
    lastActivityAt: text("last_activity_at"),
    endedAt: text("ended_at"),
  },
  (table) => [index("runs_state_idx").on(table.state)],
);

/**
 * The scheduler's durable record shape (ADR-0013): milestone 1 stores it,
 * milestone 2's clock loop fills it. `idempotency_key` is the job ID
 * composed with its IANA-timezone schedule window, per ADR-0013.
 */
export const jobRuns = sqliteTable("job_runs", {
  jobRunId: text("job_run_id").primaryKey(),
  jobKey: text("job_key").notNull(),
  scheduledFor: text("scheduled_for").notNull(),
  startedAt: text("started_at"),
  state: text("state").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
});

/**
 * The managed vault's note-metadata cache (PERF-06): one row per note,
 * holding exactly what a filter or list view reads, so search stays
 * responsive at 10,000 notes without re-parsing 10,000 files' frontmatter
 * on every keystroke.
 *
 * Two properties of this table are load-bearing and deliberate:
 *
 * 1. **No body, content, or excerpt column exists, and none may be added.**
 *    The vault's Markdown files are the sole holder of durable note content
 *    (PRD §9.5); this store holds only derived metadata. Duplicating note
 *    prose here would put personal content in a second place that backup,
 *    redaction, and deletion would each have to learn about (threat
 *    T-02-10). A test asserts the absence via `PRAGMA table_info`.
 * 2. **The whole table is disposable.** Every row is reconstructible from
 *    the vault by `rebuildVaultNotes` (`./vault-notes-store.ts`), which is
 *    why losing or dropping it is a performance event, never a data-loss
 *    one.
 *
 * Indexed on `scope` and `stage` because those are the two filter axes the
 * knowledge views query by; `ai_generated` is stored as the strings
 * `"true"` / `"false"` per this file's all-text column rule.
 */
export const vaultNotes = sqliteTable(
  "vault_notes",
  {
    noteId: text("note_id").primaryKey(),
    path: text("path").notNull().unique(),
    scope: text("scope").notNull(),
    stage: text("stage").notNull(),
    aiGenerated: text("ai_generated").notNull(),
    claimType: text("claim_type"),
    confidence: text("confidence").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    contentHash: text("content_hash"),
  },
  (table) => [
    index("vault_notes_scope_idx").on(table.scope),
    index("vault_notes_stage_idx").on(table.stage),
  ],
);

/** Cache entries keyed by an opaque `cache_key`, source-attributed and hashed. */
export const cacheIndex = sqliteTable("cache_index", {
  cacheKey: text("cache_key").primaryKey(),
  source: text("source").notNull(),
  fetchedAt: text("fetched_at").notNull(),
  expiresAt: text("expires_at"),
  payloadHash: text("payload_hash").notNull(),
});
