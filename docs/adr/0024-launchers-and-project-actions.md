---
status: accepted
satisfies: ADR-07
supersedes-in-part: 0011
---

# Launchers target apps by bundle ID and reach a terminal only through a generated, POSIX-quoted, self-deleting script

Phase 4 lets the owner act on a registered project from the dashboard: open it in Antigravity,
reveal it in Finder, open its GitHub page, bring Claude Desktop forward, or start a new interactive
Claude Code session in a terminal at the project root (`PROJ-05`..`PROJ-10`, `PROJ-13`). This ADR is
ADR-07 of the PRD, delivered as ADR-0024 by the phase's cross-phase assignment (`D-48`, `PR-01`). It
records every launch mechanism, the one shell-parsed artifact and its quoting rule, the script's
lifecycle, the ports Phase 5 reuses, the permission matrix, the error taxonomy, the git collector's
hardening, the rejected `claude-cli://` alternative, the terminal presets, what macOS does with
protected folders, and what was verified on the owner's Mac. It supersedes the parts of
`docs/adr/0011-launcher-generated-script.md` that it corrects.

## Context

The service is a launchd LaunchAgent running `node` (ADR-0015). Everything it opens goes through
`/usr/bin/open` (LaunchServices) or, for a custom terminal the owner configured, through the argv
the owner saved. The PRD requires that a project folder whose name holds shell metacharacters can
never inject a command (`PROJ-13`), that the terminal is genuinely configurable (`PROJ-10`), that
every launch acknowledges within 500 ms and reports failure within 5 s (`PERF-05`), and that no
Claude Code permission bypass can ever be started from the dashboard (CLAUDE.md prohibition,
`D-22`).

ADR-0011 chose a generated script and claimed that "no shell parsing step exists". That claim is
wrong: the generated script is itself parsed by `/bin/sh`. Safety comes from quoting every dynamic
value and from tests that execute the exact file the service writes — recorded below.

## Decision

1. Applications are targeted by **bundle ID**, never by name, with `open -b` (`D-19`).
2. A terminal is reached only through a **generated `.command` script** written by the service into
   its private runtime directory, every dynamic value POSIX single-quoted by `shQuote`. The script
   deletes itself as its first action.
3. The first-class **Terminal.app adapter** hands that script to Terminal with
   `open -b com.apple.Terminal <script>` — LaunchServices, no Apple Event, no Automation prompt
   (`D-20`, `D-28`).
4. A generic **Custom terminal adapter** drives any other terminal from an owner-saved argv template
   with whole-token `{script}` and `{projectPath}` placeholders. It is validated again before every
   spawn. iTerm2, Ghostty and WezTerm ship as presets labelled Unverified (`D-23`).
5. Both adapters implement the domain `TerminalLauncher` port, which Phase 5 reuses for resume, with
   an optional `env` restricted to `CCC_` keys (`D-25`, `D-49`, `PR-07`).
6. Every failure is one of ten `LaunchErrorKind` values with fixed copy. No path, rendered argv or
   stderr text is ever returned or logged (`D-26`, `D-46`).

## Mechanisms

Every argv is built by a pure function in `packages/launchers/src/app-actions.ts`. A bundle ID must
match `[A-Za-z0-9.-]+` and must not start with `-`, so it can never read as an option to `open`. A
project or script path must be absolute (so it starts with `/`, never `-`) and must hold no NUL. A URL
must be `https:` with no userinfo. The error names the field, never the value.

| Action | argv | Notes |
|---|---|---|
| Antigravity (`PROJ-05`) | `["/usr/bin/open", "-b", <saved bundle ID>, <project path>]` | The path comes from the store and is re-checked on disk (`D-06`). |
| Finder (`PROJ-07`) | `["/usr/bin/open", "-R", <project path>]` | Reveals with the folder selected. |
| GitHub (`PROJ-08`) | `["/usr/bin/open", "https://github.com/<owner>/<repo>"]` | Rebuilt from validated parts: the owner's override, else the collector's last-good github.com remote (`D-13`). Never a general URL opener. |
| Claude Desktop (`PROJ-09`) | `["/usr/bin/open", "-b", <saved bundle ID>]` | Activates a running app; never a second instance. No project. |
| Claude Code, Terminal.app (`PROJ-06`) | `["/usr/bin/open", "-b", "com.apple.Terminal", <script path>]` | The script runs `[absolute claude, ...stored arguments]` at the project root. |
| Claude Code, custom terminal (`PROJ-10`) | the saved template with `{script}` and `{projectPath}` replaced element for element | Validated before every spawn (see Terminal presets). `argv[0]` `/usr/bin/open` or `/usr/bin/osascript` is awaited under the cap; any other `argv[0]` is started detached (see Terminal presets). |

