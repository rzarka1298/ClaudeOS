# Codex hook package

This optional package lets Claude command center see your interactive Codex
sessions as they start, take turns, stop and end. Without it, Codex sessions
and usage still appear from Codex's own records; the hooks only make the live
state sharper. The design record is the Phase 05.1 decision D-19.

**You run these commands yourself.** The dashboard never installs anything and
never edits your Codex files. Its Settings tab shows the status and the line
to copy. Every command below is repository-relative: run it from the
repository folder.

## Commands

```sh
./scripts/codex-hooks/install.sh [--dry-run]      # add the hook
./scripts/codex-hooks/status.sh                   # read-only report
./scripts/codex-hooks/uninstall.sh [--dry-run]    # undo it exactly
```

All three accept `--codex-home <dir>` (default `$CODEX_HOME`, else
`/Users/USERNAME/.codex`) and `--runtime-dir <dir>` (default
`$CCC_RUNTIME_DIR`, else `/Users/USERNAME/.claude-command-center`). `--dry-run`
prints what would change as a diff and writes nothing. Build the hook first if
the installer says the build output is missing:

```sh
pnpm exec turbo run build --filter=@ccc/collectors
```

## What it changes

Two places, and nothing else:

1. **`<codex-home>/hooks.json`.** The installer adds one handler group for
   each of five events: `SessionStart`, `UserPromptSubmit`, `Stop`,
   `Interrupt` and `SessionEnd`. It adds no per-tool event. Each handler runs
   one quoted shell command: the Node binary that ran the installer, the
   installed hook, and the runtime directory. Four events are asynchronous
   with a 5 second timeout; `SessionEnd` is the one event Codex runs
   synchronously, so it has a 3 second timeout.
2. **`<runtime>/codex-hooks/`.** A private (0700) copy of the compiled hook:
   `codex-hook/` and the two shared modules it imports under `hook/`, plus a
   `package.json` that marks the folder as ES modules. Re-installing replaces
   the whole folder at once.

The file is edited by merging. Your own entries, other keys and key order stay
exactly as they were; our handlers are recognised only by the exact installed
path in their command, so a hook of yours that merely mentions the folder name
is never touched. A new file holds only `description` and `hooks`, because
Codex rejects any other top-level key. Every write is preceded by a
timestamped backup next to the file (`hooks.json.ccc-backup-<time>`, mode
0600), lands atomically, and is refused if the file changed while the
installer ran or is not valid JSON. A symlinked `hooks.json` is followed, so
the link survives. A re-install is byte-identical.

## What it never touches

The installer **never touches Codex's config file, its notify setting or its
hook trust state.** Codex has exactly one notify slot and another program may
already use it; trust hashes belong to Codex. The scripts do not open those
files at all, and the tests prove it with a decoy copy that must stay
byte-identical and with a record of every path the scripts write.

## Trust is your step

Codex runs a new hook only after you trust it. After installing, open Codex,
type `/hooks`, and trust the new hook. Until you do, Codex skips it, and the
dashboard shows the hook as installed with no events yet. Codex also skips
hooks in folders it has not trusted. Sessions that Claude command center
launches through the Antigravity bridge run with hooks off, and `codex exec`
does not dispatch repository hooks; both are followed from Codex's own
records instead.

## Uninstall

`uninstall.sh` removes only the handlers this package added, then deletes the
installed copies. When the result equals a backup it restores that backup's
exact bytes, so an install followed by an uninstall gives back your file byte
for byte. If you edited the file in between, your edits are kept and the file
is written as normalized JSON. If the file held nothing but our entries (the
installer had created it), it is deleted after a backup. If none of our
entries are present, the file is left exactly as it is.

## What the hook does

It keeps a few identifiers from the event (session, folder, model, turn) and
hands them to the companion service over its local Unix socket. It never
forwards prompts, replies, transcript paths or tool input, never writes to
standard output, gives up after 300 ms and always exits 0. When the service is
not running it appends the record to a local spool file that the service
drains on start.
