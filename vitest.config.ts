import { defineConfig } from "vitest/config";

/**
 * Vitest 4 removed the standalone `vitest.workspace.ts` file format
 * entirely (there is no `--workspace` CLI flag any more) — per-package
 * configuration now lives here, in `test.projects`, with each entry
 * resolving to that package's own `vitest.config.ts`.
 *
 * This replaces the array-of-directory-strings `vitest.workspace.ts` from
 * plan 01-01, which — despite "vitest@4.1.11 accepted it without
 * complaint" (01-01-SUMMARY.md) — was in fact silently never read at all:
 * Vitest always ran a single default (root, `node`-environment) project.
 * Every package through plan 01-04 happened to want the default `node`
 * environment anyway, so the bug never surfaced. This plan's plugin
 * package needs `jsdom`, which is what exposed it (Rule 1 fix).
 */
export default defineConfig({
  test: {
    projects: [
      "packages/domain",
      "packages/keychain",
      "packages/operational-store",
      "packages/plugin",
      "packages/service",
      "packages/service-api-client",
      "packages/test-fixtures",
    ],
  },
});
