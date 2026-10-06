---
status: accepted
satisfies: ADR-06
amends: ADR-0010
---

# Claude Code events are minimized in the hook, normalized by one service-side reducer, and degrade to unavailable when their shape changes

Claude Code reports session lifecycle through user-scope `command` hooks that
the owner installs with `./scripts/claude-hooks/install.sh`; the dashboard
never installs anything. Each hook invocation is a short-lived, dependency-free
Node process. It keeps an allowlisted handful of identifiers from its stdin,
delivers one record of at most 4 KiB over the service's Unix socket, and
spools it when the socket is unavailable. It never writes stdout and always
exits 0. The service runs every record through one pure reducer in
`packages/collectors`, which turns hook evidence and process-liveness evidence
into the eight-state `RunState`. The plugin only ever sees the reduced
`session.upserted` events and the snapshot's `state.sessions`. A known event
whose shape no longer validates is never applied and never guessed at: the
source reads `unavailable — telemetry shape changed` until a valid record of
that event arrives. This record completes ADR-06 and amends ADR-0010's
subscription set and delivery rules.

## Subscription and delivery (amends ADR-0010)

The installer subscribes 15 events. ADR-0010's set was `SessionStart`,
`SessionEnd`, `Stop`, `Notification`, `SubagentStart`, `SubagentStop`,
`TaskCreated` and `TaskCompleted`. This record adds `UserPromptSubmit`,
`StopFailure`, `PermissionRequest` and `PostModelSwitch`, plus the tool
events `PostToolUse`, `PostToolUseFailure` and `PermissionDenied` (D-04,
D-11). The installer's literal list is test-asserted equal to
`KNOWN_HOOK_EVENTS` in `@ccc/domain`.

ADR-0010 deferred the tool events on cost. Measured on Node 24.20.0 with a
detached spawn, one hook process costs 18 ms p50 with 600 B of stdin, 20 ms
with 1 MiB and 27 ms with 8 MiB, with p95 at or under 35 ms (PR-05). That is
cheap enough to keep them, on three conditions. The hook drains stdin fully
but retains at most 256 KiB for parsing. The service coalesces tool activity:
`lastActivityAt` is held in memory, and a Run is written and published only on
a state change or at most once per 5 s. The event ring buffer grew from 200
to 500.

Each handler is written in exec form, with no matcher, so every tool and
notification type is covered:

```json
{ "type": "command",
  "command": "/Users/USERNAME/.nvm/versions/node/v24.20.0/bin/node",
  "args": ["/Users/USERNAME/.claude-command-center/hooks/hook/entry.js",
           "--runtime-dir", "/Users/USERNAME/.claude-command-center"],
  "async": true, "timeout": 5 }
```

- **Exec form.** The absolute Node path is captured when the owner installs,
  so the hook never depends on a login shell's `PATH`.
- **`timeout: 5`.** `async: true` means Claude Code does not wait for the hook,
  so this is defense in depth. It is kept at 5 because a hook timeout also
  raises the `SessionEnd` budget, and a larger value would slow exit.
- **Hook deadline.** The hook's own budget is 300 ms for handshake plus POST.
  A hard exit follows at 340 ms, whatever the hook is waiting on.
- **Write-ahead `SessionEnd`.** `SessionEnd` is appended to the spool before
  the socket attempt. Ingest is idempotent on the hook-minted `eventId`, so
  the record that is both delivered and spooled applies once.
- **Rename-then-read drain (PR-12).** The service drains the spool at startup,
  before the socket opens, and every 2 s or less while running. It renames
  `spool/hooks.ndjson` aside and then reads the renamed file, so a line
  appended during the drain lands in the new file instead of being lost. The
  startup-only `read → writeFileSync(trailing)` drain it replaced lost such
  lines.
- **Spool cap and drop counter.** The spool is capped at 1 MiB. Past the cap a
  record is dropped, and one byte is appended to `spool/hooks.dropped`, so
  that file's size is the drop count. Health and `status.sh` report it.
- **Status-line snapshots.** These go to their own latest-only file,
  `spool/statusline.latest.json`, replaced whole on each undelivered run. A
  service outage can therefore never fill the hook spool with snapshots and
  evict write-ahead `SessionEnd` records.
- **Compiled by `tsc`, not bundled (PR-08).** D-07 asked for an esbuild
  bundle. The hook imports only `node:` builtins and relative files, so the
  package's existing `tsc -b` output is already dependency-free ES modules, and
  a test asserts that. The installer copies `dist/hook/*.js` and
  `dist/statusline/*.js` (never tests) into
  `/Users/USERNAME/.claude-command-center/hooks/`.

