#!/bin/sh
# Read-only status report for the Codex hook package (plan 05.1-24, CODEX-06).
# A thin POSIX shim: every behaviour lives in status.mjs.
exec node "$(dirname "$0")/status.mjs" "$@"
