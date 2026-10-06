# Claude Code hook package

This optional package lets Claude command center see your Claude Code sessions.
With it, the dashboard shows which sessions are running, waiting for approval,
or ended without reporting. With the opt-in status-line wrapper, it also shows
your plan usage. The design record is
`docs/adr/0025-claude-event-normalization-and-capability-detection.md`.

**You run these commands yourself.** The dashboard never installs anything
and never edits your Claude settings. Its Settings tab shows the status and
the command to copy. Every command below is repository-relative: run it from
the repository folder.

## What it does, and what it never does

The installer adds one hook entry per event to
`<claude-config>/settings.json`, where `<claude-config>` is
`$CLAUDE_CONFIG_DIR` or `/Users/USERNAME/.claude`. Each entry runs a small
Node program, copied to
`/Users/USERNAME/.claude-command-center/hooks/hook/entry.js`. That program
keeps a few identifiers from the event and hands them to the companion
service over its local Unix socket. When the service is not running, it
appends them to a local spool file instead, which the service drains when it
starts.

The hook:

- **never blocks or slows a session.** It is registered with
  `"async": true`, so Claude Code does not wait for it. It gives up after
  300 ms and always exits 0.
- **never writes to stdout,** so nothing it does reaches Claude's context.
- **never forwards prompts, replies, tool input or output, or file
  contents.** Each record is capped at 4 KiB.

It subscribes to these 15 events:

`SessionStart`, `SessionEnd`, `Stop`, `StopFailure`, `Notification`,
`SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`,
`UserPromptSubmit`, `PermissionRequest`, `PermissionDenied`,
`PostModelSwitch`, `PostToolUse`, `PostToolUseFailure`.

### Fields that are forwarded

| Event | Fields kept |
|-------|-------------|
| every event | `session_id`, `cwd`, `transcript_path`, `permission_mode`, `effort.level`, and `agent_id` and `agent_type` inside a subagent |
| `SessionStart` | also `source`, `model`, `session_title` |
| `SessionEnd` | also `reason` |
| `StopFailure` | also `error`, and only as one of Claude Code's documented error types |
| `Notification` | also `notification_type` |
| `PermissionRequest`, `PermissionDenied`, `PostToolUse` | also `tool_name` |
| `PostToolUseFailure` | also `tool_name`, `is_interrupt` |
| `PostModelSwitch` | also `from_model`, `to_model`, `source` |

It reads only these environment variables: `CLAUDE_PID`, `TERM_PROGRAM`,
`CLAUDE_CODE_CHILD_SESSION`, `CCC_RUN_ID` and `CCC_LAUNCH_SOURCE`.

### Fields that are always dropped