### Installation

`scripts/claude-hooks/` holds `install`, `uninstall` and `status`, each a
`.mjs` script behind a POSIX `.sh` shim (PR-22). The installer:

- is merge-only, and identifies its own entries solely by an `args[0]` that
  points into `<runtime-dir>/hooks/`;
- refuses invalid JSON, Node older than 24, and Claude Code older than
  2.1.214, before writing anything;
- writes a timestamped `0600` backup, then replaces `settings.json`
  atomically;
- is byte-identical on re-install, and `--dry-run` prints the diff and writes
  nothing.

Uninstall removes only those entries and restores the saved status line. When
the result matches a backup, it writes that backup's exact bytes, so undoing
an install returns the owner's file byte for byte. `--runtime-dir` points a
branch build's hooks at an isolated runtime directory for UAT (PR-29). No test
and no agent ever runs the installer against the owner's real Claude config.
The tests run it with `HOME`, `CLAUDE_CONFIG_DIR` and every path flag pointed
at a temp directory.

## Payload minimization

The hook forwards a per-event allowlist and drops everything else by
construction (D-09 as amended by PR-04):

- **Every event keeps** `session_id`, `cwd`, `transcript_path`,
  `permission_mode`, `effort.level` (as `effort_level`), and `agent_id` and
  `agent_type` inside a subagent.
- **Only on some events:** `SessionStart` adds `source`, `model` and
  `session_title`. `SessionEnd` adds `reason`. `Notification` adds
  `notification_type`. `PermissionRequest`, `PermissionDenied` and
  `PostToolUse` add `tool_name`. `PostToolUseFailure` adds `tool_name` and
  `is_interrupt`. `PostModelSwitch` adds `from_model`, `to_model` and
  `source` (as `switch_source`).
- **Environment:** `CLAUDE_PID`, `TERM_PROGRAM`, `CLAUDE_CODE_CHILD_SESSION`,
  `CCC_RUN_ID` and `CCC_LAUNCH_SOURCE`. No other variable is read.
- **`error` is scoped to `StopFailure` (PR-04, C-2).** It is forwarded as
  `stop_error`, and only as one of the documented enum values. An unlisted
  value becomes `unknown`. `PostToolUseFailure.error` carries the failed
  tool's output text, so it is never forwarded.
- **Always dropped:** `tool_input`, `tool_response`, prompts,
  `last_assistant_message`, `Notification.message` and `title`, task subjects
  and descriptions, `error_details`, `permission_suggestions`,
  `background_tasks`, `session_crons`, `prompt_id` and `scratchpad_dir`.

The hook retains at most 256 KiB of stdin for parsing. It drains the rest so
Claude Code's write never fails mid-payload. The serialized record is capped
at 4 KiB. The service's 64 KiB body cap stays the outer bound. The recursion
guard has four independent rules (D-10):

- the hook imports no `node:child_process`, which is test-asserted;
- ingest only updates state and publishes;
- a hook that finds `CCC_HOOK=1` in its environment exits at once;
- events from processes marked `CCC_INTERNAL=1` are dropped.

## Normalization table

One pure reducer (`packages/collectors/src/sessions/reducer.ts`) maps
evidence to transitions (D-17, D-18). The service is the only caller, and the
plugin never reduces raw events.

| Evidence | Transition |
|---|---|
| Dashboard launch requested (pre-registered Run) | to `queued` |
| Launcher reports the terminal script started | `queued` to `starting` |
| Launcher reports failure | to `failed`, reason = the launcher error |
| `SessionStart` (`startup`) | to `running`, activity `idle` |
| `SessionStart` (`compact`) | the same Run, updated; no new Run |
| `UserPromptSubmit`, `SubagentStart`/`SubagentStop`, `TaskCreated`/`TaskCompleted`, `PostToolUse*`, `PermissionDenied` | stays `running`, activity `working`, `lastActivityAt` updated |
| `Stop` | stays `running`, activity `idle` |
| `StopFailure` | stays `running`, `lastError` set: a failed turn is not a failed session |
| `PermissionRequest`, or `Notification` of type `permission_prompt` | to `waiting-for-approval` |
| Any later activity event for that session | `waiting-for-approval` to `running` |
| `SessionEnd`, no terminate pending | to `completed` |
| `SessionEnd` while `terminateRequestedAt` is set | records `endObservedAt`; the state holds until the PID is gone |
| Terminate pending and PID observed gone | to `cancelled` |
| PID gone and no `SessionEnd` within the grace period | to `stale` |
| Identity-verified live PID, or new activity, on a `stale` Run | to `running` |

