-- SYNTHETIC current schema for the Codex thread store: the migrations table
-- and the 42 thread columns named in 05.1-RESEARCH.md R3 (names and types, no
-- data). Includes the identifier and prompt-derived columns the product must
-- never select. Not a copy of any real database.
CREATE TABLE _sqlx_migrations (
  version BIGINT PRIMARY KEY,
  description TEXT,
  installed_on TEXT,
  success BOOLEAN,
  checksum BLOB,
  execution_time BIGINT
);

CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  rollout_path TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  source TEXT,
  model_provider TEXT,
  cwd TEXT,
  title TEXT,
  sandbox_policy TEXT,
  approval_mode TEXT,
  tokens_used INTEGER,
  has_user_event INTEGER,
  archived INTEGER,
  archived_at INTEGER,
  git_sha TEXT,
  git_branch TEXT,
  git_origin_url TEXT,
  cli_version TEXT,
  first_user_message TEXT,
  agent_nickname TEXT,
  agent_role TEXT,
  memory_mode TEXT,
  model TEXT,
  reasoning_effort TEXT,
  agent_path TEXT,
  created_at_ms INTEGER,
  updated_at_ms INTEGER,
  thread_source TEXT,
  preview TEXT,
  recency_at INTEGER,
  recency_at_ms INTEGER,
  history_mode TEXT,
  name TEXT,
  is_pinned INTEGER,
  thread_section_id TEXT,
  section_position INTEGER,
  section_entered_at_ms INTEGER,
  project_id TEXT,
  originator TEXT,
  daybreak_enabled INTEGER,
  creator_user_id TEXT,
  creator_account_id TEXT
);
