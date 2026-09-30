---
status: accepted
satisfies: ADR-07
superseded-in-part-by: 0024
---

# Launchers write a generated script rather than interpolating a shell command

> **Superseded in part by ADR-0024** (`docs/adr/0024-launchers-and-project-actions.md`). The
> generated-script decision stands. ADR-0024 now records ADR-07 in full: the script lives in the
> service's private `<runtimeDir>/launch` directory rather than a temporary file, it is handed to
> Terminal by bundle ID, custom terminals use a validated argv template, and the claim below that
> "no shell parsing step exists" is corrected. The generated script **is** parsed by `/bin/sh`.
> Safety comes from `shQuote` (POSIX single-quoting of every dynamic value, with NUL/CR/LF refused)
> and from two proof tests that execute the real script:
> `packages/launchers/src/launch-script.proof.test.ts` and
> `packages/service/src/projects/terminal-handoff.proof.test.ts`.

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

- `PROJ-13` holds by quoting discipline proven by execution. *Corrected by
  ADR-0024:* this bullet originally said the path "is written into a file as
  data, so no shell parsing step exists for a metacharacter to escape". That
  is wrong. The script is parsed by `/bin/sh`, and every value in it is
  single-quoted by `shQuote`. The proof tests named above execute the
  service-written file with hostile folder names.
- One implementation serves every terminal application, which is what makes
  `PROJ-10`'s configurability tractable.
- The generated script must be written `0700` so nothing can tamper with it
  between write and exec, and cleaned up after launch.
