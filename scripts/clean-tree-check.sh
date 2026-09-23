#!/bin/sh
# Clean-install proof harness (plan 03-01, task 1).
#
# Why this exists: `.planning/phases/02-managed-vault-substrate/deferred-items.md`
# item 2 records a gate that passes locally and fails on a clean clone. The
# plugin package resolves `@ccc/plugin` through `./dist/index.js`, and any
# machine that has ever run `tsc -b` still carries a stale
# `packages/plugin/dist/` -- so the import resolves, eslint-plugin-boundaries
# fires, and the fixture passes for a reason CI does not have. That
# deferred-items entry states the acceptance test in one line: "A local pass
# proves nothing."
#
# This script makes a local pass mean what a clean clone means. It copies the
# working tree MINUS every build output and install artifact into a temp
# directory, runs a frozen-lockfile install there, and runs the given command
# inside that copy. Nothing in the real working tree is touched, and no stale
# dist/, .turbo/ or *.tsbuildinfo can supply an answer the command did not
# earn.
#
# Usage:
#   sh scripts/clean-tree-check.sh '<shell command to run inside the clean copy>'
#
# Example:
#   sh scripts/clean-tree-check.sh 'pnpm run ci:boundaries'
#
# The last line printed is the temp path plus the command's exit status, so a
# run that silently did nothing is distinguishable from a genuine pass.

set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: sh scripts/clean-tree-check.sh '<command>'" >&2
  exit 2
fi

COMMAND="$1"

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

CLEAN_DIR=$(mktemp -d "${TMPDIR:-/tmp}/ccc-clean.XXXXXX")
trap 'rm -rf "$CLEAN_DIR"' EXIT INT TERM

echo "scripts/clean-tree-check.sh: copying $REPO_ROOT -> $CLEAN_DIR (excluding build output)"

# .git is excluded too: the copy is a tree, not a clone, and nothing in the
# checked command needs history. Note the consequence for any command that
# uses `git ls-files` (check-privacy.sh, check-boundaries.sh) -- those are
# verified in the real tree, not here.
rsync -a \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '.turbo' \
  --exclude 'dist' \
  --exclude '*.tsbuildinfo' \
  --exclude 'packages/plugin/main.js' \
  --exclude 'packages/plugin/styles.css' \
  "$REPO_ROOT/" "$CLEAN_DIR/"

echo "scripts/clean-tree-check.sh: installing (pnpm install --frozen-lockfile)"
( cd "$CLEAN_DIR" && pnpm install --frozen-lockfile )

echo "scripts/clean-tree-check.sh: running: $COMMAND"
STATUS=0
( cd "$CLEAN_DIR" && sh -c "$COMMAND" ) || STATUS=$?

echo "scripts/clean-tree-check.sh: clean tree $CLEAN_DIR, command exited ${STATUS}."
exit "$STATUS"
