#!/bin/sh
# Owner-run installer for the Claude Code hook package (plan 05-09, PR-22).
# A thin POSIX shim: every behaviour lives in install.mjs.
exec node "$(dirname "$0")/install.mjs" "$@"
