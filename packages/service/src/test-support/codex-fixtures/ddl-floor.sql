-- SYNTHETIC floor schema for the Codex thread store: the migrations table and
-- only the eight required thread columns (names and types, no data).
-- Reproduces the column LIST recorded in 05.1-RESEARCH.md R3; not a copy of
-- any real database.
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
  cwd TEXT,
  source TEXT,
  cli_version TEXT,
  archived INTEGER,
  updated_at_ms INTEGER,
  created_at_ms INTEGER
);
