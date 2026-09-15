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

/** Cache entries keyed by an opaque `cache_key`, source-attributed and hashed. */
export const cacheIndex = sqliteTable("cache_index", {
  cacheKey: text("cache_key").primaryKey(),
  source: text("source").notNull(),
  fetchedAt: text("fetched_at").notNull(),
  expiresAt: text("expires_at"),
  payloadHash: text("payload_hash").notNull(),
});
