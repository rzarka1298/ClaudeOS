---
status: accepted
satisfies: ADR-07
---

# Launchers write a generated script rather than interpolating a shell command

Opening a terminal at a Project root running a command has three plausible
mechanisms. We write a short shell script to a temporary file with the project
path embedded as a quoted literal, then hand that file to the configured
terminal application. `osascript` remains a per-application fallback only where
this cannot work.

## Considered Options

**`osascript` with AppleScript `do script`.** Rejected as the default. It
requires building a shell command as a string inside an AppleScript string —
two nested quoting contexts — which is a well-known injection vector and sits
directly against `PROJ-13`. It also triggers macOS Automation permission
prompts.

**Per-terminal CLI flags.** Rejected as the default. Ghostty and WezTerm have
capable CLIs; Terminal.app effectively does not. Coverage is uneven across the
four terminals `PROJ-10` requires to be user-configurable.

## Consequences

- `PROJ-13` holds by construction rather than by escaping discipline: the path
  is written into a file as data, so no shell parsing step exists for a
  metacharacter to escape.
- One implementation serves every terminal application, which is what makes
  `PROJ-10`'s configurability tractable.
- The generated script must be written `0700` so nothing can tamper with it
  between write and exec, and cleaned up after launch.
