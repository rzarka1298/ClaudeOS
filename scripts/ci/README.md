# CI job → local command map

Every job in `.github/workflows/ci.yml` invokes a root `package.json` script
(`pnpm run ci:<name>`) rather than inlining a command. A job is only allowed
to exist in that workflow file if a developer can run it identically on a
local checkout — that's the rule, not just a convention.

| CI job         | Local command                                                              | What it checks |
| -------------- | --------------------------------------------------------------------------- | --------------- |
| `setup`        | `pnpm install --frozen-lockfile`                                            | The dependency install itself refuses to silently resolve an unreviewed lockfile change. |
| `format`       | `pnpm run ci:format` (`biome ci .`)                                         | Formatting matches Biome's output exactly; nothing left unformatted. |
| `lint`         | `pnpm run ci:lint` (`biome lint .`)                                         | Biome's recommended lint rules across every package outside `packages/plugin`. |
| `boundaries`   | `pnpm run ci:boundaries` (`turbo run build && eslint --config eslint.config.mjs packages --ext .ts,.tsx …`) | The import-boundary element map (REPO-03) — a forbidden cross-package import fails the build. The full build runs first because every package's `exports` map resolves through `dist/`: without it `eslint-plugin-boundaries` classifies each cross-package import as unresolvable and silently reports nothing (plan 03-01; ADR-0019). Building only `@ccc/plugin` was measured to leave `@ccc/adapters` unresolvable and two violation fixtures silent, so the build is deliberately unfiltered. |
| `backstop`     | `pnpm run ci:backstop` (`sh scripts/check-boundaries.sh`)                   | The literal grep backstop layered under the lint rule — catches a boundary config that silently stopped matching. |
| `obsidianmd`   | `pnpm run ci:obsidianmd` (`cd packages/plugin && pnpm exec eslint --config eslint.config.mjs src --ext .ts,.tsx`) | Obsidian's own plugin-review-bot rule set (REPO-05/REPO-06) plus this repository's `DOM_SAFETY_RULES` and `NETWORK_ISOLATION_RULES`, scoped to `packages/plugin` only. `.tsx` is in the extension list so every Preact widget component is inside the lint's reach. |
| `typecheck`    | `pnpm run ci:typecheck` (`turbo run typecheck`)                             | Every package's `tsc -b` project-reference build. |
| `test`         | `pnpm run ci:test` (`turbo run test`)                                      | Every package's Vitest suite. |
| `privacy`      | `pnpm run ci:privacy` (`sh scripts/check-privacy.sh`)                       | No tracked file carries the owner's home-directory prefix, email address, or a maintained denylist pattern (PRIV-01/PRIV-02). |
| `secrets`      | `gitleaks detect --no-git --source . --config .gitleaks.toml` (the CI job itself uses the official `gitleaks/gitleaks-action@v2` over full git history, `fetch-depth: 0`) | No credential-shaped string, including this project's own `v1.<payload>.<signature>` bearer-token shape, appears anywhere in the repository's committed history. |

Every gate job (`format` through `privacy`) depends on `setup` in the
workflow graph — `setup` proves the frozen-lockfile install itself succeeds
before any gate runs against it. Because GitHub Actions runners don't share
a filesystem across jobs, each gate job repeats the same checkout/Node/
pnpm-install sequence `setup` uses; this is the "shared setup" every job
depends on in the sense that every job runs the identical install sequence,
not that a filesystem is literally shared across runners. The gate jobs
themselves then run in parallel with each other, serialized only behind
`setup`. `secrets` is the one exception: `gitleaks/gitleaks-action@v2` needs
no pnpm install at all, so it runs standalone against a full-history
checkout rather than depending on `setup`.

No job in `.github/workflows/ci.yml` sets a soft-fail/tolerate-failure
setting on any step. A red job is always a red build.

## Reproducing a clean-clone CI result locally

`sh scripts/clean-tree-check.sh '<command>'` is the sanctioned way to
reproduce a clean-clone CI result on a developer machine: it copies the
working tree into a temp directory with no `node_modules`, `dist/`,
`.turbo/` or `*.tsbuildinfo`, runs `pnpm install --frozen-lockfile` there,
and runs the given command inside that copy. Use it for any gate whose
result could be supplied by stale build output — the `boundaries` job is the
one that actually was (`.planning/phases/02-managed-vault-substrate/deferred-items.md`,
item 2), and the reason a local pass alone proves nothing.