**Bundle ID versus name.** A bundle ID survives the owner renaming or moving the `.app`; a name
does not, and a name is ambiguous: two Antigravity bundles with different bundle IDs are installed
on the development Mac. Detection therefore shows every matching bundle and requires the owner to
choose one. Nothing is preselected and nothing is saved without confirmation (`D-19`, `D-27`).
Names are for display only.

`open` returns once LaunchServices has dispatched the request, so exit status 0 means "handed off",
which is what a launch reports (RESEARCH Pattern 1). `open -b <missing ID>` exits 1 with
`LSCopyApplicationURLsForBundleIdentifier` on stderr, which maps to `app-not-found`.

## Quoting rule

The rule is POSIX Shell Command Language §2.2.2: "Enclosing characters in single-quotes shall
preserve the literal value of each character within the single-quotes. A single-quote cannot occur
within single-quotes." `shQuote` (`packages/launchers/src/sh-quote.ts`) wraps each value in `'…'`
and writes each embedded `'` as `'\''`. Nothing else is special inside single quotes: `$`, backquotes,
`\`, `"`, spaces, globs and `;` are all literal.

- NUL, CR and LF are **refused**, never escaped: a line break would end the script line, and NUL
  cannot be carried in an argv at all.
- Env keys must match `^CCC_[A-Z0-9_]+$`. A key such as `PATH`, `IFS`, `BASH_ENV`,
  `DYLD_INSERT_LIBRARIES` or `NODE_OPTIONS` would change how the shell, the loader or the program
  behaves, and nothing needs a key outside the namespace. Values are `shQuote`d like every argv
  element.
- The renderer (`packages/launchers/src/launch-script.ts`) emits only constant text plus quoted
  values: `#!/bin/sh`, `rm -f -- "$0"`, one `export KEY='value'` per env entry,
  `cd -- '<cwd>' || { printf …; exit 1; }` with a fixed message that never contains the path, the
  quoted argv, then `exec "${SHELL:-/bin/zsh}" -l`, so the window stays at a login shell after
  `claude` exits.

Two proof tests execute real scripts rather than inspecting strings:

- `packages/launchers/src/launch-script.proof.test.ts` renders scripts for a hostile corpus (quotes,
  `$(…)`, backquotes, globs, `;`) and seeded random strings, and runs each through `/bin/sh` with a stub
  program that records its argv. Every value arrives verbatim and no `PWNED` canary appears. It also
  proves that a missing folder prints the constant message, never runs the command and still
  self-deletes, and that NUL, CR and LF are refused before any script exists.
- `packages/service/src/projects/terminal-handoff.proof.test.ts` drives the real launch service for
  a project folder named `it's $(touch PWNED) "x"`, executes exactly the file the service wrote
  through its shebang, and asserts that the stub claude saw `["--flag", <project realpath>]` at the
  project realpath, that no `PWNED` file exists and that the script deleted itself.

## Script lifecycle

`packages/service/src/projects/script-dir.ts`:

- **Directory:** `<runtimeDir>/launch`, created `0700` and re-verified (mode repaired, symlink
  refused) the way `ensureRuntimeDir` treats the runtime directory. Never `$TMPDIR` (ADR-0001: a
  shared, long, OS-swept path), never the repository, never the vault.
- **File:** `randomBytes(16).toString("hex") + ".command"` (128-bit name), written with flag `wx`
  (`O_CREAT | O_EXCL`, so an existing file or a planted symlink makes the write fail) and mode
  `0o700`. The execute bit is required; Terminal refuses a non-executable `.command`.