**Pending-terminate rule (PR-02, C-3).** `SIGTERM` (exit 143) and `SIGHUP`
(exit 129, which closing the terminal window sends) run `SessionEnd` hooks with
reason `other` before exiting. So a force-terminate produces a `SessionEnd`.
Without this rule, that `SessionEnd` would finalize the Run as `completed`, and
the later PID-gone evidence could no longer yield `cancelled`. Only the
capability-typed terminate executor sets `terminateRequestedAt`.

**Finality (D-20).** Later truth wins. `stale` can recover to `running` or
`completed`, but `completed`, `failed` and `cancelled` never transition again.
A rejected edge is logged with the Run, the state and the evidence kind, and
is not applied. `PermissionDenied` fires only in auto mode and never follows a
dialog, so it counts as activity rather than clearing a wait. Activity is
never invented: `Stop` does not fire after a user interrupt. A Run therefore
shows its last activity time instead of asserting that live work is going on.

## Run identity

One Run per attachment of (`claudeSessionId`, `pid`) (D-21):

- **Resume** opens a new Run linked by `resumedFromRunId`.
- **Fork** opens a new Run with the new session ID, linked to its parent.
- **`/clear`** on the same PID links a new Run. It completes the old one only
  when process-start identity proves the same process; otherwise it only links
  them, so a reused PID can never complete an old Run.
- **Subagents** are counters on the parent Run, keyed by `agent_id` sets, and
  never Runs of their own.

Dashboard launches pre-register their Run and pass `--session-id <uuid>`,
`CCC_LAUNCH_SOURCE=dashboard` and `CCC_RUN_ID=<RunId>`. Resume never passes
`--session-id`, because Claude Code refuses it without `--fork-session`.
Branch passes `--resume <id> --fork-session --session-id <uuid>`, which the
binary's own error text affirms is the one combination it accepts (PR-10).

## Stale resolution

A missing lifecycle event never produces an invented terminal state
(D-19, D-22):

- **Liveness sweep.** Every 5 s the service runs a `kill(pid, 0)` pass (about
  0.5 µs each). It follows with one batched
  `/bin/ps -o pid=,lstart= -p <pids>` (about 10 ms) for the PIDs that answered
  alive, and compares each stored C-locale `lstart` string exactly. A mismatch
  means the PID was reused, and counts as gone.
- **Grace.** A PID gone with no `SessionEnd` within 10 s, the spool-drain
  window, moves the Run to `stale`.
- **Start timeout.** A `starting` Run with no `SessionStart` within 60 s moves
  to `stale`: never observed starting.
- **PID-less fallback.** A Run without a PID falls back to an inactivity
  threshold, starting at 30 minutes with no event while not idle.
- **Restart recovery.** Before the socket opens, every non-terminal Run
  becomes `stale` (SVC-11) and its revision is bumped. The sweep then revives
  identity-verified live PIDs, and the spool drain applies queued endings.
  Recovery never promotes a Run to `completed`.

`stale` displays as "Unknown — ended without reporting", distinct from the
`Stale` freshness badge. The thresholds are the starting values in the list
above. 05-11 tunes them, and 05-14 records the tuned values here.

### Tuned values

Recorded by 05-14 from the 05-08, 05-11 and 05-12 summaries. Each timing has
an environment knob so tests can shrink it; the defaults below are what the
owner's service runs with.

| Setting | Default | Knob | Set by |
|---------|---------|------|--------|
| Liveness sweep interval | 5 s | `CCC_LIVENESS_SWEEP_MS` | 05-11 |
| Grace before `pid-gone` | 10 s | `CCC_LIVENESS_GRACE_MS` | 05-11 |
| Start timeout (queued or starting, no `SessionStart`) | 60 s | `CCC_START_TIMEOUT_MS` | 05-11 |
| PID-less inactivity threshold | 30 min | `CCC_PIDLESS_INACTIVITY_MS` | 05-11 |
| Stale revival window after restart | 24 h | none | 05-11 |
| Re-attribution window for ended Runs | 7 days | none | 05-11 |
| Spool poll interval (at most) | 2 s | `CCC_SPOOL_POLL_MS` | 05-08 |
| Activity-only write coalescing | 5 s per Run | none | 05-08 |
| Transcript sweep interval | 5 min | `CCC_TRANSCRIPT_SWEEP_MS` | 05-12 |
| Integration-status refresh | 60 s | `CCC_INTEGRATION_REFRESH_MS` | 05-12 |
| Transcript read chunk (cap) | 256 KiB | none | 05-12 |
| Version probe timeout | 3 s | none | 05-12 |

