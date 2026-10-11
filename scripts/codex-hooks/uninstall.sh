#!/bin/sh
# Owner-run uninstaller for the Codex hook package (plan 05.1-24, CODEX-06).
# A thin POSIX shim: every behaviour lives in uninstall.mjs.
exec node "$(dirname "$0")/uninstall.mjs" "$@"
