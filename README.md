# Claude Command Center

[![CI](https://github.com/rzarka1298/ClaudeOS/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/rzarka1298/ClaudeOS/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-macOS-lightgrey)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6)

A local-first personal operating system for research, productivity, and software
development: an Obsidian plugin backed by a macOS companion service. It combines
a modular command-center dashboard, a managed knowledge vault with full
provenance tracking, Claude Code session visibility, project launchers, and a
human approval inbox — running entirely on the machine it's installed on, with
no data leaving localhost.

## Architecture

```
┌─────────────────────────────┐
│  Obsidian (plugin, TS)      │  UI shell, dashboard views,
│                             │  Vault API writes for open files
└──────────────┬──────────────┘
               │  Unix domain socket · loopback-only
               │  token-handshake auth (HMAC, short-lived)
┌──────────────▼──────────────┐
│  Companion service          │  Node 24 LTS · launchd-supervised
│                             │  starts at login, restarts on crash
│  ├─ Operational store       │  better-sqlite3 · versioned migrations
│  ├─ macOS Keychain          │  the only place secrets ever live
│  ├─ Managed vault writes    │  atomic temp-file → rename
│  └─ Event stream            │  server-push with replay + reconnect
└─────────────────────────────┘
```

A 12-package pnpm + Turborepo monorepo. Shared domain types are Zod schemas in
`packages/domain`, consumed directly by every other package — one source of
truth, zero codegen, compiler-checked across all consumers.

| Package | Role |
|---|---|
| `domain` | Zod schemas + inferred types shared by every consumer |
| `service` | Local HTTP/socket API, auth, logging, path allow-listing |
| `plugin` | Obsidian plugin (UI shell, lifecycle, vault-side writes) |
| `service-api-client` | Typed client the plugin uses to talk to the service |
| `vault-repo` | Managed-vault repository: atomic writes, indexes, repair |
| `operational-store` | SQLite store with a versioned migration runner |
| `keychain` | Typed wrapper over `/usr/bin/security` (no native deps) |
| `scheduler` / `collectors` / `adapters` / `launchers` | Scheduling, data collection, integration seams, app/terminal launching |
| `test-fixtures` | Cross-package integration and e2e test harnesses |

## Engineering highlights

- **Security as architecture, not policy.** The service binds to loopback/Unix
  domain sockets only — personal content is unreachable from the network.
  Secrets exist solely in the macOS Keychain: never in Markdown, config, logs,
  or git. The logger is structurally unable to emit credential-shaped values.
- **Nothing the user wrote can be destroyed.** Every managed-vault write is
  atomic (temp-file → rename); a crash mid-write can't leave a partial note,
  and files open for interactive editing are written through Obsidian's Vault
  API rather than raced from outside the editor.
- **Enforced module boundaries.** An ESLint boundary ruleset plus an
  independent grep backstop fail CI if, for example, vault code imports the
  Obsidian API or untrusted content crosses the trust boundary — the
  architecture is machine-checked, not tribal knowledge.
- **CI that gates everything.** Every commit runs formatting (Biome), linting,
  import-boundary checks, Obsidian's official plugin-policy lint
  (`eslint-plugin-obsidianmd`), strict typechecking, the full Vitest suite,
  secret scanning (gitleaks over full history), and a privacy scan that fails
  the build on personal data.
- **Decisions are written down.** Nineteen (and counting) architecture decision
  records in [`docs/adr/`](docs/adr/) — from transport selection and handshake
  auth to migration strategy and the untrusted-content boundary.
- **Test-driven where it counts.** Deterministic domain behavior (token auth,
  path containment, event replay, index generation) is built red → green with
  the failing test committed first.

## Getting started

**Prerequisites:** macOS · [Node.js 24 LTS](https://nodejs.org/) (`>=24.20.0`) ·
[pnpm](https://pnpm.io/) `11.24.0` via Corepack · Xcode Command Line Tools
(`better-sqlite3` compiles from source; without them `pnpm install` fails with
an opaque `node-gyp` error).

```sh
corepack enable
corepack prepare pnpm@11.24.0 --activate
pnpm run setup
```

`pnpm run setup` is the single documented command: it runs a preflight check
(Node/pnpm versions, Xcode CLT, `python3`), installs every workspace
dependency, and builds all twelve packages. Nothing else is required on a
clean clone — the repo runs against an empty example vault and contains no
personal data.

## Development

Run the companion service in the foreground:

```sh
pnpm run dev:service
```

This first deregisters the launchd-managed service (idempotent) — a registered
LaunchAgent and a foreground process cannot both bind the same socket path, and
without deregistering you'd hit a silent double-bind failure. Full reasoning in
[ADR-0015](docs/adr/0015-launchd-supervised-service-lifecycle.md).

Load the plugin by symlinking `packages/plugin` into a development vault's
`.obsidian/plugins/` directory and enabling it in Obsidian. The
[`hot-reload`](https://github.com/pjeby/hot-reload) community plugin picks up
`main.js` changes automatically.

### Running under launchd

In normal use the service is a per-user LaunchAgent — it starts at login and
restarts after a crash, independent of whether Obsidian is open:

```sh
pnpm run build             # produces packages/service/dist/main.js
pnpm run service:install   # registers and starts the LaunchAgent
pnpm run service:restart   # restarts after a code change
pnpm run service:uninstall # deregisters and removes the LaunchAgent
```

`service:install` resolves absolute paths for the `node` interpreter and the
service entrypoint at install time (launchd never inherits your shell `PATH`)
and registers via `launchctl bootstrap` — never the deprecated `load`/`unload`,
which exit zero while doing nothing on a malformed property list.

### Where runtime state lives

Everything the service writes at runtime — socket, SQLite store, logs, hook
spool — lives under `~/.claude-command-center/`, entirely outside the working
tree. Nothing under it is ever tracked.

## Testing & quality

```sh
pnpm run test        # full Vitest suite across all packages
pnpm run typecheck   # strict TypeScript, every package
pnpm run ci:privacy  # personal-data scan over the tracked tree
```

The same gates run in CI on every push; no job is allowed to
`continue-on-error`.

## Status

Actively developed. The live local foundation — authenticated socket
transport, Keychain-backed secrets, launchd lifecycle, migration-backed
operational store, and the full CI gate set — is complete. Current work: the
managed vault substrate (provenance-tracked notes, deterministic indexes,
crash-safe repair).

## License

[MIT](LICENSE)