The sweep lands `pid-gone` within one sweep interval plus the grace, so a
silently dead session reads as unknown within about 15 s. The PID-less
threshold is a Claude's Discretion value: 30 minutes with no event while not
idle. The measured PERF-04 path below (p50 34 to 35 ms, p95 37 to 40 ms over
three runs) sits far inside its 2 s p95 budget.

### Measured PERF-04 path

Plan 05-08 measured the real compiled hook against the real built service.
Each run was 20 spawns (10 sessions, each a `SessionStart` then a
`UserPromptSubmit`), under a temp runtime dir and a throwaway Keychain
account. Latency runs from spawn to the matching `session.upserted` arriving
on an open, authenticated event stream.

| Run | p50 | p95 | max | hook wall p50 | hook wall p95 |
|-----|-----|-----|-----|---------------|---------------|
| 1 | 35 ms | 40 ms | 50 ms | 36 ms | 42 ms |
| 2 | 34 ms | 38 ms | 46 ms | 36 ms | 39 ms |
| 3 | 35 ms | 37 ms | 46 ms | 36 ms | 39 ms |

The budgets are p95 under 2 s with a 10 s ceiling (D-54), and hook wall time
p95 under 300 ms (D-56). The machine was a dev Mac on Node 24.20.0.

## Capability detection

Two layers (D-12), with PR-09 and C-7 applied:

1. **Version probe.** `claude --version` runs through `execFile` on the
   absolute path the installer recorded in `<runtime-dir>/hooks/install.json`.
   It is cached by `realpath` plus mtime, because the launcher is a symlink
   (`/Users/USERNAME/.local/bin/claude` into a versioned directory), and
   auto-update swaps its target. The result is mapped to the capability table
   in `packages/collectors`, with a minimum of 2.1.214. The probe reports the
   *installed* version, not each running session's. Sessions keep their old
   binary after an update, so the probe gates only the install-time minimum
   and the health display, never a live session's parsing.
2. **Shape validation.** Every known event is validated by its zod schema:
   strict on the fields the reducer needs, with unknown keys stripped. A known
   event that fails is never applied. It flips the source to
   `unavailable — telemetry shape changed (vX.Y.Z)` until a later valid record
   of that event, and a missing field is never defaulted. An unknown event
   name is counted and ignored. When the status-line wrapper is on, its
   documented `version` field is the per-session truth.

## Launch source

Launch source is classified service-side at `SessionStart`, from operating
system process metadata (PR-03, C-1):

- `dashboard` when `CCC_LAUNCH_SOURCE=dashboard`;
- otherwise `external` when an ancestor of `CLAUDE_PID` is another Claude Code
  process, or when the Claude process has no tty (`ps -o tty=` prints `??`);
- otherwise `terminal`.

D-25's rule ("`terminal` when `TERM_PROGRAM` is set and
`CLAUDE_CODE_CHILD_SESSION` is unset") could never fire. Claude Code sets
`CLAUDE_CODE_CHILD_SESSION=1` in every hook command, and `TERM_PROGRAM` was
absent from a Claude-spawned environment on the dev Mac. `TERM_PROGRAM` is
kept as a terminal-identity hint only. `skill` and `automation` are reserved
for milestone 2.

## Session controls

- **Interrupt: SIGINT is never sent (PR-01, Q1).** Observed in the installed
  Claude Code 2.1.283 binary: its shutdown manager registers
  `process.on("SIGINT", …this.shutdown(0))` for interactive mode. So a
  signalled `SIGINT` ends the whole session gracefully with exit 0; it does
  not interrupt the turn. (In `-p` mode it aborts the turn, then exits.) The
  `Ctrl+C` key reaches the TUI as a raw-mode keystroke, which is a different
  path. The control therefore reads `Focus to interrupt`: it focuses the
  terminal and tells the owner to press Esc. No code path sends `SIGINT`, and
  a test asserts that.
- **Force-terminate** sends `SIGTERM` to the identity-verified PID, escalating
  to `SIGKILL` after a grace period. The Run becomes `cancelled` once the PID
  is observed gone (D-01). The executor exists only behind
  `CapabilityToken<"session.force-terminate">` and has no route of its own.
  Confirming the control calls the `ProposeForceTerminate` port, which answers
  `approval-unavailable` until the Phase 6 approval engine issues real tokens.
  The control is live after Phase 6 (PR-13, PR-26).
