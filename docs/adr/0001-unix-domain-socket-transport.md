---
status: accepted
satisfies: ADR-02 (partial — transport half)
---

# Plugin and service communicate over a Unix domain socket

The companion service holds OAuth refresh tokens and can launch processes, so
browser reachability is the dominant threat. A TCP loopback listener is
dialable by any page in any open browser tab, leaving Host/Origin validation
and bearer tokens as after-the-fact mitigations with a long history of
bypasses. A Unix domain socket is a filesystem object with no port, no IP, and
no scheme the browser network stack can resolve — `fetch`, `XMLHttpRequest`,
and `EventSource` cannot address it at all. We chose the socket, eliminating
DNS rebinding and localhost CSRF by construction rather than defending against
them.

## Considered Options

**TCP loopback with Host/Origin validation and per-install-secret bearer
tokens.** Rejected. Earlier research favoured it for forward-compatibility with
a future standalone desktop shell, but that argument does not survive: Electron
and Tauri both have native layers that dial a Unix socket as readily as Node
does. The only client that could never speak UDS is a pure browser-tab client
with no native layer, which this architecture does not have.

## Consequences

- Obsidian desktop plugins have documented Node access, so `require('http')`
  with `socketPath` is available. The manifest must set `isDesktopOnly: true`.
  This is not a community-review obstacle, and the project is macOS-only
  regardless.
- **`EventSource` is unavailable**, and with it the automatic reconnection and
  `Last-Event-ID` resumption it provides for free. `SVC-07` still requires that
  behaviour, so a reconnect-and-replay shim must be written by hand.
- macOS caps `sun_path` at 104 bytes. The socket must live at a short, stable
  path such as `~/.claude-command-center/svc.sock` — never under the randomized
  `$TMPDIR`, which is what broke `anthropics/claude-code#17658` at 116 chars.
- The daemon must `unlink()` before `bind()` at startup, or a crash leaves a
  stale socket file and the next start fails `EADDRINUSE`.
- Browser devtools cannot inspect this traffic; debugging uses
  `curl --unix-socket`.
- The socket's permissions are the whole access control. `0600` protects
  against other local users and against the browser engine. It does **not**
  isolate other processes running as the same user.
- No confirmed precedent exists for an Obsidian plugin talking to a companion
  daemon this way, though the pattern is well established elsewhere (1Password's
  SSH agent, Docker's socket, Apple's own launchd guidance). We are an early
  mover within this ecosystem.
