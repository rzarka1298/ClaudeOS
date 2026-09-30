import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Typed table declarations for the operational store (ADR-0009, ADR-0018).
 * This module is the source of truth `drizzle-kit generate` diffs to
 * produce `migrations/*.sql` — the generated SQL, not this file, is the
 * artifact `applyMigrations` (`./migrate.ts`) actually runs. Every column
 * is `text` because every value this store persists (timestamps, IDs,
 * enums) round-trips as a string. The exceptions are Phase 5's process
 * IDs, revisions, token counters and byte offsets: those are arithmetic
 * values (summed, compared, incremented in SQL), and each one's docblock
 * says so where it is declared.
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
 */
export const projects = sqliteTable("projects", {
  projectId: text("project_id").primaryKey(),
  path: text("path").notNull().unique(),
  workspaceId: text("workspace_id"),
  displayName: text("display_name").notNull(),
  registeredAt: text("registered_at").notNull(),
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
    /**
     * Phase 5 session facts (D-21). Every one is nullable: automation Runs
     * never carry them, and a Session's facts arrive piecemeal from hooks.
     * `pid` and `revision` are `integer` — the one departure from this
     * file's all-text rule — because the store compares `pid` numerically
     * with the liveness sweep's `kill(pid, 0)` target and increments
     * `revision` per upsert; a text round-trip would invite "0042" vs "42".
     * `pid_started_at` is the raw `ps -o lstart=` string, compared for
     * equality only. `cwd`, `worktree_root` and `transcript_path` are
     * private absolute paths that live only here (D-26, D-49).
     * `subagent_active_ids` is a JSON array of agent ids as text.
     * No column here holds a prompt, a reply or a tool input (D-49).
     */
    pid: integer("pid"),
    pidStartedAt: text("pid_started_at"),
    revision: integer("revision"),
    name: text("name"),
    model: text("model"),
    effort: text("effort"),
    launchSource: text("launch_source"),
    cwd: text("cwd"),
    worktreeRoot: text("worktree_root"),
    permissionMode: text("permission_mode"),
    activity: text("activity"),
    lastError: text("last_error"),
    claudeVersion: text("claude_version"),
    transcriptPath: text("transcript_path"),
    linkKind: text("link_kind"),
    linkedFromRunId: text("linked_from_run_id"),
    subagentActiveIds: text("subagent_active_ids"),
    subagentLastType: text("subagent_last_type"),
    terminateRequestedAt: text("terminate_requested_at"),
    endObservedAt: text("end_observed_at"),
  },
  (table) => [
    index("runs_state_idx").on(table.state),
    index("runs_claude_session_id_idx").on(table.claudeSessionId),
    index("runs_pid_idx").on(table.pid),
  ],
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

/**
 * A manual association (SESS-17, D-24): the owner's choice of project for a
 * Claude session, keyed by the Claude session ID so it applies to every later
 * Run of the same session (a resume is a new Run). It references
 * `projects.project_id`, so only a registered project can be chosen; nothing
 * is written to the vault or to `projects` itself (D-57).
 */
export const sessionOverrides = sqliteTable("session_overrides", {
  claudeSessionId: text("claude_session_id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.projectId),
  associatedAt: text("associated_at").notNull(),
});

/**
 * Every transcript `message.id` already counted (D-43, PR-11). A message's
 * usage appears on several transcript lines; inserting its ID here in the
 * same transaction as the aggregate add is what makes each message count
 * once. Identifiers only: no body, content, excerpt or text column exists,
 * and none may be added (D-49).
 */
export const usageSeenMessages = sqliteTable("usage_seen_messages", {
  messageId: text("message_id").primaryKey(),
  seenAt: text("seen_at").notNull(),
});

/**
 * Token counters by UTC quarter hour (wave 4 review, D-40, D-45, D-46),
 * keyed by bucket start, Claude session, project (`project_key`: a project
 * ID, or the empty string for unclassified), model and skill (`skill_key`:
 * empty when none is named). Quarter hours, not hours, because every real
 * zone offset is a multiple of 15 minutes, so a local-day range over
 * `bucket_start` is exact in :30 and :45 zones too. Replaces `usage_hourly`
 * (migration 0003 carries its rows over). The four counters are `integer`
 * because SQL adds into them. Counters and identifiers only: no body,
 * content, excerpt or text column exists, and none may be added (D-49).
 * Every row is recomputable by rescanning transcripts from a zero cursor.
 */
export const usageQuarterHourly = sqliteTable(
  "usage_quarter_hourly",
  {
    bucketStart: text("bucket_start").notNull(),
    claudeSessionId: text("claude_session_id").notNull(),
    projectKey: text("project_key").notNull(),
    model: text("model").notNull(),
    skillKey: text("skill_key").notNull(),
    input: integer("input").notNull(),
    output: integer("output").notNull(),
    cacheWrite: integer("cache_write").notNull(),
    cacheRead: integer("cache_read").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.bucketStart,
        table.claudeSessionId,
        table.projectKey,
        table.model,
        table.skillKey,
      ],
    }),
  ],
);

/**
 * The coverage ledger (D-44): one row per local calendar day a transcript
 * scan covered. A range reaching a day absent here is `partial`.
 */
export const coverageDays = sqliteTable("coverage_days", {
  day: text("day").primaryKey(),
  recordedAt: text("recorded_at").notNull(),
});

/**
 * Per-transcript scanner cursors (D-40). `path` is a private absolute path
 * that lives only in this store (D-49). `size` and `offset` are `integer`
 * byte counts the scanner compares and advances. No content column exists,
 * and none may be added.
 */
export const transcriptCursors = sqliteTable("transcript_cursors", {
  path: text("path").primaryKey(),
  inode: text("inode").notNull(),
  size: integer("size").notNull(),
  offset: integer("offset").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * The latest plan-capacity observation per window (D-43: latest wins). The
 * percentage is text like every other value this store keeps un-summed.
 * Counters and identifiers only: no content column exists (D-49).
 */
export const capacitySnapshots = sqliteTable("capacity_snapshots", {
  window: text("window").primaryKey(),
  usedPercent: text("used_percent").notNull(),
  resetsAt: text("resets_at"),
  observedAt: text("observed_at").notNull(),
  claudeSessionId: text("claude_session_id"),
});

/**
 * The latest status-line `cost.total_cost_usd` per Claude session (D-42).
 * It is a running total, so the store keeps the latest value and never sums
 * two snapshots. No content column exists, and none may be added (D-49).
 */
export const costSnapshots = sqliteTable("cost_snapshots", {
  claudeSessionId: text("claude_session_id").primaryKey(),
  totalCostUsd: text("total_cost_usd").notNull(),
  firstObservedAt: text("first_observed_at").notNull(),
  observedAt: text("observed_at").notNull(),
});

/**
 * Service-side collector settings (D-47, D-48), e.g.
 * `transcript_analysis_enabled`. The service is the source of truth; an
 * absent key means the default (analysis off).
 */
export const collectorSettings = sqliteTable("collector_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Every transcript-analysis toggle, in order (D-44, D-47): days while
 * analysis was off are uncovered, and this log is how a range knows which
 * days those were. `enabled` is the string `"true"` or `"false"`.
 */
export const analysisToggleLog = sqliteTable("analysis_toggle_log", {
  at: text("at").primaryKey(),
  enabled: text("enabled").notNull(),
});
