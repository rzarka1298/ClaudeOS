---
status: accepted
satisfies: ADR-03 (migration strategy; ADR-0009 carries the technology)
---

# drizzle-kit generates the SQL; a hand-rolled applier tracks the version

The operational store's schema (`service_meta`, `projects`, `runs`, `job_runs`,
`cache_index`) is declared once in `packages/operational-store/src/schema.ts`
using `drizzle-orm`'s SQLite table builders, and `drizzle-kit generate` diffs
that declaration into versioned SQL under `migrations/`. The generated file —
not the schema module — is the artifact of record: it is committed, reviewed,
and never regenerated silently by a startup process. Decided by the owner at
the Task 1 `checkpoint:decision` (`gate="blocking-human"`) in plan 01-04, on
2026-09-16.

## Considered Options

**Option 1 (chosen): drizzle-kit generate, hand-rolled apply.** `drizzle-orm`
is already the query-builder choice research recommended for this stack, so
the marginal cost of `drizzle-kit` is one dev dependency, and the
diff-and-generate workflow removes the hand-written-migration-SQL failure
mode from a path run-recovery correctness depends on (SVC-11).

**Option 2: hand-rolled numbered SQL files plus a `schema_version` table, no
generator.** No extra dependency, fully legible. Rejected because the
developer hand-writes every migration's `CREATE TABLE`/`ALTER TABLE` by hand
forever, and an ordering or transactional mistake in that hand-written SQL is
exactly the class of bug this store's correctness guarantees cannot tolerate.

The two options differ only in how migration SQL is *produced*. What actually
*applies* it is the same either way, and it is neither drizzle-orm's own
migrator nor a raw `drizzle-kit` runtime call:

## Why the applier is hand-rolled instead of `drizzle-orm`'s built-in migrator

`drizzle-orm/better-sqlite3/migrator`'s `migrate()` tracks applied migrations
in its own `__drizzle_migrations` table, keyed by a content hash read from
`migrations/meta/_journal.json`. That satisfies "idempotent" but not this
project's specific correctness requirements: a literal, queryable
`schema_version` value (`packages/operational-store/src/migrate.ts` — grep
`schema_version`), and a named `SchemaAheadOfCodeError` thrown when a
database's recorded version is higher than the highest migration this build
knows about, rather than the migrator's own (undocumented for this exact
case) behavior. `applyMigrations()` therefore reads `migrations/*.sql` in
filename order directly, tracks a `schema_version` integer it owns, and
applies each file inside its own `better-sqlite3` transaction that also
writes the new version — so schema and version can never disagree, and a
migration that throws part-way leaves the database at its previous version
(the transaction rolls back automatically).

## The baseline migration must tolerate a pre-existing `service_meta`

`packages/operational-store/src/open-store.ts` (plan 01-01) creates
`service_meta` ad hoc on every `openStore()` call, and `openStore()` runs
before `applyMigrations()` in the service startup sequence
(`packages/service/src/main.ts`). `drizzle-kit generate`'s default output is
a plain `CREATE TABLE` with no `IF NOT EXISTS`, which would fail on the very
first service start after this migration lands. `migrations/0000_initial.sql`
is hand-edited (documented in the file itself) to add `IF NOT EXISTS` to
every `CREATE TABLE` / `CREATE [UNIQUE] INDEX` statement it contains, making
the baseline migration idempotent regardless of what `open-store.ts` already
created. A future migration that adds a genuinely new table does not need
this treatment — only the baseline, which inherits a table an earlier plan
already owns.

## Consequences

- Every later migration is generated the same way: change `schema.ts`, run
  `pnpm exec drizzle-kit generate`, review and commit the resulting SQL file
  alongside its `meta/` journal entry.
- `applyMigrations()` never imports `drizzle-kit` at runtime — it is a
  generation-time tool only, so the running service has no dependency on it.
- Opening a database whose `schema_version` is ahead of the code (an older
  build against a newer database) fails loudly with `SchemaAheadOfCodeError`
  rather than silently downgrading or half-applying.
- `applyMigrations()` runs after `openStore()` and before the socket begins
  accepting connections (`packages/service/src/main.ts`), so no request is
  ever served against a stale schema.
