#!/bin/sh
# Read-only status report for the Claude Code hook package (plan 05-09, PR-22).
# A thin POSIX shim: every behaviour lives in status.mjs.
exec node "$(dirname "$0")/status.mjs" "$@"
