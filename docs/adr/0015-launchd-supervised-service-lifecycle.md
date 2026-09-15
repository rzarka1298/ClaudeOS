---
status: accepted
satisfies: ADR-01
---

# The companion service is a per-user launchd LaunchAgent, not a plugin-spawned child

The companion service is registered as a per-user `launchd` LaunchAgent
(`~/Library/LaunchAgents/com.claude-command-center.service.plist`) rather
than spawned as a child process by the Obsidian plugin. The plugin's
lifetime is the editor's; SVC-06 requires the service to keep running and
collecting events while Obsidian is closed. A plugin-spawned child would
die with its parent and would restart only when the user next opened
Obsidian — precisely when the telemetry missed during that gap no longer
exists to collect.

## Considered Options

**Plugin-spawned child process.** Rejected: ties the service's lifetime to
the editor's, defeating SVC-06 by construction, and gives the plugin a
process-management responsibility (spawn, supervise, restart-on-crash,
clean shutdown) that duplicates what the operating system already does
better.

**A system-wide daemon running as root** (a `LaunchDaemon` rather than a
`LaunchAgent`). Rejected: this is a single-user personal tool holding OAuth
tokens, Keychain secrets, and process-launch capability — running it as
root grants it privileges it has no reason to need and turns any bug in it
into a full local privilege-escalation surface (T-01-23 in this plan's
threat register). A per-user LaunchAgent runs with exactly the owner's own
privileges, the same as everything else on their account.

## Registration uses `bootstrap`/`bootout`/`kickstart`, never `load`/`unload`

`launchctl`'s `load` and `unload` subcommands have been deprecated since OS
X 10.10 and are documented across multiple independent 2026 sources
(`launchd.info`, `ss64.com/mac/launchctl.html`) to exit zero while doing
nothing on an already-bootstrapped or malformed property list — a failed
registration is silently indistinguishable from a successful one.
`scripts/launchagent/install.sh`, `uninstall.sh`, and `restart.sh` use only
`launchctl bootstrap gui/$(id -u) <plist>`, `launchctl bootout
gui/$(id -u)/<label>`, and `launchctl kickstart -k gui/$(id -u)/<label>`.
Neither deprecated subcommand, invoked through `launchctl`, appears
anywhere in this repository's scripts, README, or ADRs — enforced by a
literal grep in this plan's own `<verify>` block, not just this prose.

## The interpreter path is resolved at install time, not inherited

A `launchd` job runs with none of the installing shell's `PATH` or
environment. `install.sh` resolves `node`'s absolute path via `command -v`
in its own shell (failing with an actionable message if absent, or if its
major version is below 24) and writes that absolute path into the plist's
`ProgramArguments`, rather than trusting a bare `node` token to resolve at
run time. The plist also carries an explicit `PATH` in
`EnvironmentVariables` (`/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
covering both Apple Silicon and Intel Homebrew prefixes) for anything the
service itself shells out to.

## Crash-only keep-alive

`KeepAlive` is the dictionary form, `{ SuccessfulExit: false }`, not the
boolean `true`. This restarts the service after an abnormal exit (a crash)
but does not fight a deliberate, clean stop: `main.ts`'s `SIGTERM` handler
closes the socket server, unlinks the socket file, and calls
`process.exit(0)`, which `launchd` sees as a successful exit and does not
restart (T-01-24). Without this distinction, stopping the service would
require deregistering the LaunchAgent entirely rather than simply exiting
it.

## The deregister-before-foreground development convention

A registered LaunchAgent and a manually-run `node dist/main.js` in a
terminal cannot both bind the same Unix domain socket path at the same
time — whichever starts second meets a confusing `EADDRINUSE`/unlink race
with no visible cause. `01-CONTEXT.md` flagged this exact question as a
genuine gap in the existing ADR text. The convention: `pnpm run dev:service`
runs `scripts/launchagent/uninstall.sh` first (idempotent — a no-op if the
agent isn't currently registered) before starting the service in the
foreground, and this README documents the same convention explicitly (see
"Development loop").

## Consequences

- `pnpm run service:install` / `service:uninstall` / `service:restart` are
  the only supported ways to manage the LaunchAgent; nothing in this
  repository shells out to the deprecated subcommands.
- A developer who runs `pnpm run dev:service` never fights the LaunchAgent
  for the socket, because the script deregisters it first.
- Re-running `service:install` after a rebuild (a new `SERVICE_MAIN` path,
  or a Node upgrade changing `NODE_PATH`) is idempotent: `install.sh`
  boots the agent out before bootstrapping it fresh, so a stale
  registration is never left running alongside a new one.
- Login-start, crash-restart, and continuing to run with Obsidian closed
  are the parts of this ADR that only a real macOS session can observe —
  this plan's automated coverage is limited to property-list validity,
  script syntax, and the absence of the deprecated subcommands; the
  human-check in this plan's Task 4 covers the rest.