`tool_input`, `tool_response`, every prompt (`UserPromptSubmit.prompt`),
`last_assistant_message`, `Notification.message` and `title`, task subjects
and descriptions, the tool-failure `error` (it carries the tool's output),
`error_details`, `permission_suggestions`, `background_tasks`,
`session_crons`, `prompt_id` and `scratchpad_dir`. Every other environment
variable is dropped too.

## Commands

Preview the change first. This prints a diff and writes nothing:

```sh
./scripts/claude-hooks/install.sh --dry-run
```

Install:

```sh
./scripts/claude-hooks/install.sh
```

Check the result at any time. This is read-only:

```sh
./scripts/claude-hooks/status.sh
```

Undo everything:

```sh
./scripts/claude-hooks/uninstall.sh
```

### What install does

- **Refuses and changes nothing** if `settings.json` is not valid JSON, if
  Node is older than 24, or if Claude Code is older than 2.1.214. When
  `claude` is not found, it warns and continues with the version unknown.
  `--claude-bin <path>` names the binary explicitly.
- **Leaves everything else alone.** Your other hooks, your status line and
  every other setting keep their values. The installer recognizes its own
  entries only by their path into `.claude-command-center/hooks/`.
- **Backs up, then writes safely.** It saves the previous file as
  `settings.json.ccc-backup-<timestamp>` (mode `0600`), then replaces it
  atomically.
- **Is safe to repeat.** Running it again produces an identical file.
- **Records what it installed** in
  `/Users/USERNAME/.claude-command-center/hooks/install.json`. The service
  reads that file for the Node path and the version check.

### What uninstall does

- Removes only this package's entries, and restores your original status
  line if the wrapper is installed.
- Deletes the copied files.
- Restores your file byte for byte when nothing else changed since install.
  Any edits you made after installing are kept.

### What status reports

- how many events are installed;
- whether the recorded Node still exists;
- whether the installed copies match the current build;
- the Claude Code version, and whether it is supported;
- `disableAllHooks`;
- whether the status-line wrapper is installed;
- the local spool: bytes waiting for the service, and records dropped at its
  1 MiB cap.

## The status-line wrapper (opt-in)

Plan usage (the 5-hour and 7-day limits) is only available through Claude
Code's status line. To forward it, install with:

```sh
./scripts/claude-hooks/install.sh --with-statusline
```

This only wraps a status line **you already have**. If you have none, the
installer refuses and changes nothing. With a custom status line, Claude Code
hides most of its footer hints, including "esc to interrupt", so the installer
never adds one for you.

**How it works.** Your current `statusLine` object is saved to
`/Users/USERNAME/.claude-command-center/statusline/original.json` (mode
`0600`). Only its `command` changes, to run the wrapper. The wrapper runs your
original command with the same input, and prints its output unchanged. It also
forwards the session id and name, the model, the Claude Code version, Claude
Code's own cost estimate and the two rate-limit windows. It never forwards
repository, pull-request or worktree names.

**Undoing it.** Uninstall restores your original `statusLine` exactly,
`padding` and `refreshInterval` included. Without the wrapper, plan usage
reads "Account capacity unavailable".

## Things to know

- **Workspace trust.** Claude Code runs no settings hooks in a folder until
  you accept its workspace trust prompt, and it holds back the status line
  there too. A quiet dashboard for an untrusted folder is expected. The
  dashboard says "no hook events since …" and never reads that as zero
  sessions.
- **`disableAllHooks`.** While `disableAllHooks` is `true` in your Claude
  settings, no hook runs at all. `status.sh` shows the value. Nothing here
  works around it.
- **The recorded Node path.** The installer records the absolute path of the
  `node` that ran it, for example
  `/Users/USERNAME/.nvm/versions/node/v24.20.0/bin/node`. If you later remove
  that Node version, every hook fails to start, and Claude Code shows
  non-blocking hook-error notices. `status.sh` then reports `node: missing`.
  Re-run `./scripts/claude-hooks/install.sh` with the new Node on your `PATH`.
- **After updating the repository,** re-run install so the copied files match
  the build. `status.sh` reports `installed files: stale — re-run install`
  until you do. Build first if needed:
  `pnpm exec turbo run build --filter=@ccc/collectors --filter=@ccc/vault-repo`.
- **Minimum Claude Code version: 2.1.214.** If a newer Claude Code changes
  its hook format, session tracking pauses as unavailable rather than
  guessing.

## Flags

| Flag | Meaning |
|------|---------|
| `--dry-run` | Print the change and write nothing (install and uninstall). |
| `--with-statusline` | Also wrap your existing status line (install only). |
| `--claude-config-dir <dir>` | Claude's config directory. Default: `$CLAUDE_CONFIG_DIR`, else `/Users/USERNAME/.claude`. |
| `--runtime-dir <dir>` | Where the hook copies live and where the hook finds the service. Default: `$CCC_RUNTIME_DIR`, else `/Users/USERNAME/.claude-command-center`. |
| `--claude-bin <path>` | The `claude` binary to version-check. Default: `claude` on `PATH`. |

**Testing a branch in isolation.** `--runtime-dir` points the hooks at a
branch build's own service. For example, run that service with
`CCC_RUNTIME_DIR=/Users/USERNAME/.ccc-uat`, then install with
`--runtime-dir /Users/USERNAME/.ccc-uat`. The branch then never touches your
real operational store (PR-29). Uninstall with the same `--runtime-dir`.
