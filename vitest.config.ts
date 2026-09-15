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
 *
 * Every one of the twelve `packages/*` directories is listed here AND
 * carries its own `packages/<name>/vitest.config.ts`, even the five that
 * currently have zero test files (adapters, vault-repo, scheduler,
 * collectors, launchers). That second part matters more than it looks:
 * without a package's own config file, running `vitest run` *from inside
 * that package's own directory* (which is exactly what each package's own
 * `"test": "vitest run"` script does, and what `turbo run test` invokes
 * per-package) walks upward, finds *this* root config, and incorrectly
 * resolves `test.projects`'s relative paths against that package's cwd
 * instead of the repo root -- e.g. `packages/vault-repo` + `packages/domain`
 * becomes the nonsensical `packages/vault-repo/packages/domain`. A local
 * `vitest.config.ts` (nearest-file-wins) stops that upward walk before it
 * ever reaches this file, exactly like the other seven packages already do.
 */
export default defineConfig({
  test: {
    projects: [
      "packages/adapters",
      "packages/collectors",
      "packages/domain",
      "packages/keychain",
      "packages/launchers",
      "packages/operational-store",
      "packages/plugin",
      "packages/scheduler",
      "packages/service",
      "packages/service-api-client",
      "packages/test-fixtures",
      "packages/vault-repo",
    ],
  },
});
