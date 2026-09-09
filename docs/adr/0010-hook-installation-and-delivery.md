---
status: accepted
satisfies: ADR-06
---

# Hooks install at user level and deliver over the socket with a spool fallback

Telemetry reaches the companion service through Claude Code `command` hooks
registered in `~/.claude/settings.json` with `"async": true`. Each hook writes
its stdin payload to the service's Unix socket, and falls back to appending to
a local spool file when the connect fails; the service drains the spool at
startup. Milestone 1 subscribes to session, stop, notification, subagent and
task events — not `PreToolUse`/`PostToolUse`.

## Considered Options

**An `http` hook posting directly to the service.** Rejected, and this is a
consequence of ADR-0001 rather than a free choice: the `http` hook type's only
address field is `url`, with no `socketPath` and no `unix:` scheme, so it
cannot reach a Unix socket at all. Earlier research had recommended this path
before the transport was settled.

**A TCP loopback listener used only by hooks.** Rejected. It would restore
precisely the browser-reachable surface ADR-0001 exists to remove, in order to
serve one local client.

**Per-Project hooks in each repository's `.claude/settings.json`.** Rejected.
It writes this application's configuration into repositories the user may
publish, and it cannot see a session started anywhere it was not installed —
which would make `SESS-17` (claim an unclassified session) impossible for the
sessions that most need it. Note that hook lists *merge* across scope files
rather than override, so this remains available later as an addition.

**Subscribing to `PreToolUse`/`PostToolUse` now.** Deferred. They are by far
the highest-frequency events and Claude Code spawns a process per matching
hook per occurrence. The repeated-work detection that would consume them is
milestone 3; the collector is written so enabling them is configuration.

## Consequences

- `async: true` means Claude Code does not wait for the hook and does not
  enforce its timeout, so `SESS-02` (fail open, never block or slow a session)
  holds by configuration rather than by careful exit-code handling.
- Independently, `SessionStart`, `SessionEnd`, `Notification` and `PostToolUse`
  do not honour exit code 2 at all — they cannot block a session whatever the
  hook does. The two protections are belt and braces.
- User-scope settings apply in every project on the machine, so the hook
  observes sessions in unrelated repositories. The service applies the
  registered-Project allowlist; everything else becomes an unclassified Run.
  The hook forwards identifiers only, never file contents, per `SVC-10`.
- **The spool file must be drained and truncated on read, never accumulated.**
  ADR-0007 rejected a durable event log partly to avoid a second retained
  record of session activity; a spool that grows would reintroduce exactly
  that. It is a transient queue, not history.
- Telemetry hooks never emit JSON on stdout and always exit 0, so nothing they
  produce enters Claude's context.
