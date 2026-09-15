import { defineConfig } from "drizzle-kit";

/**
 * Points `drizzle-kit generate` at `schema.ts` and diffs it into versioned
 * SQL under `migrations/` (ADR-0018). This config is a generation-time tool
 * input only — `applyMigrations` (`./src/migrate.ts`) never imports it and
 * never runs `drizzle-kit` itself; the committed `migrations/*.sql` files
 * are the artifact of record the service actually applies.
 */
export default defineConfig({
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "sqlite",
});