- **Self-delete:** the script's first line is `rm -f -- "$0"`. The service never deletes a script
  it has handed off, because Terminal may not have read it yet (Pitfall 5). It deletes a script
  only when the hand-off provably never reached a terminal: nothing was spawned, the spawn never
  started, the bundle was not found, macOS refused the Apple Event (-1743), or a directly-run
  terminal binary exited non-zero within its grace period.
- **Sweeps:** service startup deletes leftover `.command` files older than 60 seconds (never zero,
  because a launchd KeepAlive restart can follow a hand-off within seconds). Each launch deletes
  any older than 10 minutes. Neither sweep ever touches a just-handed-off file. Non-`.command` files
  are left alone.
- An interrupted launch therefore leaves its script only inside `<runtimeDir>/launch`, and only
  until the next sweep.

## Adapter interface

Declared as types in `packages/domain/src/launch.ts`; real adapters are built only in the service's
composition root:

- `TerminalLauncher.launch({ cwd, argv, env?, signal }) → Promise<LaunchResult>` — `cwd` is the
  store-resolved project path, `argv` a plain array (never a shell string), `env` optional so Phase 5
  can pass `CCC_RUN_ID` / `CCC_LAUNCH_SOURCE` with no amendment (`PR-07`), and `signal` the launch
  pipeline's 4-second cap. An adapter checks the signal before writing, after any asynchronous
  check and before spawning. A hand-off that has not started when the cap fires opens nothing. For
  an `open` or `osascript` hand-off the spawner also kills the still-running child when the cap
  fires. That stops a hung hand-off, but it cannot recall one LaunchServices or AppleScript has
  already dispatched, so a terminal can still open after the owner was told `timeout`. A
  directly-run custom terminal binary is never killed (see Terminal presets), so it too can open
  after `timeout`. Implementations:
  `createTerminalAppLauncher` and `createCustomTemplateLauncher`, selected by
  `selectTerminalLauncher(storedConfig.terminal, deps)` in
  `packages/service/src/projects/terminal-launchers.ts`.
- `ProjectLookup.resolve(projectId)` — resolves a ProjectId to the stored path, re-checked on disk
  asynchronously (`project-missing`, `project-moved`, `folder-access-denied`). The dashboard never
  sends a path (`D-06`).
- `LaunchGuard.check({ projectId, action })` — runs before the hand-off. Phase 4 allows everything;
  Phase 5's concurrent-session warning plugs in here (`D-49`).
- `Spawner.run(argv, { timeoutMs, signal })` and `Spawner.detach(argv, { graceMs })` — the only
  process port. `run` awaits a child under a deadline. Stderr is reduced to a class inside it and
  dropped. `detach` starts a child in its own process group with no stdio, `unref`s it, and has no
  deadline and no abort signal. Both use the same fixed environment allowlist. Tests inject a
  recording fake, so no test ever runs the real `open` (`D-41`).
- `LaunchResult` — `{ ok: true }` or `{ ok: false, error: LaunchErrorKind }`.

The environment is exported inside the script, never passed to the `open` child: a
LaunchServices-opened terminal does not inherit the service's environment, and the child's own
environment is the spawner's fixed allowlist (Pitfall 11).

## Permission matrix