- **Focus** selects the Terminal.app tab whose `tty` matches the Claude PID's
  tty. Every other terminal is only activated by bundle ID. Focus is the first
  Apple Event the owner sees, because Phase 4's launchers send none (PR-06,
  C-4). So the first Focus is always user-initiated, and osascript error
  −1743 maps to `automation-denied` with the specific error within 5 s.
  iTerm2's `tty`/`select` script ships labelled unverified, because iTerm2 was
  not installed on the dev Mac. It falls back to activating the app.
- **Timings and guards (05-14).**
  - Focus answers within 5 s overall; each `osascript` or `open` call has a
    4 s timeout of its own, so its failure is still mapped inside the budget.
    The Terminal.app and iTerm2 scripts are module constants that receive the
    tty only as `argv`, after `^ttys[0-9]{3,}$` validation. Activation passes
    the validated `.app` bundle path found in the Claude PID's ancestry to
    `open -a`: the ancestry names the bundle path, not its identifier. A
    Claude Code background session (under `ClaudeCode.app`) answers
    `background-session`.
  - Force-terminate waits a 10 s grace (`DEFAULT_TERMINATE_GRACE_MS`) after
    `SIGTERM`, polling every 200 ms. It re-verifies the PID's start time
    before `SIGKILL`, then watches for up to 5 s more. If the PID outlives
    that, the liveness sweep records the same `pid-gone` later, so the Run
    is never finalized early.
  - Resume and branch give the terminal launcher 5 s before answering
    `timeout`. Reveal and open of a transcript use a 3 s `open` timeout.
- **Backstop rules 9 and 10.** `scripts/check-boundaries.sh` rule 9 fails the
  build on any kill call in `packages/service`, `packages/collectors` or
  `packages/plugin` that names `SIGINT` (or the bare number 2). Rule 10 fails
  it on any cast to `CapabilityToken` in a non-test file. Together with the
  executor's `TerminateSignal` type, which admits only `SIGTERM` and
  `SIGKILL`, these keep the two forbidden paths unreachable in source.

## Status-line wrapper

Plan capacity comes only from an opt-in status-line wrapper
(`install.sh --with-statusline`, D-02). Pitfall 11 rules out adding a status
line: with a custom status line configured, Claude Code hides most footer
hints, including "esc to interrupt". So the installer wraps only an *existing*
`statusLine` command, and refuses with that explanation when there is none.

**Install.** The exact prior `statusLine` object is saved to
`<runtime-dir>/statusline/original.json` (`0600`, in a `0700` directory).
Only its `command` changes, to the single-quote-escaped invocation
`'<node>' '<runtime-dir>/hooks/statusline/wrapper.js' --runtime-dir
'<runtime-dir>'`. The status-line command always runs in a shell.

- A re-install keeps the recorded original. It never records the wrapper
  itself as the owner's command.
- The installer refuses to wrap a command that already runs another runtime
  directory's wrapper.
- Uninstall restores the saved object exactly, including `padding` and
  `refreshInterval`.

**At run time.** The wrapper runs the owner's command in the same process
group, with the same stdin. Claude Code cancels an in-flight status line by
killing its process group, so the owner's command goes with it. The owner's
output bytes and exit code are relayed unchanged. Concurrently, the wrapper
forwards a minimized snapshot, with a 250 ms deadline (PR-14):

- the fields are `session_id`, `session_name`, `model.id`, `version`,
  `cost.total_cost_usd`, the two `rate_limits` windows' `used_percentage` and
  `resets_at`, and `effort.level`;
- repository, pull-request and worktree names are dropped;
- after the owner's command exits, the wrapper waits at most 50 ms for the
  forward. It then writes the snapshot to the latest-only spool file.

A `CCC_STATUSLINE=1` marker in the child's environment stops recursion at
depth one. Without the wrapper, capacity reads "Account capacity unavailable",
never zero.

## Transcript analysis

Transcript analysis is off by default, and one-click enable is recorded
service-side (D-03). Hook telemetry, session state and status-line capacity
are independent of it.

- **Scanner.** The scanner is incremental and read-only over
  `<claude-config>/projects/**/*.jsonl`, subagent files included. It keeps
  per-file cursors (inode, size, offset) and parses bytes, with a capped
  carry.
