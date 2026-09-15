# Claude Command Center

A personal, local-first command center for research, productivity, and
software development: an Obsidian plugin backed by a macOS companion
service. It combines a modular dashboard, a managed Obsidian knowledge
vault, Claude Code session visibility, skill launching, project shortcuts,
and a human approval inbox — all running entirely on the machine it's
installed on.

## Prerequisites

- macOS
- [Node.js 24 LTS](https://nodejs.org/) (`>=24.20.0`)
- [pnpm](https://pnpm.io/) `11.24.0`, installed via Corepack (see Setup below)
- Xcode Command Line Tools — required because `better-sqlite3`, the
  operational store's SQLite binding, compiles from source at install
  time. Without these tools installed, `pnpm install` fails with an opaque
  `node-gyp` compiler error rather than an actionable message.

## Setup

```sh
corepack enable
corepack prepare pnpm@11.24.0 --activate
pnpm run setup
```

`pnpm run setup` is the single documented command: it runs a preflight
check (Node/pnpm versions, Xcode Command Line Tools, `python3`), installs
every workspace dependency, and builds all twelve packages. Nothing else
is required on a clean clone.

## Development loop

Run the companion service in the foreground:

```sh
pnpm run dev:service
```

This deregisters the launchd-managed service first (idempotent — a no-op
if it isn't currently registered), because a registered LaunchAgent and a
manually-run foreground process cannot both bind the same Unix domain
socket path at once: without deregistering first, you'd hit a confusing
silent double-bind failure whose cause is invisible. See
[`docs/adr/0015-launchd-supervised-service-lifecycle.md`](docs/adr/0015-launchd-supervised-service-lifecycle.md)
for the full reasoning.

Load the Obsidian plugin by symlinking `packages/plugin` into a
development vault's `.obsidian/plugins/` directory, then enable it from
Obsidian's Community plugins settings. The
[`hot-reload`](https://github.com/pjeby/hot-reload) community plugin will
reload the bundle automatically as `packages/plugin/main.js` changes.

## Running the service under launchd

The companion service is normally supervised by `launchd` as a per-user
LaunchAgent — it starts at login and restarts automatically after a crash,
independent of whether Obsidian is open (SVC-05, SVC-06). Manage it with:

```sh
pnpm run build            # produces packages/service/dist/main.js
pnpm run service:install   # registers and starts the LaunchAgent
pnpm run service:restart   # restarts after a code change (launchctl kickstart -k)
pnpm run service:uninstall # deregisters and removes the LaunchAgent
```

`service:install` resolves an absolute `node` interpreter path and an
absolute path to `packages/service/dist/main.js` at install time — a
launchd job never inherits your shell's `PATH` — and registers via
`launchctl bootstrap` (never the deprecated `load`/`unload` subcommands,
which exit zero while doing nothing on an already-registered or malformed
property list). Logs are written to
`~/.claude-command-center/logs/service.out.log` and
`~/.claude-command-center/logs/service.err.log`.

## Where runtime state lives

Everything the companion service writes at runtime — the Unix domain
socket, the SQLite operational store, logs, and the hook spool — lives
under `~/.claude-command-center/`. Nothing under that directory is ever
tracked in this repository; it exists entirely outside the working tree.