| Action | Apple Event from the service? | Automation prompt | Service-side filesystem touch (TCC-relevant) |
|---|---|---|---|
| Antigravity `open -b id path` | No (LaunchServices) | No | The `open` child stats `path` (attributed to the service's node) |
| Finder `open -R path` | No | No | Same |
| GitHub `open https://…` | No | No | None |
| Claude Desktop `open -b id` | No | No | None |
| Terminal `open -b com.apple.Terminal x.command` | No | No (confirmed on the owner's Mac, A1) | The script lives in the runtime directory (unprotected). Terminal's own TCC standing governs the script's `cd`. |
| Custom osascript preset (iTerm2) | Yes (osascript to iTerm2) | Yes, once (`D-28`, `PR-02`). The Test step that is meant to surface it is built in plan 04-11. Until then the first real launch meets the prompt and can end in `timeout` (Residual risks). -1743 maps to `automation-denied`. | Same as Terminal |
| Custom `open`-routed preset (Ghostty, WezTerm) | No | No | Same as Terminal |
| Git collector | No | No | Reads the project folder. A project in a protected location needs a Files & Folders grant for the service's node (see Protected folders). |
| Project lookup and registration | No | No | `realpath`/`lstat` of the project folder, same TCC standing as the git collector |

## Error taxonomy

The ten `LaunchErrorKind` values (`D-26`). Each has fixed copy with a next step, shown inline and
as an Obsidian Notice; none contains a path.

| Signal | LaunchErrorKind |
|---|---|
| The service socket refuses or is absent (`ECONNREFUSED`, `ENOENT`), or the connection is already down | `service-disconnected` |
| No stored configuration, a stored row that fails the domain schema, or a stored Claude Code or custom terminal template that no longer validates | `launcher-not-configured` |
| `open` stderr contains `LSCopyApplicationURLsForBundleIdentifier` | `app-not-found` |
| The stored path no longer exists, or `open` reports "does not exist" | `project-missing` |
| The stored path no longer realpaths to itself | `project-moved` |
| No override and no github.com remote | `no-github-remote` |
| osascript stderr carries `(-1743)`, `error -1743` or `:-1743)` (custom osascript presets only). A bare `-1743` inside a path such as `proj-1743` does not count. | `automation-denied` |
| `EPERM`/`EACCES` on `realpath`/`lstat`, or "Operation not permitted" | `folder-access-denied` |
| The service's 4-second cap, or the plugin's 5-second wall-clock deadline | `timeout` |
| Spawn `ENOENT`/`EACCES`, a refused script value (NUL/CR/LF, non-`CCC_` env key), a directly-run terminal binary that exits non-zero within its grace period, any other non-zero exit | `spawn-failed` |

`packages/launchers/src/error-map.ts` holds the pure half (`classifyStderr`, `mapLaunchFailure`). Its
switch is exhaustive with no default, so a new stderr class cannot compile until its kind is chosen.

## Git collection hardening

The collector runs the system git (`D-09`), and only `config`, `status`, `log` and `remote`, never
`fetch` or any network or worktree subcommand
(`packages/service/src/projects/git-runner.ts`):

- **Command-scope overrides** (`-c`, which outrank repository-local config): `core.fsmonitor=false`,
  `core.pager=cat`, `core.hooksPath=/dev/null`, `safe.bareRepository=explicit`,
  `log.showSignature=false`, `color.ui=false` and `core.abbrev=7` (a repository or global
  `core.abbrev` below 7 would otherwise make every commit unparseable). Also `--no-pager`, `-C <root>`
  and an explicit `--work-tree=<root>`.
- **Environment from scratch**, never `...process.env`: the LaunchAgent's fixed `PATH`, `HOME` (the
  owner's global config is a protected scope git itself trusts), `LC_ALL=C`, `GIT_OPTIONAL_LOCKS=0`,
  `GIT_TERMINAL_PROMPT=0`, `GIT_PAGER=cat` and `GIT_CEILING_DIRECTORIES=<parent of root>`. No inherited
  `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` or `GIT_CONFIG_*` can redirect git.
- **Preflight skip:** `git config --show-scope --includes --name-only --get-regexp` over the
  executable keys (filter and diff drivers, merge drivers, `core.sshCommand`, `gpg.program`, editors
  and similar). A repository whose local or worktree scope defines one is not read. It shows "Git
  status skipped" with its reason. The three canonical git-lfs filter values and the keys the
  overrides already neutralise are exempt.
- **No discovery:** git runs only after an asynchronous `lstat(<root>/.git)` finds a directory or file,
  and after the `D-06` re-check confirms the stored root still realpaths to itself.
- **Residual (E-2):** no override list can be complete, because driver names are arbitrary. The
  preflight therefore skips such repositories rather than neutralising them. A repository that gains
  a driver between the preflight and the status read is a race this accepts.

## claude-cli:// considered and not chosen

Claude Code documents a `claude-cli://open` deep link (parameters `q`, `cwd`, `repo`; `..` and
control characters in `cwd` are refused; the handler is a small URL-handler app). It was not chosen,
for five reasons:

1. "On macOS, Claude Code remembers the terminal from your most recent interactive session and
   reuses it", so the dashboard could not honour the owner's terminal choice (`PROJ-10`).
2. It carries no argv or env. Phase 5 needs `--session-id`, `--resume`, `--permission-mode` and
   `CCC_RUN_ID`.
3. The handler registers only "when you send your first prompt of an interactive session", so it may
   not exist on a fresh machine.
4. It cannot choose the `claude` binary, and it cannot leave a login shell open afterwards.
5. It cannot be a `D-22` template: the path sits inside the URL token, not as a whole element.

It remains a possible future adapter behind the same `TerminalLauncher` port.

## Terminal presets

All presets are labelled **Unverified** until the owner's Test step confirms one (`D-23`). The
Terminal.app adapter is the only first-class, verified path. Presets route through `/usr/bin/open` or
`/usr/bin/osascript`, which return once the terminal has the script. They are awaited under the cap,
and exit 0 means handed off.

A custom template whose `argv[0]` is anything else (for example
`/Applications/WezTerm.app/Contents/MacOS/wezterm start -- {script}`) is taken to be the terminal
process itself. It runs for as long as the window stays open. Awaiting it would kill the window at
the 4-second cap and report `timeout`. So `createCustomTemplateLauncher` starts it with
`Spawner.detach`: its own process group, stdio ignored, `unref`'d, with no deadline and no abort
signal. It is then judged on a short grace period (300 ms by default, never longer than the cap):

- still running at the end of the grace, or exited 0 → handed off, and the script is left for itself
  and the sweeps;
- the spawn failed (`ENOENT` or `EACCES`, including an `argv[0]` removed after the `X_OK` check), or it
  exited non-zero within the grace → `spawn-failed`, and the script is removed.

The cap never kills such a process. If the cap fired during the grace, the answer is still
`timeout`, but the window may open anyway.

| Preset | argv template | Caveat |
|---|---|---|
| iTerm2 | `["/usr/bin/osascript", "-e", "on run argv", "-e", "tell application id \"com.googlecode.iterm2\" to create window with default profile command (item 1 of argv)", "-e", "end run", "{script}"]` | The script path reaches AppleScript as an argv item, never inside the script source. macOS asks once for Automation permission. iTerm2 splits `command` on spaces, so the runtime directory's path must contain no space. |
| Ghostty | `["/usr/bin/open", "-na", "Ghostty", "--args", "-e", "{script}"]` | Ghostty may run the command a second time as typed text. The script has already deleted itself, so the second run finds nothing and fails harmlessly. |
| WezTerm | `["/usr/bin/open", "-na", "WezTerm", "--args", "start", "--cwd", "{projectPath}", "--", "{script}"]` | Starts through `open`, so the launch is reported as soon as WezTerm receives it. |
| Blank | `["", "{script}"]` | The owner fills in an absolute executable before saving. |

**Validation before every spawn** (`validateCommandTemplate` in
`packages/launchers/src/command-template.ts`, run by `createCustomTemplateLauncher` on each launch,
whatever was checked at save time):

- `argv[0]` must be absolute, a regular file (a directory such as an `.app` bundle passes `X_OK`,
  but cannot be executed) and must pass `X_OK` at that moment, checked asynchronously.
- `{script}` is required.
- Placeholders must be whole elements. An embedded placeholder (`--cwd={projectPath}`) or an
  unknown `{name}` is refused.
- A placeholder directly after an interpreter's "run this code" flag is refused, reported as
  `embedded-placeholder`. The flags are a short-option bundle ending in `c` (`-c`, `-lc`, `-ic`),
  one ending in `e` or `E` (`-e`, `-ne`, `-E`), and `--eval`, `-Command` or `--command` in any letter
  case. One exception: `{script}` after a bare `-e` is allowed unless `argv[0]` is
  `/usr/bin/osascript`. For a terminal emulator, `-e` means "run this program", and the Ghostty
  preset relies on that. `{projectPath}` after any of these flags is always refused.
- NUL/CR/LF and empty elements are refused, and a template may have at most 32 elements.
- Every Claude Code permission-bypass form is refused: `--dangerously-skip-permissions` in any
  spelling, and `bypassPermissions` as a permission mode, a flag value or inside `--settings` JSON.
  Matching is NFKC-normalised, case-folded, with punctuation removed.

A refusal answers `launcher-not-configured` before any script is written. The stored Claude Code
template (`[absolute claude, ...arguments]`, `{projectPath}` only) gets the same re-validation at
every launch.

## Protected folders

Research (E-1) predicted that a launchd-run `node` touching a project under `~/Documents`,
`~/Desktop`, `~/Downloads` or iCloud Drive would receive a silent `EPERM` with no prompt, because a
LaunchAgent-run CLI has no responsible app bundle. **The spike on the owner's Mac contradicted
that.** The service's node, running under launchd, drew a macOS Files & Folders prompt for Documents.
Once it was allowed, `lstat`, `readdir`, `realpath`, a git status read and a Finder reveal of a
synthetic `/Users/USERNAME/Documents` project all succeeded (A3, A6).

The design holds for both outcomes:

- `EPERM`/`EACCES` still maps to `folder-access-denied`, whose next step (`PR-11`) is to move the
  project out of the protected folder or to allow access in System Settings › Privacy & Security.
- Registration of a protected location explains up front that macOS "may block the command
  center's service from reading this folder, sometimes without asking". That sentence is true
  whether macOS prompts (as observed) or silently denies (as a declined or reset grant would).
- `PR-10`'s guidance stands: the app's primary advice is to keep projects outside protected folders.
  Allowing access in Privacy & Security is the named alternative.
- **Full Disk Access** for the service's `node` binary is documented here as the only grant path a
  launchd CLI can receive if a future macOS stops prompting and denies silently. It is not pushed
  in the app (PITFALLS 14: broad, and it follows the binary path). A Node upgrade changes that path,
  so macOS may ask again or deny again after one.

## Live verification record

| Item | Date | Outcome |
|---|---|---|
| A1 — a node-written 0700 `.command` handed to Terminal by `open -b com.apple.Terminal` under launchd opens with no Gatekeeper and no Automation prompt | 2026-09-30 | **Confirmed.** No Gatekeeper prompt and no "wants to control Terminal" prompt. A separate Files & Folders prompt about Downloads was seen and judged not A1-class (Residual risks). |
| A2 — the script deletes itself via `$0` | 2026-09-30 | **Confirmed.** `scriptRemoved: true` for both hand-offs (valid folder and missing folder). |
| A3 — what a launchd-run node gets on a protected folder | 2026-09-30 | **Differs from E-1.** A Files & Folders prompt for Documents appeared and was allowed. `lstat`, `readdir` and git status then returned `ok` (git state `repo`). |
| A6 — `realpath` and `open -R` on a protected folder | 2026-09-30 | **Differs from E-1.** Both returned `ok` after the same Documents grant. |
| A11 — the cd-failure message stays readable | 2026-09-30 | **Confirmed.** Readable, and it stayed on screen after the script exited. |
| PR-02 — zero Automation prompts is the correct reading of success criterion 3 for the default configuration | — | Pending owner UAT (04-15 item 4) |

Source: `.planning/phases/04-projects-launchers/04-09-SPIKE.md`. The owner-run harness
(`scripts/spikes/p4-launch-spike.sh`) ran the product's own script directory, Terminal adapter, git
runner and spawner as a temporary launchd job with its own runtime directory. Its result file holds
only enums and booleans.

## Residual risks

- **Same-user race on the script.** Between write and execution, another process running as the
  owner could read or replace the script. The 0700 directory, `O_EXCL`, the 128-bit name and the
  self-delete narrow the window. As ADR-0001 notes for the socket, same-user processes are not
  isolated from each other, and this is accepted.
- **Templates are owner-authorised code.** A custom terminal template runs whatever executable the
  owner saved. Validation keeps it an absolute, existing, executable file with no permission bypass,
  but cannot judge what that program does.
- **Git drivers are skipped, not neutralised** (E-2, above).
- **Unexplained Downloads prompt.** During the spike the owner saw a Files & Folders prompt
  "… wants access to Downloads". The app name was not recorded, and the spike never touches
  `~/Downloads`. This is not A1-class: `D-20`/`D-28` concern Apple Events and Automation prompts from
  the hand-off, and this was a file-access prompt. Its likeliest source is the owner's login shell
  or Terminal session startup touching `~/Downloads`. If it recurs at the end-of-phase UAT, the owner
  notes the app name (`PR-14`).
- **The TCC outcome can be either.** Under launchd the service's node **can** get a Files & Folders
  prompt for Documents and succeed once allowed, contradicting E-1. A declined or reset grant, or a
  future macOS, can still produce a silent `EPERM`. `PR-11`'s copy and the `folder-access-denied`
  mapping are written for both outcomes. The plugin's registration copy and the `folder-access-denied`
  card assume a silent denial nowhere. Two follow-ups are carried to plans 04-10/04-12:
  - The project card's `folder-access-denied` body ("Allow access in System Settings › Privacy &
    Security › Files & Folders, then try again. Updating Node.js can make macOS ask again.") leads
    with the grant rather than `PR-11`'s "move the project" guidance.
  - (Resolved in the wave-4b review.) Registration used a synchronous `realpathSync.native` that
    could block the service's event loop while a TCC prompt was on screen. It now resolves, stats
    and follows links through `fs.promises`.
- **iTerm2 splits `command` on spaces.** The iTerm2 preset passes the script path as the `command`
  of a new window, and iTerm2 splits it on spaces. The runtime directory, and so the launch directory
  under it, must contain no space. The default `/Users/USERNAME/.claude-command-center` has none.
  A `CCC_RUNTIME_DIR` with a space would break only that preset, and the preset stays Unverified.
- **Ghostty double run** is harmless only because the script deletes itself first. That line must
  stay first.
- **The first Automation prompt can end in `timeout`.** An osascript preset (iTerm2) waits while
  macOS shows its first "wants to control" prompt. If the owner takes longer than the 4-second cap,
  osascript is killed and the launch reports a bare `timeout`, though nothing is wrong. Requirement
  for plan 04-11's Test step: give an osascript-based launch a longer cap there, or run a separate
  pre-flight that meets the prompt with no cap. Map "killed while the first Automation prompt was
  pending" to an outcome that explains the prompt and says to try again, not a bare `timeout`.
  Until 04-11 lands, the prompt is met on the first real launch.
- **Code-flag placeholders are judged by the flag, not the program.** The refusal matches common
  interpreter flags (`-c`, `-e`, `-E`, bundles ending in them, `--eval`, `-Command`, `--command`). It
  cannot know every program's options. `{script}` after a bare `-e` stays allowed for terminal
  emulators, so `perl -e {script}` or `node -e {script}` would pass validation and evaluate the
  service-generated script path as code. That path holds no owner-controlled text, so this is a
  broken template rather than an injection. A program whose code flag has another name is not
  caught. Templates remain owner-authorised code (above).
- **Check-then-spawn race on `argv[0]`.** The regular-file and `X_OK` check and the spawn are
  separate steps. If the file is removed between them, the spawn fails with `ENOENT`, which maps to
  `spawn-failed` and removes the script. If it is replaced by another executable in between, the
  replacement runs. Swapping the file needs the owner's own privileges, which is the same-user
  threat ADR-0001 accepts.
- **The detached grace is a heuristic.** A directly-run terminal binary that fails later than the
  grace period (300 ms) is reported as handed off. One that forks its window process and exits 0 is
  handed off correctly. The service never learns whether the window stayed open, and it never kills
  the process.

## Consequences

- `PROJ-13` holds by quoting discipline that is proven by execution, not by the absence of a shell:
  both proof tests must keep running the real file. A change to `shQuote` or the renderer that
  breaks them is a security regression.
- One script format serves every terminal, so adding a terminal is a new preset or adapter, never a
  new quoting context. A terminal needing an AppleScript string built from the path would violate
  this ADR.
- The default configuration needs no Automation permission at all. Only an osascript-based custom
  preset brings a prompt (`D-28`, `PR-02`). It is meant to appear in that preset's Test step once
  plan 04-11 builds it (Residual risks).
- Phase 5 resumes sessions through the same `TerminalLauncher` port, passing its run identity in
  `env`, with no change to this design (`PR-07`).
- Protected-folder behaviour is measured, not assumed. The copy is true for a prompt and for a silent
  denial, and the owner's recorded outcome is the reference for the end-of-phase UAT (04-15 item 2).
- ADR-0011 carries a "Superseded in part by ADR-0024" note. Its generated-script decision stands; its
  "no shell parsing step exists" claim is corrected here.