- **Recognition and dedup.** A record is recognized when it is
  `type: "assistant"` with finite numeric usage counters and a non-empty
  `message.id`. The dedup key is `message.id` alone, because `requestId` is
  optional. `<synthetic>` records count as recognized with zero tokens.
- **Format-change threshold (PR-11).** Per Claude Code version, recognition
  below 0.9 over at least 20 assistant records, or 0 recognized out of at
  least 5, marks token activity
  `unavailable — transcript format changed in vX.Y.Z`.
- **Transcript root (PR-07, PR-28, C-5).** The root is a read-only
  containment root, separate from the write path allowlist, and is never
  registered in it; a test proves the write allowlist rejects a transcript
  path. `assertTranscriptPath` refuses `..`, NUL, relative paths and symlink
  escapes. A hook-reported `transcript_path` is stored only when that check
  contains it. The open/reveal route resolves the path from the stored Run,
  never from the caller.

## Considered Options

**OpenTelemetry ingest (D-39).** Claude Code can export OTel metrics and
events, which would carry token and cost counters without transcript scanning.

**Rejected.** Receiving OTLP needs a TCP listener, and ADR-0001 removed every
TCP listener so that nothing personal is reachable from a browser or the
network. Reopening that is not worth one data source. OTel stays out of
milestone 1.

**`http` hooks posting directly to the service.** One fewer process per event.

**Rejected.** As ADR-0010 recorded, the `http` hook type's only address field
is `url`, with no Unix-socket form. It cannot reach the service without the
TCP listener rejected above.

**A synchronous `SessionEnd` hook.** Claude Code awaits a synchronous
`SessionEnd` within its exit budget, which would guarantee delivery.

**Rejected** for now (research open question 2). Interactive exit already
awaits `executeSessionEndHooks`, and an async hook's stdin is fully written
before it is backgrounded. The write-ahead spool covers `-p` teardown and any
future change. It stays the fallback: if live UAT shows `Unknown` after a
clean `/exit`, `SessionEnd` alone becomes synchronous.

**A signalled interrupt (`SIGINT` to `CLAUDE_PID`, D-35).** A one-click
interrupt without focusing the terminal.

**Rejected.** In interactive Claude Code 2.1.283, `SIGINT` shuts the session
down (see Session controls). A button labelled "Interrupt" that ends the
owner's session is worse than guided focus.

**An esbuild bundle for the hook (D-07).** One self-contained file.

**Rejected.** `@ccc/collectors` has no esbuild dependency, and adding one buys
nothing: the hook imports only `node:` builtins and relative files, so `tsc -b`
already emits dependency-free ES modules (PR-08, C-6).

**Registering the transcripts root in the write path allowlist (D-34).** One
allowlist for every path check.

**Rejected.** The service's allowlist has no read-only mode. Registering
`<claude-config>/projects` would grant every write route access to the owner's
transcripts (PR-07, C-5).

**`TERM_PROGRAM` or `CLAUDE_CODE_CHILD_SESSION` as the launch-source signal
(D-25).** Environment-only classification inside the hook.

**Rejected.** `CLAUDE_CODE_CHILD_SESSION` is set in every hook command, and
`TERM_PROGRAM` is not reliably inherited. Process ancestry and tty are OS facts
the service can read (PR-03, C-1).

## Consequences

- **Owner-run, reversible.** Session tracking depends on a package the owner
  installs, previews and reverses with repository-relative commands. The
  dashboard shows the status and the command, and never edits Claude settings
  (D-13).
- **Silence is not zero.** Claude Code runs no settings hooks in a folder
  whose workspace trust has not been accepted, nor while `disableAllHooks` is
  set, and it gates the status line on trust too. So silence means "no hook
  events since …", never zero sessions. Health says so, and nothing works
  around it (D-15).
- **Node upgrades.** The absolute Node path recorded at install is fragile
  across Node upgrades. When it disappears, every hook fails to start, and
  Claude Code shows non-blocking hook-failure notices. `status.sh` reports
  `node: missing`, and health reports "hook runtime missing". The fix is to
  re-run the installer (Pitfall 13).
- **Unknown, not guessed.** A Claude Code release that changes an event's
  shape pauses session tracking as `unavailable` rather than guessing. The
  capability table and schemas need updating for such releases.
- **Honest endings.** Sessions that die without reporting show as
  "Unknown — ended without reporting", never as completed.
- **What is stored.** No prompt, reply, tool input or output, or file content
  is stored anywhere, in the store, logs, events or vault (D-49). Paths live
  only in the private operational store, and are redacted in logs.
